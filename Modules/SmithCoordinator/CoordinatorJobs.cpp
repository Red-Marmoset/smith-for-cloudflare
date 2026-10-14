// CoordinatorJobs.cpp - build queue + job lifecycle: enqueue, dispatch (long-poll),
// log/status/result ingestion, cancel/rerun, artifacts and diagnostics.
// Split from Coordinator.cpp (800-line standard); pure moves, no behavior change.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Coordinator.h"
#include "CoordinatorUtil.h"

#include <SmithCore/NodeMatcher.h>
#include <SmithCore/Strings.h>
#include <SmithCore/Process.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithCore/GitUrl.h>
#include <SmithCore/Inputs.h>
#include <SmithCore/BuildDiagnostics.h>
#include <SmithCore/BuildDiagnosticsJson.h>
#include <SmithCore/RetryPolicy.h>
#include <SmithProtocol/WireJson.h>
#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <thread>
#include <chrono>
#include <filesystem>

using nlohmann::json;
namespace fs = std::filesystem;

namespace Smith
{
    static std::string Subst(std::string s, const std::map<std::string, std::string>& vars)
    {
        for (const auto& kv : vars)
        {
            std::string token = "${" + kv.first + "}";
            size_t pos = 0;
            while ((pos = s.find(token, pos)) != std::string::npos)
            {
                s.replace(pos, token.size(), kv.second);
                pos += kv.second.size();
            }
        }
        return s;
    }

    static const BuildRuleDef* FindRuleByName(const BuildProductDef& product, const std::string& name)
    {
        for (const auto& r : product.rules) if (r.name == name) return &r;
        return nullptr;
    }

    // The commit-driven triggers. A build queued by any of these means the same thing -
    // "build the tip of this branch" - so two of them for one target are the same intent
    // at different commits, and only the newest commit is worth building. Manual, rerun,
    // retry and batch builds are deliberate one-offs and are never collapsed.
    static bool IsAutoCommitTrigger(const std::string& reason)
    {
        return reason == "autobuild" || reason == "poll" || reason == "webhook";
    }

    std::string Coordinator::EnqueueBuild(const std::string& projectId, const std::string& product,
                                          const std::string& branch, const std::string& commit,
                                          const std::string& reason, const std::string& profile,
                                          const std::string& targetOs, bool clean)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        return EnqueueBuildLocked(projectId, product, branch, commit, reason, profile, targetOs, clean);
    }

    std::string Coordinator::EnqueueBuildLocked(const std::string& projectId, const std::string& product,
                                                const std::string& branch, const std::string& commit,
                                                const std::string& reason, const std::string& profile,
                                                const std::string& targetOs, bool clean)
    {
        const ProjectDef* proj = FindProject(projectId);
        if (!proj) return "";

        std::string useBranch = branch;
        if (useBranch.empty())
        {
            for (const auto& r : proj->repos) if (r.primary) { useBranch = r.defaultBranch; break; }
        }
        const BuildProductDef* prod = FindProductForBranch(*proj, product, useBranch);
        if (!prod) return "";
        const BuildRuleDef* rule = FindRule(*prod, useBranch);
        if (!rule) return "";

        // A commit-driven trigger that fires again before the previous one has started
        // makes the earlier queued build pointless - only the newest commit is worth
        // building. Collapse the backlog so a burst of commits leaves a single queued
        // build (and, when configured, abort the in-flight one too).
        if (IsAutoCommitTrigger(reason))
            SupersedeStaleAutoBuildsLocked(projectId, product, useBranch, profile, targetOs);

        BuildRecord rec;
        rec.jobId = MakeUuid();
        rec.projectId = projectId;
        rec.product = product;
        rec.variant = profile;
        rec.targetOs = targetOs;
        rec.rule = rule->name;
        rec.buildNumber = m_store.NextBuildNumber(projectId);
        rec.branch = useBranch;
        rec.commit = commit;
        rec.reason = reason.empty() ? "manual" : reason;
        rec.clean = clean;
        rec.status = "queued";
        rec.phase = "queued";
        rec.createdAt = NowMillis();

        m_store.SaveRecord(rec);
        m_builds[rec.jobId] = rec;
        m_queue.push_back(rec.jobId);
        EmitBuildEvent("queued", rec);
        LOG_INFO("Smith", "Queued build %s #%d (%s/%s @ %s)", rec.jobId.c_str(), rec.buildNumber,
                 projectId.c_str(), product.c_str(), useBranch.c_str());
        return rec.jobId;
    }

    void Coordinator::SupersedeStaleAutoBuildsLocked(const std::string& projectId, const std::string& product,
                                                     const std::string& branch, const std::string& profile,
                                                     const std::string& targetOs)
    {
        // Same target = same product, branch, variant and platform pin, queued by a
        // commit-driven trigger. A batch member is excluded: its commit is pinned by the
        // chain it belongs to and its siblings/follow-up depend on it.
        auto sameTarget = [&](const BuildRecord& r) {
            return IsAutoCommitTrigger(r.reason) && r.batchId.empty() &&
                   r.projectId == projectId && r.product == product && r.branch == branch &&
                   r.variant == profile && r.targetOs == targetOs;
        };

        // Copy the jobIds first: superseding mutates m_queue, so don't erase mid-iteration.
        std::vector<std::string> stale;
        for (const std::string& jobId : m_queue)
        {
            auto it = m_builds.find(jobId);
            if (it == m_builds.end()) continue;
            if (it->second.status == "queued" && sameTarget(it->second)) stale.push_back(jobId);
        }

        for (const std::string& jobId : stale)
        {
            m_queue.erase(std::remove(m_queue.begin(), m_queue.end(), jobId), m_queue.end());
            BuildRecord& r = m_builds[jobId];
            r.status = "superseded";
            r.phase = "done";
            r.finishedAt = NowMillis();
            m_store.SaveRecord(r);
            LOG_INFO("Smith", "Superseded queued build %s #%d (%s/%s @ %s) - newer commit",
                     r.jobId.c_str(), r.buildNumber, projectId.c_str(), product.c_str(), branch.c_str());
            EmitBuildEvent("superseded", r);
            OnJobTerminalLocked(jobId);
        }

        if (!m_cfg.cancelRunningOnNewCommit) return;

        // Opt-in (--cancel-running-on-new-commit): the build already on an agent is
        // building a commit we have just replaced, so abort it as well and let the newest
        // commit start now. The agent learns of the cancel from its next log-post
        // response and reports back "cancelled"; HandleResult rewrites that to
        // "superseded" so the record reads as Smith's doing, not a person's.
        for (auto& kv : m_builds)
        {
            BuildRecord& r = kv.second;
            if (r.status != "running" || !sameTarget(r)) continue;
            if (!m_cancelRequested.insert(r.jobId).second) continue;   // already cancelling
            m_supersededRunning.insert(r.jobId);
            LOG_INFO("Smith", "Cancelling running build %s #%d (%s/%s @ %s) - newer commit superseded it",
                     r.jobId.c_str(), r.buildNumber, projectId.c_str(), product.c_str(), branch.c_str());
        }
    }

    // True if 'url' is a local filesystem path that a node running 'nodeOs' can't
    // reach: a Windows drive path (C:\...) on a non-Windows node, or a POSIX
    // absolute path on a Windows node. Such overrides are local-dogfood only.
    static bool IsForeignLocalPath(const std::string& url, const std::string& nodeOs)
    {
        bool winDrive = url.size() >= 2 &&
                        ((url[0] >= 'A' && url[0] <= 'Z') || (url[0] >= 'a' && url[0] <= 'z')) &&
                        url[1] == ':';
        bool posixAbs = !url.empty() && url[0] == '/';
        if (winDrive && nodeOs != "windows") return true;
        if (posixAbs && nodeOs == "windows") return true;
        return false;
    }

    bool Coordinator::ResolveJobSpec(const BuildRecord& rec, const NodeInfo& node, JobSpec& out) const
    {
        const ProjectDef* proj = FindProject(rec.projectId);
        if (!proj) return false;
        const BuildProductDef* prod = FindProductForBranch(*proj, rec.product, rec.branch);
        if (!prod) return false;
        const BuildRuleDef* rule = FindRuleByName(*prod, rec.rule);
        if (!rule) return false;

        auto cmdIt = rule->commandByOs.find(node.os);
        auto stepsIt = rule->stepsByOs.find(node.os);
        if (cmdIt == rule->commandByOs.end() && stepsIt == rule->stepsByOs.end()) return false;

        std::map<std::string, std::string> vars = {
            {"BUILD_NUMBER", std::to_string(rec.buildNumber)},
            {"BRANCH", rec.branch},
            {"COMMIT", rec.commit},
            {"COMMIT_SHORT", rec.commit.substr(0, std::min<size_t>(7, rec.commit.size()))},
            {"PROJECT_ID", rec.projectId},
        };
        if (!rec.variant.empty())
        {
            vars[prod->discover.as] = rec.variant;
            vars[prod->discover.as + "_SLUG"] = SlugifyName(rec.variant);
        }
        vars["OUTPUT"] = prod->outputPath.empty() ? std::string() : Subst(prod->outputPath, vars);

        out = JobSpec();
        out.jobId = rec.jobId;
        out.projectId = rec.projectId;
        out.buildNumber = rec.buildNumber;

        for (const auto& repo : proj->repos)
        {
            RepoCheckout rc;
            rc.name = repo.name;
            rc.url = repo.url;
            auto ov = m_cfg.repoOverrides.find(rec.projectId + "/" + repo.name);
            // A repo-override pointing at a local filesystem path (e.g. a Windows
            // C:\... checkout used for local dogfooding) only works for an agent on
            // the coordinator's own machine. If it's a Windows path being sent to a
            // non-Windows node (or a POSIX path to a Windows node) it can't be
            // cloned there - fall back to the canonical smith.json URL so remote
            // nodes still build. (The local agent keeps using the override.)
            if (ov != m_cfg.repoOverrides.end() && !IsForeignLocalPath(ov->second, node.os))
                rc.url = ov->second;
            rc.branch = repo.primary && !rec.branch.empty() ? rec.branch : repo.defaultBranch;
            rc.commit = repo.primary ? rec.commit : "";
            rc.checkoutDir = repo.checkoutDir;
            // Managed GitHub token: hand the agent an HTTPS URL + the token (as a
            // RepoCheckout secret -> git http.extraheader) so it can clone private
            // repos without a per-host SSH key. The token never goes in the URL.
            if (!m_cfg.githubToken.empty() && IsGitHubUrl(rc.url))
            {
                rc.url = ToHttpsGitHubUrl(rc.url);
                rc.authToken = m_cfg.githubToken;
            }
            out.repos.push_back(rc);
        }

        if (stepsIt != rule->stepsByOs.end())
        {
            // Multi-step rule: resolve each step (with variable substitution) in order.
            for (const auto& step : stepsIt->second)
            {
                CommandSpec cs;
                cs.interpreter = step.interpreter;
                cs.script = step.script;
                for (const auto& a : step.args) cs.args.push_back(Subst(a, vars));
                out.steps.push_back(cs);
            }
            if (!out.steps.empty()) out.command = out.steps.front();   // back-compat for readers of .command
        }
        else
        {
            out.command.interpreter = cmdIt->second.interpreter;
            out.command.script = cmdIt->second.script;
            for (const auto& a : cmdIt->second.args) out.command.args.push_back(Subst(a, vars));
        }
        out.workingDir = rule->workingDir;

        // Coordinator-wide env first, so a rule's own env still wins over it.
        //
        // This used to be applied ONLY in StartEmbeddedAgent, which meant the config's
        // "env" object reached the co-located agent and no other. A remote agent - the
        // usual case for anything platform-specific, e.g. a mac node doing iOS work -
        // silently never saw it, and the only symptom was a build behaving as though the
        // variable had never been set at all. Sending it with the job covers every agent,
        // remote included, and keeps one place to configure it.
        out.env = m_cfg.agentBuildEnv;
        for (const auto& kv : rule->env) out.env[kv.first] = kv.second;
        for (auto& kv : out.env) kv.second = Subst(kv.second, vars);
        out.env["SMITH_BUILD_NUMBER"] = std::to_string(rec.buildNumber);
        out.env["SMITH_BRANCH"] = rec.branch;
        out.env["SMITH_COMMIT"] = rec.commit;
        out.env["SMITH_PROJECT"] = rec.projectId;

        out.timeoutSeconds = rule->timeoutSeconds;
        out.successExitCodes = rule->successExitCodes;
        out.artifacts = rule->artifacts;
        // Robust default: a product that declares an output dir (outputPath -> ${OUTPUT})
        // but no explicit artifact globs ships its WHOLE output folder as one zip. So
        // "outputPath" alone collects the entire build (e.g. a Unity player + its _Data) -
        // there's no per-profile glob to forget or get wrong.
        if (out.artifacts.globs.empty() && !prod->outputPath.empty())
        {
            out.artifacts.globs = { "${OUTPUT}/**" };
            out.artifacts.package = "zip";
            if (out.artifacts.archiveName.empty())
            {
                std::string an = prod->name;
                if (!rec.variant.empty() && !prod->discover.as.empty()) an = "${" + prod->discover.as + "_SLUG}";
                out.artifacts.archiveName = an + ".zip";
            }
        }
        for (auto& g : out.artifacts.globs) g = Subst(g, vars);
        out.artifacts.archiveName = Subst(out.artifacts.archiveName, vars);
        out.handoff = rule->handoff;
        out.clean = rec.clean;
        return true;
    }

    void Coordinator::HandleJobsNext(const Http::Request& req, Http::Response& res)
    {
        std::string nodeId = req.Param("nodeId");
        int64_t deadline = NowMillis() + m_cfg.jobWaitMs;

        // Long-poll: hold the connection until a matching job appears or the
        // deadline elapses. The lock is only held during each scan, not the sleep.
        for (;;)
        {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                auto nodeIt = m_nodes.find(nodeId);
                if (nodeIt == m_nodes.end()) { res.Set(404, "unknown node"); return; }
                nodeIt->second.lastSeenMs = NowMillis();

                for (size_t i = 0; i < m_queue.size(); ++i)
                {
                    auto bit = m_builds.find(m_queue[i]);
                    if (bit == m_builds.end()) continue;
                    BuildRecord& rec = bit->second;

                    const ProjectDef* proj = FindProject(rec.projectId);
                    if (!proj) continue;
                    const BuildProductDef* prod = FindProductForBranch(*proj, rec.product, rec.branch);
                    if (!prod) continue;
                    const BuildRuleDef* rule = FindRuleByName(*prod, rec.rule);
                    if (!rule) continue;
                    NodeSelector sel = rule->nodeSelector;
                    if (!rec.variant.empty())
                        for (const auto& v : prod->variants)
                            if (v.name == rec.variant)
                            {
                                if (!v.os.empty() && v.os != "any") sel.os = v.os;
                                for (const auto& l : v.labels) sel.labels.push_back(l);
                                if (!v.preferOs.empty()) sel.preferOs = v.preferOs;
                                break;
                            }
                    // An explicit build target (windows/mac/linux) pins the OS, so the job
                    // runs natively on a node of that platform (commandByOs[os] handles the rest).
                    if (!rec.targetOs.empty() && rec.targetOs != "any") sel.os = rec.targetOs;
                    if (!NodeMatches(sel, nodeIt->second.info)) continue;
                    // A retry must not land back on the node its previous attempt failed
                    // on (set when the failure looked node/environment-specific).
                    if (!rec.avoidNodeName.empty() && rec.avoidNodeName == nodeIt->second.info.hostname) continue;

                    // Soft OS affinity: for an os:"any" job carrying preferOs, let a
                    // native-OS agent claim it first - but only within a grace window
                    // and only while such an agent is actually online (else don't stall
                    // the build waiting for a node that isn't there). A hard os pin or
                    // explicit target makes this moot.
                    if ((sel.os.empty() || Lower(sel.os) == "any") && !sel.preferOs.empty())
                    {
                        int64_t now = NowMillis();
                        bool preferredOnline = false;
                        for (const auto& kv : m_nodes)
                            if (Lower(kv.second.info.os) == Lower(sel.preferOs) && NodeOnlineLocked(kv.second, now))
                            { preferredOnline = true; break; }
                        if (ShouldDeferForAffinity(sel.preferOs, nodeIt->second.info.os,
                                                   now - rec.createdAt,
                                                   (int64_t)m_cfg.preferOsGraceSec * 1000, preferredOnline))
                            continue;
                    }

                    JobSpec spec;
                    if (!ResolveJobSpec(rec, nodeIt->second.info, spec)) continue;

                    // Artifact inputs (fan-in): resolve each declared input to the
                    // latest successful build's artifacts. If one can't be satisfied
                    // the job fails NOW with a clear message - dispatching it (or
                    // leaving it queued forever) helps nobody.
                    if (!rule->inputs.empty())
                    {
                        std::vector<const BuildRecord*> history;
                        history.reserve(m_builds.size());
                        for (const auto& kv : m_builds) history.push_back(&kv.second);
                        std::string inputError;

                        // A chain/batch deploy draws its inputs from the builds of
                        // its OWN run (same commit), falling back to latest-success
                        // only for a variant the chain didn't build. A standalone
                        // deploy keeps the plain latest-success-on-branch behavior.
                        bool resolved;
                        std::vector<const BuildRecord*> runBuilds;
                        if (!rec.batchId.empty())
                        {
                            auto bIt = m_batches.find(rec.batchId);
                            if (bIt != m_batches.end())
                                for (const auto& jr : bIt->second.builds)
                                {
                                    auto rIt = m_builds.find(jr.jobId);
                                    if (rIt != m_builds.end()) runBuilds.push_back(&rIt->second);
                                }
                        }
                        if (!runBuilds.empty())
                            resolved = ResolveArtifactInputsFromBatch(rule->inputs, runBuilds, history,
                                                                      rec.projectId, rec.branch, spec.inputs, inputError);
                        else
                            resolved = ResolveArtifactInputs(rule->inputs, history, rec.projectId,
                                                             rec.branch, spec.inputs, inputError);
                        if (!resolved)
                        {
                            m_queue.erase(m_queue.begin() + i);
                            rec.status = "error";
                            rec.phase = "done";
                            rec.finishedAt = NowMillis();
                            m_store.AppendLog(rec, "INPUTS: " + inputError + "\n");
                            m_store.SaveRecord(rec);
                            LOG_INFO("Smith", "Build %s #%d failed: %s", rec.jobId.c_str(),
                                     rec.buildNumber, inputError.c_str());
                            EmitBuildEvent("error", rec);
                            OnJobTerminalLocked(rec.jobId);
                            --i;   // unsigned wrap at 0 is fine: ++i re-enters at 0
                            continue;
                        }
                    }

                    m_queue.erase(m_queue.begin() + i);
                    rec.status = "running";
                    rec.phase = "checkout";
                    rec.nodeId = nodeId;
                    rec.nodeName = nodeIt->second.info.hostname;
                    rec.startedAt = NowMillis();
                    m_store.SaveRecord(rec);
                    nodeIt->second.status = "busy";
                    nodeIt->second.currentJobId = rec.jobId;
                    EmitBuildEvent("running", rec);   // build started on an agent -> SSE subscribers

                    JobAssignment asn;
                    asn.hasJob = true;
                    asn.jobId = rec.jobId;
                    asn.spec = spec;
                    res.Json(ToJson(asn));
                    return;
                }
            }
            if (NowMillis() >= deadline) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
        }

        JobAssignment none;
        none.hasJob = false;
        res.Json(ToJson(none));
    }

    void Coordinator::HandleLog(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        LogChunk chunk;
        if (!FromJson(req.body, chunk)) { res.Set(400, "bad request"); return; }

        BuildRecord rec;
        if (!GetBuildCopy(jobId, rec)) { res.Set(404, "unknown build"); return; }

        std::string text;
        for (const auto& line : chunk.lines) text += line + "\n";
        m_store.AppendLog(rec, text);

        // If a cancel was requested for this job, tell the agent via the response.
        bool cancel;
        { std::lock_guard<std::mutex> lock(m_mutex); cancel = m_cancelRequested.count(jobId) != 0; }
        if (cancel) { res.Json("{\"cancel\":true}"); return; }
        res.Set(204, "");
    }

    void Coordinator::HandleStatus(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        json j;
        bool parsed = ParseBody(req, j);
        std::string phase = parsed ? j.value("phase", std::string()) : std::string();
        std::string commit = parsed ? j.value("commit", std::string()) : std::string();

        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_builds.find(jobId);
        if (it == m_builds.end()) { res.Set(404, "unknown build"); return; }
        if (!phase.empty()) it->second.phase = phase;
        // The agent reports the sha it checked out. Only fill a build of the branch tip -
        // a pinned commit is authoritative and never overwritten.
        if (!commit.empty() && it->second.commit.empty()) it->second.commit = commit;
        m_store.SaveRecord(it->second);
        res.Set(204, "");
    }

    void Coordinator::HandleResult(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        JobResult result;
        if (!FromJson(req.body, result)) { res.Set(400, "bad request"); return; }

        BuildRecord finished;
        bool retryCandidate = false;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_builds.find(jobId);
            if (it == m_builds.end()) { res.Set(404, "unknown build"); return; }
            BuildRecord& rec = it->second;
            // Already settled as "lost" (its node was reaped during a long network drop)
            // but the agent survived: keep the real result, but its batch has already
            // been advanced, so don't advance or retry it a second time.
            const bool wasLost = rec.status == "lost";
            rec.status = result.status.empty() ? "error" : result.status;
            rec.exitCode = result.exitCode;
            rec.durationMs = result.durationMs;
            rec.finishedAt = NowMillis();
            rec.phase = "done";
            // A build we aborted because a newer commit arrived comes back "cancelled";
            // record it as "superseded" instead - nobody cancelled it by hand. (If it beat
            // the signal and finished, its real result stands.)
            if (m_supersededRunning.erase(jobId) > 0 && rec.status == "cancelled") rec.status = "superseded";
            m_store.SaveRecord(rec);
            m_cancelRequested.erase(jobId);

            for (auto& nkv : m_nodes)
            {
                if (nkv.second.currentJobId == jobId)
                {
                    nkv.second.status = "idle";
                    nkv.second.currentJobId.clear();
                }
            }
            LOG_INFO("Smith", "Build %s finished: %s (exit %d)", jobId.c_str(), rec.status.c_str(), rec.exitCode);
            finished = rec;   // copy under the lock for the async work below
            EmitBuildEvent(finished.status, finished);   // success | failed | error -> SSE subscribers (Discord bot)
            if (!wasLost) OnJobTerminalLocked(jobId);    // advance any batch this job belongs to

            // A standalone build that failed for a node/environment reason is worth one
            // retry on a different node. Decide the rest OFF the lock (it reads + parses
            // the log). Chain/batch builds are settled by their own logic; skip them.
            retryCandidate = !wasLost && finished.batchId.empty() && finished.attempt < 2
                          && (finished.status == "failed" || finished.status == "error" || finished.status == "lost");
        }
        res.Set(204, "");

        // Fire-and-forget the notify-command off the handler thread + lock (it may
        // run curl/network). No-op when --notify-command is unset.
        if (!m_cfg.notifyCommand.empty())
            std::thread([this, finished]() { NotifyBuildFinished(finished); }).detach();

        if (retryCandidate) MaybeRetryOnAnotherNode(finished);
    }

    // Re-dispatch a node/environment failure once to a different capable node. Classify
    // OFF the lock (reading + parsing the console log is slow), then take m_mutex to enqueue.
    void Coordinator::MaybeRetryOnAnotherNode(const BuildRecord& finished)
    {
        BuildDiagnostics diag;
        if (finished.status == "failed")   // "error"/"lost" classify without reading the log
        {
            std::string log;
            m_store.ReadLog(finished, log);
            diag = ParseBuildDiagnostics(log);
        }
        if (!IsRetryableFailure(finished.status, diag)) return;   // code error / not retryable

        std::lock_guard<std::mutex> lock(m_mutex);
        const char* who = finished.nodeName.empty() ? "?" : finished.nodeName.c_str();
        if (!HasOtherCapableNodeLocked(finished, finished.nodeName))
        {
            LOG_INFO("Smith", "Build %s #%d failed on %s (retryable) but no other capable node is online - not retrying",
                     finished.jobId.c_str(), finished.buildNumber, who);
            return;
        }
        std::string rid = EnqueueRetryLocked(finished, finished.nodeName);
        if (!rid.empty())
            LOG_INFO("Smith", "Build %s #%d failed on %s (%s, retryable) - retrying once on another node (%s)",
                     finished.jobId.c_str(), finished.buildNumber, who, finished.status.c_str(), rid.c_str());
    }

    // Queue a retry of 'orig' that avoids the host its previous attempt failed on,
    // carrying the same project/product/branch/commit/variant. Caller holds m_mutex.
    std::string Coordinator::EnqueueRetryLocked(const BuildRecord& orig, const std::string& avoidHost)
    {
        std::string newId = EnqueueBuildLocked(orig.projectId, orig.product, orig.branch, orig.commit,
                                               "retry", orig.variant, orig.targetOs, orig.clean);
        if (newId.empty()) return "";
        auto it = m_builds.find(newId);
        if (it != m_builds.end())
        {
            it->second.attempt = orig.attempt + 1;
            it->second.avoidNodeName = avoidHost;
            it->second.retryOfJobId = orig.jobId;
            m_store.SaveRecord(it->second);
        }
        return newId;
    }

    // True if some ONLINE node other than 'avoidHost' can run this build (matches the
    // rule + variant selector). Caller holds m_mutex.
    bool Coordinator::HasOtherCapableNodeLocked(const BuildRecord& rec, const std::string& avoidHost) const
    {
        const ProjectDef* proj = FindProject(rec.projectId);
        if (!proj) return false;
        const BuildProductDef* prod = FindProductForBranch(*proj, rec.product, rec.branch);
        if (!prod) return false;
        const BuildRuleDef* rule = FindRuleByName(*prod, rec.rule);
        if (!rule) return false;
        NodeSelector sel = rule->nodeSelector;
        if (!rec.variant.empty())
            for (const auto& v : prod->variants)
                if (v.name == rec.variant)
                {
                    if (!v.os.empty() && v.os != "any") sel.os = v.os;
                    for (const auto& l : v.labels) sel.labels.push_back(l);
                    break;
                }
        if (!rec.targetOs.empty() && rec.targetOs != "any") sel.os = rec.targetOs;
        int64_t now = NowMillis();
        for (const auto& kv : m_nodes)
        {
            const NodeRuntime& n = kv.second;
            if (n.info.hostname == avoidHost) continue;
            if (!NodeOnlineLocked(n, now)) continue;
            if (NodeMatches(sel, n.info)) return true;
        }
        return false;
    }

    void Coordinator::NotifyBuildFinished(const BuildRecord& rec) const
    {
        if (m_cfg.notifyCommand.empty()) return;
        bool failed = (rec.status == "failed" || rec.status == "error" || rec.status == "lost");
        if (m_cfg.notifyOn != "all" && !failed) return;

        ProcessOptions o;
        // Run via the platform shell so the user can pass a full command line.
        if (DetectOs() == "windows") o.argv = { "cmd", "/c", m_cfg.notifyCommand };
        else                         o.argv = { "/bin/sh", "-c", m_cfg.notifyCommand };
        o.envOverride = {
            { "SMITH_STATUS", rec.status },
            { "SMITH_PROJECT", rec.projectId },
            { "SMITH_PRODUCT", rec.product },
            { "SMITH_VARIANT", rec.variant },
            { "SMITH_BUILD_NUMBER", std::to_string(rec.buildNumber) },
            { "SMITH_BRANCH", rec.branch },
            { "SMITH_COMMIT", rec.commit },
            { "SMITH_JOB_ID", rec.jobId },
            { "SMITH_NODE", rec.nodeName.empty() ? rec.nodeId : rec.nodeName },
            { "SMITH_EXIT_CODE", std::to_string(rec.exitCode) },
            { "SMITH_FAILED", failed ? "1" : "0" },
        };
        o.timeoutSeconds = 30;
        Process p;
        int rc = p.Run(o, nullptr);
        if (rc != 0) LOG_WARNING("Smith", "notify-command exited %d", rc);
    }

    void Coordinator::HandleArtifactUpload(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        std::string name = req.Param("name");
        if (name.empty()) { res.Set(400, "missing artifact name"); return; }

        BuildRecord rec;
        if (!GetBuildCopy(jobId, rec)) { res.Set(404, "unknown build"); return; }
        if (!m_store.SaveArtifact(rec, name, req.body)) { res.Set(500, "save failed"); return; }

        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_builds.find(jobId);
            if (it != m_builds.end())
            {
                if (std::find(it->second.artifacts.begin(), it->second.artifacts.end(), name) == it->second.artifacts.end())
                    it->second.artifacts.push_back(name);
                m_store.SaveRecord(it->second);
            }
        }
        res.Json(json{{"stored", name}}.dump());
    }

    // Re-queue a build with the same project/product/branch/commit/variant as an
    // existing one. Returns the new jobId.
    void Coordinator::HandleRerun(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        BuildRecord rec;
        if (!GetBuildCopy(jobId, rec)) { res.Set(404, "unknown build"); return; }
        RefreshProjectSource(rec.projectId);   // rerun with the smith.json at the repo's tip
        std::string branchErr;                 // ...or at its branch's tip, for a non-tracked branch
        if (!LoadBranchProject(rec.projectId, rec.branch, true, branchErr))
            LOG_WARNING("Smith", "rerun %s@%s: %s", rec.projectId.c_str(), rec.branch.c_str(), branchErr.c_str());
        std::string newId = EnqueueBuild(rec.projectId, rec.product, rec.branch, rec.commit, "rerun", rec.variant, rec.targetOs, rec.clean);
        if (newId.empty()) { JsonError(res, 409, "could not re-queue (project/product/rule gone?)"); return; }
        res.Json(json{{"jobId", newId}}.dump());
    }

    // Cancel a queued build immediately, or request cancellation of a running one
    // (the agent is told via its next log-post response and kills the build).
    void Coordinator::HandleCancel(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_builds.find(jobId);
        if (it == m_builds.end()) { res.Set(404, "unknown build"); return; }
        BuildRecord& rec = it->second;

        if (IsTerminal(rec.status)) { JsonError(res, 409, "build already finished"); return; }

        if (rec.status == "queued")
        {
            CancelBuildLocked(jobId);
            res.Json(json{{"jobId", jobId}, {"status", "cancelled"}}.dump());
            return;
        }

        // Running: signal the agent to abort; the result post will mark it cancelled.
        m_cancelRequested.insert(jobId);
        res.Json(json{{"jobId", jobId}, {"status", "cancelling"}}.dump());
    }

    // Queued: cancel immediately (and advance any batch it belonged to). Running:
    // request the agent abort; the result post settles it. Caller holds m_mutex.
    void Coordinator::CancelBuildLocked(const std::string& jobId)
    {
        auto it = m_builds.find(jobId);
        if (it == m_builds.end() || IsTerminal(it->second.status)) return;
        BuildRecord& rec = it->second;
        if (rec.status == "queued")
        {
            m_queue.erase(std::remove(m_queue.begin(), m_queue.end(), jobId), m_queue.end());
            rec.status = "cancelled";
            rec.phase = "done";
            rec.finishedAt = NowMillis();
            m_store.SaveRecord(rec);
            EmitBuildEvent("cancelled", rec);
            OnJobTerminalLocked(jobId);
            return;
        }
        m_cancelRequested.insert(jobId);
    }

    bool Coordinator::EnsureDiagnostics(const std::string& jobId, BuildDiagnostics& out)
    {
        BuildRecord copy;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_builds.find(jobId);
            if (it == m_builds.end() || !IsTerminal(it->second.status)) return false;
            if (it->second.diagnostics.parsed) { out = it->second.diagnostics; return true; }
            copy = it->second;   // parse from a copy, off the lock (ReadLog + regex are slow)
        }

        std::string log;
        m_store.ReadLog(copy, log);
        BuildDiagnostics diag = ParseBuildDiagnostics(log);

        BuildRecord toSave;
        bool save = false;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            auto it = m_builds.find(jobId);
            if (it == m_builds.end()) { out = diag; return true; }
            if (!it->second.diagnostics.parsed)   // another thread may have raced us here
            {
                it->second.diagnostics = diag;
                toSave = it->second;
                save = true;
            }
            out = it->second.diagnostics;
        }
        if (save) m_store.SaveRecord(toSave);   // persist so the parse survives a restart
        return true;
    }

    void Coordinator::HandleBuildDiagnostics(const Http::Request& req, Http::Response& res)
    {
        std::string jobId = req.Param("jobId");
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_builds.find(jobId) == m_builds.end()) { res.Set(404, "unknown build"); return; }
        }
        BuildDiagnostics diag;            // default parsed=false while the build is still running
        EnsureDiagnostics(jobId, diag);   // parses + caches the full tree once terminal
        res.Json(DiagnosticsToJson(diag).dump());
    }

    void Coordinator::HandleArtifactDownload(const Http::Request& req, Http::Response& res)
    {
        BuildRecord rec;
        if (!GetBuildCopy(req.Param("jobId"), rec)) { res.Set(404, "unknown build"); return; }
        std::string bytes;
        if (!m_store.LoadArtifact(rec, req.Param("name"), bytes)) { res.Set(404, "no such artifact"); return; }
        res.Set(200, bytes, "application/octet-stream");
        res.headers["Content-Disposition"] = "attachment; filename=\"" + fs::path(req.Param("name")).filename().string() + "\"";
    }

}
