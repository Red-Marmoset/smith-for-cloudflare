#include "HostedAgent.h"
#include "HostedPull.h"
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <regex>
#include <stdexcept>
namespace Smith {
    bool HostedOriginValid(const std::string& origin)
    {
        return std::regex_match(origin, std::regex(R"(https://[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?)"));
    }
    bool HostedRelativePathValid(const std::string& path)
    {
        if (path.empty() || path == ".") return true;
        if (path.front() == '/' || path.front() == '\\' || path.size() > 500) return false;
        std::string part;
        auto validPart = [](std::string s) {
            if (s.empty() || s == ".." || s.back() == '.' || s.back() == ' ') return false;
            std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)std::toupper(c); });
            s = s.substr(0, s.find('.'));
            return s != "CON" && s != "PRN" && s != "AUX" && s != "NUL" &&
                !(s.size() == 4 && (s.substr(0,3) == "COM" || s.substr(0,3) == "LPT") && std::isdigit((unsigned char)s[3]));
        };
        for (unsigned char c : path) {
            if (c < 32 || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') return false;
            if (c == '/' || c == '\\') { if (!validPart(part)) return false; part.clear(); }
            else part += (char)c;
        }
        return validPart(part);
    }
    bool HostedArtifactsRemote(const std::string& url)
    {
        static const std::regex pattern(R"(https://[a-f0-9]{32}\.artifacts\.cloudflare\.net/git/[A-Za-z0-9][A-Za-z0-9._-]{1,62}/[A-Za-z0-9][A-Za-z0-9._-]{1,62}\.git)");
        return url.size() < 512 && std::regex_match(url, pattern);
    }
    namespace {
        std::string& CoordinatorOrigin() { static std::string origin; return origin; }
        std::string& NodeCredential() { static std::string credential; return credential; }
    }
    void HostedSetCoordinator(const std::string& origin, const std::string& nodeCredential) { CoordinatorOrigin() = origin; NodeCredential() = nodeCredential; }
    std::string HostedCoordinatorOrigin() { return CoordinatorOrigin(); }
    bool HostedSmithRemote(const std::string& url)
    {
        const auto& origin = CoordinatorOrigin();
        if (origin.empty() || url.size() > 512 || url.rfind(origin + "/git/", 0) != 0) return false;
        static const std::regex name(R"([a-z0-9][a-z0-9-]{0,63}\.git)");
        return std::regex_match(url.substr(origin.size() + 5), name);
    }
    bool HostedCredentialRemote(const std::string& url) { return HostedArtifactsRemote(url) || HostedSmithRemote(url); }
    std::map<std::string, std::string> HostedGitAuthEnv(const std::string& url, const std::string& token)
    {
        std::map<std::string, std::string> env = {{"GIT_TERMINAL_PROMPT", "0"}};
        if (token.empty()) return env;
        const auto scheme = url.find("://");
        if (scheme == std::string::npos) return env;
        int count = 0;
        const auto add = [&](const std::string& key, const std::string& value) { env["GIT_CONFIG_KEY_" + std::to_string(count)] = key; env["GIT_CONFIG_VALUE_" + std::to_string(count)] = value; ++count; };
        if (HostedSmithRemote(url)) {
            // A trailing slash makes the key a prefix match, so it covers <url>/info/refs and <url>/git-upload-pack and no other repository.
            add("http." + url + "/.extraheader", "Authorization: Bearer " + token);
            if (!NodeCredential().empty()) add("http." + url + "/.extraheader", "X-Smith-Node: " + NodeCredential());
            add("credential.helper", "");
        } else {
            const auto hostEnd = url.find('/', scheme + 3);
            const std::string origin = url.substr(0, hostEnd == std::string::npos ? url.size() : hostEnd);
            add("http." + origin + "/.extraheader", "Authorization: Bearer " + token);
        }
        env["GIT_CONFIG_COUNT"] = std::to_string(count);
        return env;
    }
    std::map<std::string, std::string> HostedLfsEnv(const JobSpec& spec, std::map<std::string, std::string> env)
    {
        if (spec.lfs.url.empty()) return env;
        int count = 0;
        const auto it = env.find("GIT_CONFIG_COUNT");
        if (it != env.end()) count = std::atoi(it->second.c_str());
        const auto add = [&](const std::string& key, const std::string& value) { env["GIT_CONFIG_KEY_" + std::to_string(count)] = key; env["GIT_CONFIG_VALUE_" + std::to_string(count)] = value; ++count; };
        // git-lfs reads lfs.url like any git config, so a clone from GitHub or from a local copy finds Smith's endpoint.
        add("lfs.url", spec.lfs.url + "/info/lfs");
        bool authorized = false;
        for (const auto& kv : env) if (kv.second == "Authorization: Bearer " + spec.lfs.authToken) authorized = true;
        if (!authorized) {
            // The same header set the checkout gets for a Smith remote, minus credential.helper (the checkout's own setting stands).
            const auto ticket = HostedGitAuthEnv(spec.lfs.url, spec.lfs.authToken);
            const auto countIt = ticket.find("GIT_CONFIG_COUNT");
            const int ticketCount = countIt == ticket.end() ? 0 : std::atoi(countIt->second.c_str());
            for (int i = 0; i < ticketCount; ++i) {
                const auto key = ticket.at("GIT_CONFIG_KEY_" + std::to_string(i));
                if (key == "credential.helper") continue;
                add(key, ticket.at("GIT_CONFIG_VALUE_" + std::to_string(i)));
            }
        }
        env["GIT_CONFIG_COUNT"] = std::to_string(count);
        return env;
    }
    std::vector<std::string> HostedCommandArgv(const CommandSpec& command, const std::string& cwd)
    {
        const auto script = (std::filesystem::path(cwd) / command.script).string();
        std::vector<std::string> args;
        if (command.interpreter == "exe") args = {command.script.find_first_of("/\\") == std::string::npos ? command.script : script};
        else if (command.interpreter == "ps1") args = {"powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script};
        else if (command.interpreter == "bat") args = {"cmd.exe", "/d", "/c", script};
        else if (command.interpreter == "sh") args = {"/bin/sh", script};
        else if (command.interpreter == "python") args = {"python", script};
        else return {};
        args.insert(args.end(), command.args.begin(), command.args.end()); return args;
    }
    namespace {
        // Why a git remote cannot be used by a hosted job, or "" when it can.
        std::string RemoteUrlProblem(const std::string& url)
        {
            if (url.find_first_of("\r\n\t ") != std::string::npos || url.find('\0') != std::string::npos) return "Invalid repository URL";
            if (!(url.rfind("https://",0) == 0 || url.rfind("ssh://",0) == 0 || url.rfind("git@",0) == 0)) return "Repository URL must use HTTPS or SSH";
            if (url.rfind("https://",0) == 0 && url.substr(8, url.find('/',8)-8).find('@') != std::string::npos) return "Repository URL must not contain credentials";
            return "";
        }
    }
    std::string ValidateHostedSpec(const JobSpec& spec)
    {
        if (!spec.inputs.empty() || !spec.handoff.empty() ||
            !spec.artifacts.exclude.empty() || !spec.artifacts.archiveName.empty() ||
            (!spec.artifacts.package.empty() && spec.artifacts.package != "none"))
            return "Hosted agent supports exact-file artifacts with package=none; inputs and handoff are unsupported";
        if (spec.artifacts.globs.size() > 4) return "Hosted jobs support at most four artifacts";
        if (!spec.artifacts.globs.empty() && spec.artifacts.package != "none") return "Hosted artifacts require package=none";
        std::vector<std::string> artifactNames;
        for (const auto& path : spec.artifacts.globs) {
            if (path.empty() || path == "." || !HostedRelativePathValid(path)) return "Artifacts must name exact relative files without wildcards";
            std::string normalized = path;
            std::replace(normalized.begin(), normalized.end(), '\\', '/');
            std::string name = normalized.substr(normalized.find_last_of('/') + 1);
            if (!std::regex_match(name, std::regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))) return "Artifact names must use ASCII letters, numbers, dots, underscores or hyphens";
            std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            if (std::find(artifactNames.begin(), artifactNames.end(), name) != artifactNames.end()) return "Artifact basenames must be unique";
            artifactNames.push_back(name);
        }
        if (!HostedRelativePathValid(spec.workingDir)) return "Working directory must stay inside the repository";
        if (spec.timeoutSeconds < 0 || spec.timeoutSeconds > 86400) return "Invalid timeout";
        for (int code : spec.successExitCodes) if (code < 0) return "Success exit codes must be nonnegative";
        if (spec.kind != "build" && spec.kind != "mirror" && spec.kind != "scan" && spec.kind != "checkin" && spec.kind != "host" && spec.kind != "import" && !HostedPullKind(spec.kind)) return "Unsupported job kind";
        if (const auto pull = ValidateHostedPull(spec); !pull.empty()) return pull;
        // A host job copies one repository into this machine's store under the coordinator's repository id.
        const bool host = spec.kind == "host";
        const auto& init = spec.host.init;
        if (host && !init.kind.empty()) {
            // A project started in Smith: nothing to copy, a name for its README/commit, and for a zip its upload's name and size.
            if (init.kind != "empty" && init.kind != "zip") return "Unknown way to start a repository";
            if (!spec.repos.empty()) return "A new repository has no source to copy";
            if (init.name.empty() || init.name.size() > 128 || init.name.find_first_of(std::string("\r\n\t\0", 4)) != std::string::npos) return "A new repository needs a project name";
            if (init.kind == "zip" && (init.archiveSize < 1 || init.archiveSize > 100LL * 1024 * 1024 || init.archiveName.size() > 200)) return "Invalid upload for a new repository";
            if (init.kind == "empty" && (init.archiveSize != 0 || !init.archiveName.empty())) return "An empty repository has no upload";
        } else if (!init.kind.empty() || !init.name.empty() || !init.archiveName.empty() || init.archiveSize != 0) return "Only host jobs that start a repository may say how";
        if (host && init.kind.empty()) {
            if (spec.repos.size() != 1) return "A host job copies exactly one repository";
            // The machine's own Git login, or (a project started in Smith on Cloudflare Artifacts) a read token for that copy.
            if (!spec.repos[0].hostedUuid.empty() || (!spec.repos[0].authToken.empty() && !HostedArtifactsRemote(spec.repos[0].url))) return "A host job copies with this machine's own Git login";
            if (spec.repos[0].authToken.size() > 512 || spec.repos[0].authToken.find_first_of("\r\n\t \"") != std::string::npos) return "Invalid repository token";
        }
        if (host) {
            if (!std::regex_match(spec.host.repoUuid, std::regex("[a-f0-9][a-f0-9-]{7,63}"))) return "Host job requires the repository's id";
            if (!spec.host.defaultBranch.empty() && (!std::regex_match(spec.host.defaultBranch, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]*")) || spec.host.defaultBranch.find("..") != std::string::npos)) return "Invalid default branch";
            if (!init.kind.empty() && spec.host.defaultBranch.empty()) return "A new repository needs its branch";
            if (spec.host.maxBytes < 0) return "Invalid repository size limit";
        } else if (!spec.host.repoUuid.empty() || !spec.host.defaultBranch.empty() || spec.host.maxBytes != 0) return "Only host jobs may carry a host target";
        // Large files: only a Smith remote, with a plain ticket that can ride a header.
        if (!spec.lfs.url.empty() || !spec.lfs.authToken.empty()) {
            const bool plain = !spec.lfs.authToken.empty() && spec.lfs.authToken.size() <= 512 && spec.lfs.authToken.find_first_of("\r\n\t \"") == std::string::npos;
            if (!HostedSmithRemote(spec.lfs.url) || !plain) return "Invalid large-file source";
        }
        // An import: one source cloned with this machine's own login, pushed into Smith's storage with the coordinator's
        // write token, its large files to Smith's own address with the ticket in `lfs`; nothing else rides along.
        const bool importing = spec.kind == "import";
        const auto& im = spec.import;
        if (!importing && (!im.source.empty() || !im.artifactsRemote.empty() || !im.artifactsToken.empty() || !im.smithRemote.empty() || im.thresholdBytes || im.maxRepoBytes)) return "Only import jobs may carry an import source";
        if (importing) {
            if (!spec.repos.empty()) return "An import names its source in the import field";
            if (const auto problem = RemoteUrlProblem(im.source); !problem.empty()) return "Import source: " + problem;
            if (!HostedArtifactsRemote(im.artifactsRemote)) return "An import pushes to Smith's storage only";
            if (im.artifactsToken.empty() || im.artifactsToken.size() > 512 || im.artifactsToken.find_first_of("\r\n\t \"") != std::string::npos) return "Invalid storage token";
            if (!HostedSmithRemote(im.smithRemote)) return "An import's large files go to Smith's own address";
            if (im.thresholdBytes < 1024 * 1024 || im.thresholdBytes > 32LL * 1024 * 1024) return "Import threshold must be 1 MiB to 32 MiB";
            if (im.maxRepoBytes <= 0) return "Invalid repository size limit";
            if (!std::regex_match(im.originalBlob, std::regex("[a-z0-9][a-z0-9.-]{0,63}"))) return "Invalid blob name";
            if (spec.lfs.url != im.smithRemote || spec.lfs.authToken.empty()) return "An import needs its large-file ticket";
        }
        // Repository jobs leave the commit empty: a scan reads the branch tip, and a build with a
        // resolve action checks the tip out and then asks the coordinator for its command.
        const bool checkin = spec.kind == "checkin";
        if (checkin) {
            const auto& c = spec.checkIn;
            if (spec.repos.size() != 1 || c.eventId.empty() || c.eventId.size() > 128 ||
                !std::regex_match(c.baseCommit, std::regex("[a-f0-9]{40}")) || !std::regex_match(c.headCommit, std::regex("[a-f0-9]{40}")) ||
                c.baseCommit == std::string(40, '0') || c.headCommit == std::string(40, '0') || spec.repos[0].commit != c.headCommit ||
                !spec.command.script.empty() || !spec.steps.empty() || !spec.env.empty() || !spec.artifacts.globs.empty()) return "Invalid metadata-only check-in job";
        }
        const bool scan = spec.kind == "scan";
        const bool resolving = !spec.resolve.action.empty();
        if (resolving && spec.kind != "build") return "Only build jobs may resolve their command";
        if (resolving && (spec.resolve.action.size() > 200 || spec.resolve.action.find_first_of(std::string("\r\n\t\0", 4)) != std::string::npos)) return "Invalid build action";
        if ((scan || resolving) && spec.repos.size() != 1) return "A repository job needs exactly one repository";
        const bool mirror = spec.kind == "mirror";
        if (mirror) {
            if (spec.repos.size() != 1) return "A mirror job copies exactly one repository";
            if (HostedCredentialRemote(spec.mirror.remote)) {
                // Into Smith's copy: an Artifacts write token, or a git ticket for Smith's own repository.
                if (spec.mirror.authToken.empty() || spec.mirror.authToken.size() > 512 || spec.mirror.authToken.find_first_of("\r\n\t \"") != std::string::npos) return "Mirror job requires a write credential for Smith's copy";
            } else {
                // Push to a project's linked repository with this machine's own Git login: only Smith's copy
                // goes out that way, and never with a token from the coordinator.
                if (!spec.mirror.authToken.empty()) return "Only Smith's own copy may be a mirror target with a token";
                if (!HostedCredentialRemote(spec.repos[0].url)) return "Only Smith's copy may be pushed to a linked repository";
                const auto problem = RemoteUrlProblem(spec.mirror.remote);
                if (!problem.empty()) return "Mirror target: " + problem;
            }
            if (spec.repos[0].commit.empty() && spec.repos[0].branch.empty()) return "A mirror of a branch tip needs the branch";
            if (!std::regex_match(spec.mirror.branch, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]*")) || spec.mirror.branch.find("..") != std::string::npos) return "Invalid mirror branch";
            if (spec.mirror.remote == spec.repos[0].url) return "Mirror target must differ from the source repository";
        } else if (!spec.mirror.remote.empty() || !spec.mirror.authToken.empty() || !spec.mirror.branch.empty()) return "Only mirror jobs may carry a mirror target";
        std::vector<std::string> paths;
        for (const auto& repo : spec.repos) {
            // A mirror may also take the branch tip (Pull from / Push to a linked repository); a host job copies everything.
            const bool tip = (scan || resolving || mirror || host) && repo.commit.empty();
            if (!tip && !std::regex_match(repo.commit, std::regex("[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"))) return "Repositories require a full pinned commit";
            if (tip && !repo.branch.empty() && (!std::regex_match(repo.branch, std::regex("[A-Za-z0-9][A-Za-z0-9/_.-]*")) || repo.branch.find("..") != std::string::npos)) return "Invalid branch";
            if (!HostedRelativePathValid(repo.checkoutDir)) return "Checkout directory must stay inside the job workspace";
            // Hosted builds never receive GitHub credentials; a coordinator-minted token for an Artifacts remote or
            // for Smith's own copy is the one exception (repository-scoped, short-lived).
            if (!repo.authToken.empty() && !HostedCredentialRemote(repo.url)) return "Use the agent's Git credential helper or SSH for private repositories";
            if (repo.authToken.size() > 512 || repo.authToken.find_first_of("\r\n\t \"") != std::string::npos) return "Invalid repository token";
            // The coordinator may point a build at the copy this machine already keeps (by repository id, with the expected tip).
            if (!repo.hostedUuid.empty() && (!HostedSmithRemote(repo.url) || !std::regex_match(repo.hostedUuid, std::regex("[a-f0-9][a-f0-9-]{7,63}")))) return "A local copy may only stand in for Smith's own repository";
            if (!repo.tip.empty() && !std::regex_match(repo.tip, std::regex("[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"))) return "Invalid repository tip";
            const auto problem = RemoteUrlProblem(repo.url);
            if (!problem.empty()) return problem;
            std::string path = repo.checkoutDir.empty() ? "." : repo.checkoutDir;
            std::replace(path.begin(), path.end(), '\\', '/');
            std::transform(path.begin(), path.end(), path.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            for (const auto& other : paths) if (path == "." || other == "." || path == other || path.rfind(other+"/",0)==0 || other.rfind(path+"/",0)==0) return "Checkout directories must not overlap";
            paths.push_back(path);
        }
        // A scan, a check-in metadata job, a host job and an import run no command; a resolving build's command arrives from /resolve and is checked then.
        if (!scan && !checkin && !resolving && !host && !importing) {
            const auto commands = spec.steps.empty() ? std::vector<CommandSpec>{spec.command} : spec.steps;
            for (const auto& cmd : commands) {
                if (cmd.script.empty() || cmd.script.find('\0') != std::string::npos || HostedCommandArgv(cmd, ".").empty()) return "Invalid command or unsupported interpreter";
                // Executable names may resolve through PATH; script paths are repository-relative.
                if (!(cmd.interpreter == "exe" && std::filesystem::path(cmd.script).is_absolute()) && !HostedRelativePathValid(cmd.script)) return "Command script must be relative to its working directory";
                for (const auto& arg : cmd.args) if (arg.find('\0') != std::string::npos) return "Invalid command argument";
            }
        }
        return "";
    }
    namespace {
        // A line git or its SSH/HTTPS transports print when the credentials are refused. A bare
        // "Could not read from remote repository" also follows DNS failures, so it is not enough.
        bool GitRefusal(std::string line)
        {
            static const char* const refused[] = {
                "permission denied (publickey", "authentication failed", "could not read username", "could not read password",
                "host key verification failed", "terminal prompts disabled", "invalid username or password",
                "password authentication was removed", "returned error: 401", "returned error: 403", "returned error: 404" };
            std::transform(line.begin(), line.end(), line.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            if (line.find("repository") != std::string::npos && line.find("not found") != std::string::npos) return true;
            for (const char* needle : refused) if (line.find(needle) != std::string::npos) return true;
            return false;
        }
    }
    std::string HostedClassifyGitFailure(const std::vector<std::string>& errorLines)
    {
        for (const auto& line : errorLines) if (GitRefusal(line)) return "repo_access";
        return "";
    }
    std::string HostedGitFailureReason(const std::vector<std::string>& errorLines)
    {
        std::string reason;
        for (const auto& line : errorLines) if (GitRefusal(line)) { reason = line; break; }
        if (reason.empty()) for (auto it = errorLines.rbegin(); it != errorLines.rend(); ++it) if (it->rfind("fatal:", 0) == 0) { reason = *it; break; }
        if (reason.empty()) for (auto it = errorLines.rbegin(); it != errorLines.rend(); ++it) if (!it->empty()) { reason = *it; break; }
        return reason.substr(0, 200);
    }
    std::string HostedPushFailure(const std::string& remote, const std::vector<std::string>& errorLines)
    {
        for (auto line : errorLines) {
            std::transform(line.begin(), line.end(), line.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            if (line.find("non-fast-forward") != std::string::npos || line.find("(fetch first)") != std::string::npos)
                return "Push to " + remote + " refused: not a fast-forward; nothing was overwritten";
        }
        const auto reason = HostedGitFailureReason(errorLines);
        return "Push to " + remote + " failed" + (reason.empty() ? std::string() : ": " + reason);
    }
    std::string HostedScanReport(const std::string& commit, const std::string& branch, bool hasSmithJson, const std::string& smithJson, const std::vector<std::string>& paths)
    {
        if (hasSmithJson && smithJson.size() > 256 * 1024) throw std::runtime_error("smith.json is larger than 256 KiB");
        nlohmann::json report = {{"commit", commit}, {"branch", branch}};
        report["smithJson"] = hasSmithJson ? nlohmann::json(smithJson) : nlohmann::json(nullptr);
        nlohmann::json kept = nlohmann::json::array(); size_t bytes = 0;
        for (const auto& path : paths) {
            if (kept.size() >= 20000 || bytes + path.size() > 512 * 1024) break;
            kept.push_back(path); bytes += path.size();
        }
        report["truncated"] = kept.size() < paths.size();
        report["paths"] = std::move(kept);
        return report.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
    }
    std::vector<HostedOllamaModel> HostedParseOllamaTags(const std::string& body)
    {
        std::vector<HostedOllamaModel> models;
        const auto tags = nlohmann::json::parse(body, nullptr, false);
        if (!tags.is_object() || !tags.contains("models") || !tags["models"].is_array()) return models;
        for (const auto& entry : tags["models"]) {
            if (models.size() >= 50) break;
            if (!entry.is_object() || !entry.contains("name") || !entry["name"].is_string()) continue;
            HostedOllamaModel model; model.name = entry["name"].get<std::string>();
            if (!std::regex_match(model.name, std::regex("[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}"))) continue;
            if (entry.contains("size") && entry["size"].is_number_unsigned()) model.sizeBytes = (long long)std::min<unsigned long long>(entry["size"].get<unsigned long long>(), 1ULL << 52);
            const auto endsWith = [&](const char* suffix) { const std::string s = suffix; return model.name.size() >= s.size() && model.name.compare(model.name.size() - s.size(), s.size(), s) == 0; };
            model.remote = entry.contains("remote_host") || entry.contains("remote_model") || endsWith(":cloud") || endsWith("-cloud");
            models.push_back(model);
        }
        return models;
    }
    std::string HostedToolVersion(const std::string& output)
    {
        size_t start = 0;
        while (start < output.size()) {
            size_t end = output.find('\n', start); if (end == std::string::npos) end = output.size();
            std::string line;
            for (size_t i = start; i < end && line.size() < 64; ++i) if ((unsigned char)output[i] >= 32 && (unsigned char)output[i] < 127) line += output[i];
            while (!line.empty() && line.back() == ' ') line.pop_back();
            while (!line.empty() && line.front() == ' ') line.erase(line.begin());
            if (!line.empty()) return line;
            start = end + 1;
        }
        return "";
    }
}
