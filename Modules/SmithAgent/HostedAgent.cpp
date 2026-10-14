// HostedAgent.cpp - isolated HTTPS protocol-v2 runtime; the LAN agent is unchanged.
#include "HostedAgent.h"
#include "HostedPlatform.h"
#include "HostedRepoCache.h"
#include "HostedAiSession.h"
#include "HostedCheckIn.h"
#include "HostedCrewRun.h"
#include "HostedGitHost.h"
#include "HostedGitInit.h"
#include "HostedGitRelay.h"
#include "HostedImport.h"
#include "HostedPull.h"
#include "HostedToolSetup.h"
#include "HostedTransport.h"
#include "HostedUpdate.h"
#include "ToolMaintenance.h"
#include <SmithCore/Capabilities.h>
#include <SmithCore/Config.h>
#include <SmithCore/Housekeeping.h>
#include <SmithCore/Process.h>
#include <SmithCore/TimeUtil.h>
#include <SmithCore/Uuid.h>
#include <SmithProtocol/WireJson.h>
#include <Http/Http.h>
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <thread>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
std::string ReadBounded(const fs::path& path, size_t maximum) {
    if (fs::is_symlink(fs::symlink_status(path)) || !fs::is_regular_file(path) || fs::file_size(path) > maximum) throw std::runtime_error("Invalid or oversized private file");
    std::ifstream input(path, std::ios::binary); if (!input) throw std::runtime_error("Cannot read private file");
    std::string text(maximum + 1, '\0'); input.read(text.data(), (std::streamsize)text.size()); text.resize((size_t)input.gcount());
    if (text.size() > maximum) throw std::runtime_error("Oversized response"); return text;
}
using Transport = HostedTransport; using Response = HostedResponse;
struct Options { std::string origin = "https://exp.redmarmosetstudios.com", workspaceId, workspace, enrollmentFile, drainFile; std::vector<std::string> labels; bool once = false, enrollOnly = false; };
// Exit code for failures a restart cannot fix (revoked or mismatched credential): a supervisor
// that restarts the agent stops on it instead of retrying forever.
constexpr int kExitNeedsReconnect=3;
struct ReconnectNeeded : std::runtime_error { using std::runtime_error::runtime_error; };
bool IsWorkspaceId(const std::string& id){ return std::regex_match(id,std::regex("[a-f0-9]{64}")); }
// The dashboard's connect code is "<workspace id>:<enrollment code>", so one paste carries both.
// A bare enrollment code still works when the workspace ID is already known.
std::string SplitConnectCode(std::string text,std::string& workspaceId) {
    auto isSpace=[](char c){return c==' '||c=='\t'||c=='\r'||c=='\n';};
    while(!text.empty()&&isSpace(text.back()))text.pop_back();
    size_t start=0; while(start<text.size()&&isSpace(text[start]))++start; text.erase(0,start);
    const auto colon=text.find(':');
    if(colon==std::string::npos) {
        if(workspaceId.empty())throw std::runtime_error("That is only the enrollment code; copy the whole connect code from the dashboard");
        return text;
    }
    const auto id=text.substr(0,colon);
    if(!IsWorkspaceId(id))throw std::runtime_error("That is not a Smith connect code; copy it again from \"Connect build machine\" in the dashboard");
    if(!workspaceId.empty()&&workspaceId!=id)throw std::runtime_error("That connect code is for a different workspace than --workspace-id");
    workspaceId=id; return text.substr(colon+1);
}
Options Parse(int argc,char** argv) {
    Options options;
    for (int i=2;i<argc;++i) {
        std::string flag=argv[i]; if(flag=="--once") { options.once=true; continue; }
        if(flag=="--enroll-only") { options.enrollOnly=true; continue; }
        if(i+1>=argc) throw std::runtime_error("Missing hosted-agent option value"); std::string value=argv[++i];
        if(flag=="--coordinator") options.origin=value;
        else if(flag=="--workspace-id") options.workspaceId=value;
        else if(flag=="--workspace") options.workspace=value;
        else if(flag=="--enrollment-file") options.enrollmentFile=value;
        else if(flag=="--drain-file") options.drainFile=value;
        else if(flag=="--labels") { size_t start=0,end; do { end=value.find(',',start); auto label=value.substr(start,end-start); if(!label.empty())options.labels.push_back(label); start=end+1; }while(end!=std::string::npos); }
        else throw std::runtime_error("Unknown hosted-agent option (credentials must never be passed on the command line)");
    }
    while(!options.origin.empty() && options.origin.back()=='/')options.origin.pop_back();
    if(!HostedOriginValid(options.origin))throw std::runtime_error("--coordinator must be an HTTPS origin without credentials or a path");
    // Optional: an enrolled agent reads it from its saved state, a new one from the connect code.
    if(!options.workspaceId.empty()&&!IsWorkspaceId(options.workspaceId))throw std::runtime_error("--workspace-id must be the dashboard's 64-character workspace ID");
    if(!options.drainFile.empty()&&!fs::path(options.drainFile).is_absolute())throw std::runtime_error("--drain-file must be an absolute path");
    if(options.workspace.empty())throw std::runtime_error("--workspace must name a dedicated hosted-agent directory");
    return options;
}
fs::path Contained(const fs::path& root,const std::string& relative) {
    if(!HostedRelativePathValid(relative))throw std::runtime_error("Unsafe workspace path");
    const auto canonicalRoot=fs::weakly_canonical(root), candidate=fs::weakly_canonical(root / relative);
    auto a=canonicalRoot.begin(),b=candidate.begin();
    for(;a!=canonicalRoot.end();++a,++b)if(b==candidate.end() || *a!=*b)throw std::runtime_error("Workspace path escapes through a link");
    return candidate;
}
std::string AgentVersion() {
    const fs::path executable=HostedExecutablePath();
    const auto infoPath=executable.parent_path()/"release-info.json";
    if(!fs::exists(fs::symlink_status(infoPath)))return "0.1.0-hosted-v2";
    return HostedPackageVersion(executable.parent_path().string(),executable.filename().string());
}
// What this machine can offer for AI sessions: each CLI's version, whether it is signed in and
// whether an API key is set (never the key or the login), and which missing CLIs it can install.
void DetectAiTools(Json& inventory) {
    const auto report=DetectHostedAiTools();
    inventory["tools"]=Json::parse(report.tools); inventory["installable"]=Json::parse(report.installable);
}
// On Windows, whether Codex's own sandbox is set up (see HostedCodexWindowsSandbox). Only Codex's
// config.toml and the presence of its setup marker are read.
Json DetectCodexSandbox(const Json& tools) {
    if(DetectOs()!="windows")return nullptr;
    bool codex=false; for(const auto& tool:tools)codex=codex||tool.value("id","")=="codex";
    if(!codex)return nullptr;
    const char* home=std::getenv("CODEX_HOME"); const char* profile=std::getenv("USERPROFILE");
    const fs::path dir=home&&*home?fs::path(home):profile&&*profile?fs::path(profile)/".codex":fs::path();
    if(dir.empty())return nullptr;
    std::ifstream in(dir/"config.toml",std::ios::binary); std::stringstream text; text<<in.rdbuf();
    std::error_code missing;
    return HostedCodexWindowsSandbox(text.str().substr(0,256*1024),fs::exists(dir/".sandbox"/"setup_marker.json",missing));
}
Json DetectOllama() {
    Json ollama={{"up",false},{"models",Json::array()}};
    Http::Client client("http://127.0.0.1:11434"); client.SetTimeoutSeconds(2);
    const Http::Result result=client.Get("/api/tags");
    if(!result.ok || result.status!=200)return ollama;
    ollama["up"]=true;
    for(const auto& model:HostedParseOllamaTags(result.body))ollama["models"].push_back({{"name",model.name},{"sizeBytes",model.sizeBytes},{"remote",model.remote}});
    return ollama;
}
// Whether this machine can keep copies of repositories (git 2.36+, its exec path, 2 GB free, a private store), as
// the heartbeat reports it. Also provisions the store root and the ref-policy hook, so the first relay finds them.
Json DetectHosting(const fs::path& root) {
    std::vector<std::string> version,execPath;
    const auto capture=[](std::vector<std::string>& into){return [&into](bool error,const std::string& line){if(!error&&into.size()<4)into.push_back(line);};};
    ProcessOptions options; options.timeoutSeconds=20; options.envOverride={{"GIT_TERMINAL_PROMPT","0"}};
    options.argv={"git","--version"}; { Process process; process.Run(options,capture(version)); }
    options.argv={"git","--exec-path"}; { Process process; process.Run(options,capture(execPath)); }
    std::error_code ec;
    const bool execOk=!execPath.empty()&&fs::is_directory(execPath[0],ec);
    bool storeOk=true;
    try { HostedSecureDirectory((root/"git").string()); HostedGitProvisionHooks((root/"git"/"hooks").string()); } catch(const std::exception&) { storeOk=false; }
    const auto free=FreeDiskBytes(root.string());
    std::string line; for(const auto& l:version){line+=l;line+='\n';}
    const auto ability=HostedGitHostAbility(HostedToolVersion(line),execOk,(int64_t)std::min<uint64_t>(free,1ULL<<52),storeOk);
    return {{"able",ability.able},{"reason",ability.reason},{"free",(int64_t)std::min<uint64_t>(free,1ULL<<52)}};
}
// Removes finished job directories beyond the newest `keep`, so hosting machines do not fill up with old checkouts.
void CleanJobDirs(const fs::path& jobs,size_t keep) {
    std::error_code ec; std::vector<std::pair<fs::file_time_type,fs::path>> dirs;
    for(const auto& entry:fs::directory_iterator(jobs,ec))if(entry.is_directory(ec))dirs.emplace_back(entry.last_write_time(ec),entry.path());
    std::sort(dirs.begin(),dirs.end(),[](const auto& a,const auto& b){return a.first>b.first;});
    for(size_t i=keep;i<dirs.size();++i)fs::remove_all(dirs[i].second,ec);
}
Json InterruptedResult() { return { {"status","error"},{"exitCode",-1},{"durationMs",0},{"message","Agent restarted before recording completion; this attempt was not re-executed"} }; }
// A git step failed. `failure` is "repo_access" when this machine's Git login cannot read the
// repository, so the coordinator hands the job to another machine instead of failing it.
struct GitFailure : std::runtime_error { std::string failure; GitFailure(const std::string& message,std::string kind):std::runtime_error(message),failure(std::move(kind)){} };
class Runner {
public:
    explicit Runner(Options options):m_options(std::move(options)){}
    int Run() {
        if(!HostedCrashContainmentAvailable())throw std::runtime_error("Hosted agents need process-tree crash containment, which this platform build lacks");
        auto root=fs::absolute(m_options.workspace).lexically_normal();
        if(!fs::exists(root.parent_path()))throw std::runtime_error("Create the parent of the dedicated workspace first");
        // Refuse to claim an existing populated directory unless it has hosted state.
        if(fs::exists(root) && !fs::is_empty(root) && !fs::exists(root/"hosted-state.json") && !fs::exists(root/"hosted-workspace"))throw std::runtime_error("Workspace is not empty and has no hosted-agent state; choose a dedicated directory");
        HostedSecureDirectory(root.string()); HostedSecureWrite((root/"hosted-workspace").string(),"Smith hosted agent v2\n"); m_lock=HostedLockWorkspace((root/"agent.lock").string());
        m_statePath=root/"hosted-state.json"; m_root=root;
        m_transport.directory=root/"transport"; HostedSecureDirectory(m_transport.directory.string());
        // Settle the workspace ID first: it comes from --workspace-id, the saved state, or the connect code.
        std::string code;
        if(fs::exists(m_statePath)) {
            if(!HostedFileIsPrivate(m_statePath.string()))throw std::runtime_error("Saved credential file must be readable only by its owner");
            m_state=Json::parse(ReadBounded(m_statePath,1024*1024));
            if(m_options.workspaceId.empty())m_options.workspaceId=m_state.value("workspaceId","");
            if(m_state.value("origin","")!=m_options.origin || m_state.value("workspaceId","")!=m_options.workspaceId)throw ReconnectNeeded("Saved credentials belong to a different origin or workspace");
        } else {
            if(m_options.enrollmentFile.empty()) { std::printf("Paste the connect code from the dashboard, then press Enter: "); std::fflush(stdout); code=HostedReadSecret(); std::printf("Got a %zu-character code. Connecting...\n",code.size()); std::fflush(stdout); }
            else { if(!HostedFileIsPrivate(m_options.enrollmentFile))throw std::runtime_error("Enrollment file must be readable only by its owner; paste the code at the console prompt instead");code=ReadBounded(m_options.enrollmentFile,512); }
            code=SplitConnectCode(code,m_options.workspaceId);
        }
        if(!IsWorkspaceId(m_options.workspaceId))throw std::runtime_error("No workspace ID: paste the connect code from the dashboard");
        m_transport.base=m_options.origin+"/api/v2/workspaces/"+m_options.workspaceId;
        Json metadata={{"hostname",DetectHostname()},{"os",DetectOs()},{"arch",DetectArch()},{"agentVersion",AgentVersion()}};
        auto labels=m_options.labels;
        const char* engine=std::getenv("UNA_ENGINE_PATH");
        labels.push_back("checkin-metadata-v1");
        auto capabilities=DetectCapabilityLabels(engine ? engine : "");
        for(const auto& cap:DetectPathToolLabels())capabilities.push_back(cap);
        for(const auto& cap:DetectShellLabels())capabilities.push_back(cap);
        // Blender is rarely on PATH (its installers leave PATH alone), so it is looked for where it installs.
        m_blender=FindBlender();
        if(!m_blender.empty()){capabilities.push_back("blender");std::printf("Blender found: %s\n",m_blender.c_str());}
        for(const auto& cap:capabilities)if(std::find(labels.begin(),labels.end(),cap)==labels.end())labels.push_back(cap);
        // This agent can scan repositories and build branch tips through /resolve.
        if(std::find(labels.begin(),labels.end(),"smith-repo-projects")==labels.end())labels.push_back("smith-repo-projects");
        // ...and Pull from / Push to a project's linked repository (branch-tip mirror jobs).
        if(std::find(labels.begin(),labels.end(),"smith-repo-sync")==labels.end())labels.push_back("smith-repo-sync");
        // ... and run Smith's own pull requests: diff, merge and publish jobs (HostedPull.h).
        if(std::find(labels.begin(),labels.end(),"smith-pull-requests")==labels.end())labels.push_back("smith-pull-requests");
        // ... and, with git-lfs here, import repositories into Smith's storage, moving large files to LFS (HostedImport.h).
        if(std::find(labels.begin(),labels.end(),"git-lfs")!=labels.end()&&std::find(labels.begin(),labels.end(),"smith-import")==labels.end())labels.push_back("smith-import");
        // ... and start a new, empty repository in Smith (a host job whose source is Smith's own address).
        if(std::find(labels.begin(),labels.end(),"smith-git-new")==labels.end())labels.push_back("smith-git-new");
        metadata["labels"]=labels;
        if(!m_state.is_null()) {
            m_transport.token=m_state.at("token").get<std::string>();
            // Also harden files created by a previous version.
            Save();
            if(m_options.enrollOnly){std::printf("This computer is already connected (node %s).\n",m_state.value("nodeId","").c_str());return 0;}
        } else {
            if(code.empty() || code.size()>256 || code.find_first_of("\r\n\0",0,3)!=std::string::npos)throw std::runtime_error("Invalid enrollment code");
            Json enrollment=metadata; enrollment["code"]=code; enrollment["protocolVersion"]=2;
            auto response=m_transport.Post("/nodes/enroll",enrollment);
            if(!response.Ok())throw std::runtime_error(response.status==0
                ? "Enrollment failed: cannot reach "+m_options.origin+"; check the network and retry"
                : "Enrollment failed (HTTP "+std::to_string(response.status)+"); create a new code in the dashboard and retry");
            if(response.body.value("protocolVersion",0)!=2)throw std::runtime_error("Coordinator returned unsupported protocol");
            m_transport.token=response.body.at("token").get<std::string>();
            m_state={{"origin",m_options.origin},{"workspaceId",m_options.workspaceId},{"token",m_transport.token},{"nodeId",response.body.at("nodeId")}}; Save();
            if(!m_options.enrollmentFile.empty())std::printf("Enrollment saved. You may delete the enrollment file.\n");
            if(m_options.enrollOnly){std::printf("Connected: this computer is now node %s.\n",m_state.at("nodeId").get<std::string>().c_str());return 0;}
        }
        if(m_transport.token.empty() || m_transport.token.size()>512 || m_transport.token.find_first_of("\r\n")!=std::string::npos)throw std::runtime_error("Saved node credential is invalid");
        HostedSetCoordinator(m_options.origin,m_transport.token);
        // This package can build from Smith's own copies of repositories; keeping copies needs git 2.36+ and disk.
        if(std::find(labels.begin(),labels.end(),kHostedGitClientLabel)==labels.end())labels.push_back(kHostedGitClientLabel);
        Json hosting=DetectHosting(m_root);
        const auto applyHostLabel=[&](){
            for(const char* label:{kHostedGitHostLabel,kHostedGitInitLabel})labels.erase(std::remove(labels.begin(),labels.end(),std::string(label)),labels.end());
            // A host that can keep copies can also start a repository (empty, or from an uploaded zip).
            if(hosting.value("able",false)){labels.push_back(kHostedGitHostLabel);labels.push_back(kHostedGitInitLabel);}
            metadata["labels"]=labels;
        };
        applyHostLabel();
        if(!hosting.value("able",false)){std::printf("This machine cannot keep copies of repositories: %s.\n",hosting.value("reason","").c_str());std::fflush(stdout);}
        std::printf("Hosted agent %s connected to %s (protocol 2).\n",m_state.at("nodeId").get<std::string>().c_str(),m_options.origin.c_str());
        std::printf("Agent release identity: %s\n",metadata.at("agentVersion").get<std::string>().c_str()); std::fflush(stdout);
        // An update installed by the previous run is confirmed by the first accepted heartbeat; until
        // then this agent takes no work, and the launcher goes back to the old files if it exits.
        const std::string version=metadata.at("agentVersion").get<std::string>();
        const fs::path installDir=fs::path(HostedExecutablePath()).parent_path();
        std::string pendingUpdate=HostedPendingUpdate(installDir.string());
        const auto runStarted=Clock::now();
        if(!pendingUpdate.empty()) {
            if(pendingUpdate!=version){std::printf("This agent is %s, not the %s the update installed; going back to the previous version.\n",version.c_str(),pendingUpdate.c_str());std::fflush(stdout);return kHostedExitUpdateUnconfirmed;}
            std::printf("Started the updated agent %s; waiting for the coordinator to accept it.\n",version.c_str()); std::fflush(stdout);
        }
        if(m_state.contains("pending")) {
            if(!m_state["pending"].contains("result")) { m_state["pending"]["result"]=InterruptedResult(); Save(); }
            std::printf("Reconciling the saved attempt without re-executing it.\n");
            if(!Complete())return 1;
        }
        // Dashboard chat runs beside builds on its own thread; it stops (and is joined) whenever Run returns.
        // `post` is declared first so it outlives the thread that the AiThread destructor joins.
        const HostedPostFn post=[this](const std::string& route,const std::string& body,std::string& out){
            const auto response=m_transport.Post(route,Json::parse(body)); out=response.body.dump(-1,' ',false,Json::error_handler_t::replace); return response.status; };
        ToolMaintenance maintenance;
        std::atomic<int> aiBusy{0};
        struct AiThread { std::atomic<bool> stop{false}; std::thread thread; void Stop(){stop=true;if(thread.joinable())thread.join();} ~AiThread(){Stop();} } ai;
        const auto startAi=[&](){
            ai.stop=false;
            ai.thread=std::thread([&](){ try{RunHostedAiLoop(post,m_root.string(),ai.stop,maintenance.gate,&maintenance.generation,&aiBusy);}catch(const std::exception& error){std::printf("AI chat stopped: %s\n",error.what());} });
        };
        startAi();
        // The git host serves relayed clones, fetches and pushes on its own thread, only while the coordinator says this
        // machine keeps copies (the heartbeat's gitHost). Updates wait for its relays like they wait for chats.
        std::atomic<bool> gitWanted{false}; std::atomic<int> gitBusy{0};
        struct GitThread { std::atomic<bool> stop{false}; std::thread thread; void Stop(){stop=true;if(thread.joinable())thread.join();} ~GitThread(){Stop();} } git;
        const HostedGitLoopConfig gitConfig{m_root.string(),m_options.workspaceId,DetectHostname()};
        const auto startGit=[&](){
            git.stop=false;
            git.thread=std::thread([&](){ try{RunHostedGitLoop(m_transport,gitConfig,git.stop,gitWanted,&gitBusy);}catch(const std::exception& error){std::printf("Git host stopped: %s\n",error.what());} });
        };
        startGit();
        auto lastHeartbeat=Clock::now()-std::chrono::minutes(1);
        // Reported with heartbeats rather than at enrollment, so a coordinator that predates AI
        // reports can still enroll this agent; it answers 400 and the agent stops sending them.
        Json inventory={{"tools",Json::array()},{"ollama",DetectOllama()},{"features",HostedAiFeatures()}}; bool reportAi=true, reportHosting=true, online=false; int beats=0; unsigned toolGeneration=0; bool detectedTools=false;
        for(;;) {
            if(HostedDrainRequested(m_options.drainFile)){std::printf("Drain requested; no job is active and saved completion is reconciled. Exiting.\n");std::fflush(stdout);return 0;}
            // A finished install or sign-in (or tool maintenance) is reported at once, not at the next beat.
            if(Clock::now()-lastHeartbeat>=std::chrono::seconds(20) || (reportAi && detectedTools && toolGeneration!=maintenance.generation.load() && Clock::now()-lastHeartbeat>=std::chrono::seconds(3))) {
                ++beats;
                if(reportAi && beats%3==0)inventory["ollama"]=DetectOllama();     // ~1 min: models come and go
                if(beats%3==0&&beats>0){hosting=DetectHosting(m_root);applyHostLabel();}   // ~1 min: disk and git come and go too
                if(reportAi && (!detectedTools || beats%6==0 || toolGeneration!=maintenance.generation.load())) {
                    std::shared_lock<std::shared_mutex> tools(maintenance.gate,std::try_to_lock);
                    if(tools.owns_lock()){
                        auto accountTools=TryAgentToolUse();
                        if(accountTools){
                            toolGeneration=maintenance.generation.load();DetectAiTools(inventory);detectedTools=true;
                            const auto sandbox=DetectCodexSandbox(inventory["tools"]);
                            if(sandbox.is_null())inventory.erase("codexSandbox"); else inventory["codexSandbox"]=sandbox;
                        }
                    }
                }
                Json beat=metadata; if(reportAi)beat["ai"]=inventory; if(reportHosting)beat["hosting"]=hosting;
                auto hb=m_transport.Post("/heartbeat",beat);
                if(hb.status==400 && reportHosting){reportHosting=false;beat.erase("hosting");std::printf("Coordinator does not accept hosting reports; continuing without them.\n");std::fflush(stdout);hb=m_transport.Post("/heartbeat",beat);}
                if(hb.status==400 && reportAi){reportAi=false;std::printf("Coordinator does not accept AI tool reports; continuing without them.\n");std::fflush(stdout);hb=m_transport.Post("/heartbeat",metadata);}
                if(hb.status==401||hb.status==403)throw ReconnectNeeded("Node credential revoked; re-enroll using a new dedicated workspace"); lastHeartbeat=Clock::now();
                if(hb.Ok()) {
                    gitWanted=hb.body.value("gitHost",false);
                    m_hasOffer=HostedParseUpdateOffer(hb.body.dump(),m_offer);
                    if(!pendingUpdate.empty()){HostedConfirmUpdate(installDir.string());std::printf("Update to %s confirmed: the coordinator accepted the new agent.\n",pendingUpdate.c_str());std::fflush(stdout);pendingUpdate.clear();}
                }
                // One line per change, so the log shows when the coordinator was unreachable without repeating it.
                if(hb.Ok()!=online){online=hb.Ok();std::printf(online?"Online: the coordinator accepted this agent.\n":"Cannot reach the coordinator (HTTP %d); retrying.\n",hb.status);std::fflush(stdout);}
            }
            if(!pendingUpdate.empty()) {
                if(Clock::now()-runStarted>=std::chrono::minutes(5)){std::printf("The coordinator has not accepted the updated agent within 5 minutes; going back to the previous version.\n");std::fflush(stdout);return kHostedExitUpdateUnconfirmed;}
                std::this_thread::sleep_for(std::chrono::seconds(1));continue;
            }
            // Between jobs, with no chat running: the only moment an update is installed.
            if(!m_options.once && UpdateReady(version,installDir,aiBusy,gitBusy)) {
                ai.Stop(); git.Stop();
                try {
                    HostedApplyStagedPackage(installDir.string(),(installDir/".update-staging").string(),version,m_offer.version);
                    std::printf("Installed %s; restarting into it.\n",m_offer.version.c_str());std::fflush(stdout);
                    return kHostedExitUpdated;
                } catch(const std::exception& error) {
                    std::printf("Agent update to %s: could not install it (%s); retrying in 30 minutes.\n",m_offer.version.c_str(),error.what());std::fflush(stdout);
                    m_waitVersion=m_offer.version; m_stagedVersion.clear(); m_nextUpdateTry=Clock::now()+std::chrono::minutes(30);
                    startAi(); startGit();
                }
            }
            std::shared_lock<std::shared_mutex> tools(maintenance.gate,std::try_to_lock);
            if(!tools.owns_lock()){std::this_thread::sleep_for(std::chrono::seconds(1));continue;}
            auto accountTools=TryAgentToolUse();
            if(!accountTools){std::this_thread::sleep_for(std::chrono::seconds(1));continue;}
            auto claim=m_transport.Post("/claims",Json::object());
            if(claim.status==401||claim.status==403)throw std::runtime_error("Node credential revoked");
            if(!claim.Ok()) { accountTools.reset(); tools.unlock(); if(m_options.once)return 1; std::this_thread::sleep_for(std::chrono::seconds(5)); continue; }
            if(!claim.body.value("hasJob",false)) { accountTools.reset(); tools.unlock(); if(m_options.once)return 0; std::this_thread::sleep_for(std::chrono::seconds(3));continue; }
            const Json envelope=claim.body.at("envelope");
            if(envelope.value("protocolVersion",0)!=2 || envelope.value("workspaceId","")!=m_options.workspaceId)throw std::runtime_error("Invalid assignment identity or protocol");
            const Json lease=envelope.at("lease");
            if(lease.value("nodeId","")!=m_state.value("nodeId",""))throw std::runtime_error("Assignment belongs to another node");
            m_state["pending"]={{"lease",lease}}; Save(); // durable before any checkout or command
            auto result=Execute(envelope); m_state["pending"]["result"]=result; Save();
            if(!Complete())return 1;
            CleanJobDirs(m_root/"jobs",3);
            if(m_options.once)return !m_fenced && result.value("status","")=="success" ? 0:1;
        }
    }
private:
    std::string m_blender;   // FindBlender() at startup: builds get it as SMITH_BLENDER, and an exe step named "blender" runs it
    Options m_options; fs::path m_root,m_statePath; Json m_state; Transport m_transport; std::unique_ptr<HostedWorkspaceLock> m_lock; bool m_fenced=false;
    // The package the coordinator publishes for this OS, from the last accepted heartbeat.
    HostedUpdateOffer m_offer; bool m_hasOffer=false; std::string m_waitVersion,m_stagedVersion; Clock::time_point m_nextUpdateTry{};
    // Downloads and stages the offered package; true once it is ready to install and no chat is running.
    bool UpdateReady(const std::string& version,const fs::path& installDir,const std::atomic<int>& aiBusy,const std::atomic<int>& gitBusy) {
        if(!m_hasOffer || m_offer.version==version)return false;
        const std::string target=m_offer.version;
        if(target==m_waitVersion && Clock::now()<m_nextUpdateTry)return false;
        const auto later=[&](const std::string& why,int minutes){
            std::printf("Agent update to %s: %s.\n",target.c_str(),why.c_str());std::fflush(stdout);
            m_waitVersion=target; m_nextUpdateTry=Clock::now()+std::chrono::minutes(minutes); return false; };
        std::string reason;
        if(!HostedSelfUpdateEnabled(reason))return later("available, but this agent does not update itself ("+reason+")",24*60);
        if(HostedRejectedVersion(installDir.string())==target)return later("skipped, because it failed to start on this machine before",24*60);
        if(aiBusy>0||gitBusy>0)return false;   // a chat or a relayed git request is running; checked again on the next pass
        if(m_stagedVersion!=target) {
            std::printf("Updating this agent from %s to %s: downloading the package...\n",version.c_str(),target.c_str());std::fflush(stdout);
            const fs::path work=m_root/"update"; HostedSecureDirectory(work.string());
            const fs::path zip=work/"package.zip", staging=installDir/".update-staging"; std::error_code ec; fs::remove(zip,ec);
            struct Remove { fs::path path; ~Remove(){std::error_code e;fs::remove(path,e);} } removeZip{zip};
            const int status=m_transport.Download("/agent-package",zip,512LL*1024*1024,900);
            if(status!=200)return later(status==0?"could not download the package; retrying in 10 minutes":"the coordinator answered HTTP "+std::to_string(status)+" for the package; retrying in 10 minutes",10);
            if(!m_offer.sha256.empty()) {
                std::ifstream in(zip,std::ios::binary); std::string bytes((std::istreambuf_iterator<char>(in)),std::istreambuf_iterator<char>());
                if(HostedSha256(bytes)!=m_offer.sha256)return later("the download does not match the published checksum; retrying in 10 minutes",10);
            }
            const auto problem=HostedStagePackage(zip.string(),staging.string(),fs::path(HostedExecutablePath()).filename().string(),target);
            if(!problem.empty()){fs::remove_all(staging,ec);return later("not installed, "+problem+"; retrying in 30 minutes",30);}
            m_stagedVersion=target;
        }
        return aiBusy==0&&gitBusy==0;
    }
    void Save(){HostedSecureWrite(m_statePath.string(),m_state.dump());}
    bool Complete() {
        m_fenced=false;
        Json body=m_state.at("pending").at("lease"); body["result"]=m_state["pending"]["result"];
        for(int retry=0;retry<6;++retry) {
            auto response=m_transport.Post("/complete",body);
            if(response.Ok() && response.body.value("accepted",false)) { m_state.erase("pending");Save();return true; }
            if(response.status==409) { m_fenced=true;std::printf("Attempt is fenced; no stale completion was accepted.\n");m_state.erase("pending");Save();return true; }
            if(response.status==401||response.status==403)return false;
            if(response.status==400&&(body["result"].contains("scan")||body["result"].contains("failure")||body["result"].contains("commit")||body["result"].contains("host"))) {
                // A coordinator that predates repository projects (or refuses this report) rejects the
                // new fields: keep the outcome, drop them, and resend rather than retry the same 400 forever.
                for(const char* key:{"scan","failure","commit","host"})body["result"].erase(key);
                m_state["pending"]["result"]=body["result"];Save();
                std::printf("Coordinator refused the scan details; completing without them.\n");continue;
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        std::printf("Completion remains saved; restart the hosted agent to retry safely.\n");return false;
    }
    // A host job: copy a repository (with this machine's own Git login) into Smith's store as a bare mirror, give it
    // Smith's config and ref-policy hook, pick its default branch, and report its refs and size. Whichever machine
    // completes this becomes the repository's primary copy.
    // A project started in Smith has no source: the job first makes one commit in a scratch work tree (HostedGitInit.h),
    // from a README or from the zip it downloads with its lease, and copies that like any other source.
    template<class Run,class Log> Json HostJob(const JobSpec& spec,const Json& lease,const fs::path& job,Run& run,Log& log) {
        const auto& init=spec.host.init;
        RepoCheckout created; std::string workTree;
        if(!init.kind.empty()) {
            HostedGitInitRequest request{init.kind,init.name,init.archiveName,spec.host.defaultBranch,"",(job/"init").string()};
            HostedSecureDirectory(request.scratch);
            if(init.kind=="zip") {
                log(false,"Downloading "+(init.archiveName.empty()?std::string("the uploaded zip"):init.archiveName)+" ("+std::to_string(init.archiveSize/1024)+" KiB)");
                request.zipPath=(job/"init"/"upload.zip").string();
                const int status=m_transport.Download("/jobs/"+spec.jobId+"/import",request.zipPath,init.archiveSize,900,
                    {{"X-Smith-Attempt-Id",lease.value("attemptId","")},{"X-Smith-Lease-Token",lease.value("leaseToken","")}});
                if(status!=200)throw std::runtime_error(status==410?"The uploaded zip is no longer stored; start the project again with a new upload":"Could not download the uploaded zip (HTTP "+std::to_string(status)+")");
            }
            log(false,init.kind=="zip"?"Making the first commit from the zip's files":"Making the first commit");
            const auto problem=HostedGitInitWorkTree(request,[&](const std::vector<std::string>& argv,const std::string& cwd,const std::map<std::string,std::string>& env,std::vector<std::string>* errors){
                return run(argv,fs::path(cwd),900,env,nullptr,errors);
            },workTree);
            if(!problem.empty())throw std::runtime_error(problem);
            created.url=workTree; created.branch=spec.host.defaultBranch;
        }
        const auto& source=init.kind.empty()?spec.repos.at(0):created;
        const auto store=HostedGitStorePath(m_root.string(),m_options.workspaceId,spec.host.repoUuid);
        const fs::path hooks=m_root/"git"/"hooks"; HostedGitProvisionHooks(hooks.string());
        std::error_code ec;
        if(fs::exists(store,ec))throw std::runtime_error("This machine already keeps a copy with this id");
        const std::string temp=store+".tmp-"+spec.jobId;
        struct Cleanup { std::string path; bool keep=false; ~Cleanup(){ if(!keep){std::error_code e;fs::remove_all(path,e);fs::remove(path+".config",e);} } } cleanup{temp};
        fs::remove_all(temp,ec); fs::remove(temp+".config",ec); fs::create_directories(fs::path(store).parent_path(),ec);
        const std::map<std::string,std::string> promptOnly={{"GIT_TERMINAL_PROMPT","0"}};
        // A repository that starts in Smith: its source is Smith's own address, and there is nothing to copy yet.
        if(HostedSmithRemote(source.url)) {
            log(false,"Creating a new, empty repository in Smith's store on this machine");
            const auto made=HostedGitInitBare(temp,hooks.string());
            if(!made.empty())throw std::runtime_error("Could not create the repository: "+made);
            const std::string branch=spec.host.defaultBranch.empty()?"main":spec.host.defaultBranch;
            if(run({"git","--git-dir="+temp,"symbolic-ref","HEAD","refs/heads/"+branch},job,120,promptOnly)!=0)throw std::runtime_error("Could not set the repository's default branch");
            fs::rename(temp+".config",store+".config",ec); if(ec)throw std::runtime_error("Could not place the repository's config snapshot");
            fs::rename(temp,store,ec); if(ec){fs::remove(store+".config",ec);throw std::runtime_error("Could not place the repository in Smith's store");}
            cleanup.keep=true;
            log(false,"Created an empty repository; default branch "+branch);
            return {{"status","success"},{"exitCode",0},{"durationMs",0},{"message","Created a new, empty repository in Smith"},
                    {"host",{{"tips",Json::array()},{"peeled",Json::object()},{"defaultBranch",branch},{"bytes",0}}}};
        }
        log(false,init.kind.empty()?"Copying "+source.url+" into Smith's store on this machine":"Placing the new repository in Smith's store on this machine");
        std::vector<std::string> gitErrors;
        const auto cloneArgv=init.kind.empty()?std::vector<std::string>{"git","clone","--mirror","--",source.url,temp}:std::vector<std::string>{"git","clone","--mirror","--no-hardlinks","--",source.url,temp};
        if(run(cloneArgv,job,3600,init.kind.empty()?HostedGitAuthEnv(source.url,source.authToken):std::map<std::string,std::string>{{"GIT_TERMINAL_PROMPT","0"},{"GIT_CONFIG_NOSYSTEM","1"}},nullptr,&gitErrors)!=0){const auto reason=HostedGitFailureReason(gitErrors);throw GitFailure("Repository copy failed"+(reason.empty()?std::string():": "+reason),HostedClassifyGitFailure(gitErrors));}
        // The copy serves clients through the coordinator only; it keeps no link to where it came from.
        if(run({"git","--git-dir="+temp,"remote","remove","origin"},job,120,promptOnly)!=0)throw std::runtime_error("Could not detach the copy from its source");
        std::string error; int64_t bytes=0; std::map<std::string,std::string> peeled;
        const auto tips=HostedGitStoreTips(temp,bytes,error,&peeled);
        if(!error.empty())throw std::runtime_error("Could not read the copy's refs: "+error);
        if(spec.host.maxBytes>0&&bytes>spec.host.maxBytes)throw std::runtime_error("Repository is "+std::to_string(bytes/(1024*1024))+" MiB, over the "+std::to_string(spec.host.maxBytes/(1024*1024*1024))+" GiB limit for Smith's copies");
        const auto hasBranch=[&](const std::string& branch){for(const auto& tip:tips)if(tip.second=="refs/heads/"+branch)return true;return false;};
        std::string branch=spec.host.defaultBranch;
        if(branch.empty()||!hasBranch(branch)){
            std::vector<std::string> head;
            run({"git","--git-dir="+temp,"symbolic-ref","--short","HEAD"},job,120,promptOnly,&head,nullptr,true);
            branch=!head.empty()&&hasBranch(head[0])?head[0]:hasBranch(source.branch)?source.branch:"";
            if(branch.empty())for(const auto& tip:tips)if(tip.second.rfind("refs/heads/",0)==0){branch=tip.second.substr(11);break;}
            if(branch.empty())throw std::runtime_error("The repository has no branches to copy");
        }
        if(run({"git","--git-dir="+temp,"symbolic-ref","HEAD","refs/heads/"+branch},job,120,promptOnly)!=0)throw std::runtime_error("Could not set the copy's default branch");
        const auto configured=HostedGitInitStore(temp,hooks.string());
        if(!configured.empty())throw std::runtime_error("Could not configure the copy: "+configured);
        // Snapshot first, then the store: a crash between leaves a snapshot without a store, which is never served.
        fs::rename(temp+".config",store+".config",ec); if(ec)throw std::runtime_error("Could not place the copy's config snapshot");
        fs::rename(temp,store,ec); if(ec){fs::remove(store+".config",ec);throw std::runtime_error("Could not place the copy in Smith's store");}
        cleanup.keep=true;
        log(false,"Copied "+std::to_string(tips.size())+" refs ("+std::to_string(bytes/(1024*1024))+" MiB); default branch "+branch);
        return {{"status","success"},{"exitCode",0},{"durationMs",0},{"message",(init.kind.empty()?"Copied into Smith: ":"Created in Smith: ")+std::to_string(tips.size())+" refs, "+std::to_string(bytes/(1024*1024))+" MiB"},
                {"host",{{"tips",Json::parse(HostedGitTipsJson(tips))},{"peeled",Json::parse(HostedGitPeeledJson(peeled))},{"defaultBranch",branch},{"bytes",bytes}}}};
    }
    // An import job (HostedImport.h): spec §5 on this machine. The original history goes up in parts as the job's blob
    // under the lease before anything is rewritten; the completion carries the `import` report built from the outcome.
    template<class Run,class Log> Json ImportJob(const JobSpec& spec,const Json& lease,const fs::path& job,Run& run,Log& log) {
        HostedImportRequest request; request.source=spec.import.source; request.artifactsRemote=spec.import.artifactsRemote; request.artifactsToken=spec.import.artifactsToken;
        request.smithRemote=spec.import.smithRemote; request.lfsTicket=spec.lfs.authToken; request.scratch=(job/"import").string(); request.thresholdBytes=spec.import.thresholdBytes; request.maxRepoBytes=spec.import.maxRepoBytes;
        HostedSecureDirectory(request.scratch);
        const std::map<std::string,std::string> leaseHeaders={{"X-Smith-Attempt-Id",lease.value("attemptId","")},{"X-Smith-Lease-Token",lease.value("leaseToken","")}};
        const std::string blobRoute="/jobs/"+spec.jobId+"/blobs/"+spec.import.originalBlob;
        auto upload=[&](const std::string& path,int64_t size,std::string& sha256){
            sha256=HostedSha256File(path); if(sha256.empty())return false;
            std::ifstream in(path,std::ios::binary); if(!in)return false;
            log(false,"Storing the original history ("+std::to_string(size/1024)+" KiB)");
            int part=0; int64_t remaining=size;
            while(remaining>0){
                const auto want=(size_t)std::min<int64_t>(5*1024*1024,remaining); std::string chunk(want,'\0'); in.read(&chunk[0],(std::streamsize)want); chunk.resize((size_t)in.gcount()); if(chunk.empty())return false;
                ++part; bool stored=false;
                for(int attempt=0;attempt<3;++attempt){
                    const auto r=m_transport.PostBytes(blobRoute+"?part="+std::to_string(part),chunk,"application/octet-stream",leaseHeaders,300,1024*1024);
                    if(r.Ok()&&r.body.value("accepted",false)){stored=true;break;}
                    if(r.status>=400&&r.status<500)break;
                    std::this_thread::sleep_for(std::chrono::seconds(2));
                }
                if(!stored)return false; remaining-=(int64_t)chunk.size();
            }
            const auto done=m_transport.PostBytes(blobRoute+"/complete",Json{{"size",size},{"sha256",sha256}}.dump(),"application/json",leaseHeaders,300,1024*1024);
            return done.Ok()&&done.body.value("accepted",false);
        };
        const bool lfs=run({"git","lfs","version"},job,60,{{"GIT_TERMINAL_PROMPT","0"}},nullptr,nullptr,true)==0;
        if(!lfs)log(true,"git-lfs is not installed on this machine: files over the threshold cannot be moved to large files");
        const auto outcome=RunHostedImport(request,[&](const std::vector<std::string>& argv,const std::string& cwd,const std::map<std::string,std::string>& env,std::vector<std::string>* out,std::vector<std::string>* errors,const std::string& stdoutFile){
            return run(argv,fs::path(cwd),3600,env,out,errors,out!=nullptr,stdoutFile); },[&](const std::string& line){log(false,line);},upload,lfs);
        Json result={{"status",outcome.ok?"success":"failed"},{"exitCode",outcome.ok?0:1},{"durationMs",0},{"message",outcome.message}};
        if(!outcome.failure.empty())result["failure"]=outcome.failure;
        if(outcome.ok){result["commit"]=outcome.outcome.commit;result["import"]=Json::parse(HostedImportReportJson(outcome.outcome));}
        else log(true,outcome.message);
        std::error_code ec; fs::remove_all(request.scratch,ec);
        return result;
    }
    Json Execute(const Json& envelope) {
        const auto started=Clock::now(); Json result=InterruptedResult();
        JobSpec spec; if(!FromJson(envelope.at("spec").dump(),spec)) { result["message"]="Invalid job specification";return result; }
        if(spec.jobId!=envelope.at("lease").value("jobId","")){result["message"]="Assignment job identity mismatch";return result;}
        const auto invalid=ValidateHostedSpec(spec); if(!invalid.empty()){result["message"]=invalid;return result;}
        const Json lease=envelope.at("lease");
        std::atomic<bool> stop{false},renewStop{false},lost{false},loggingDisabled{false};
        std::mutex processMutex,queueMutex; Process* active=nullptr;
        std::deque<std::pair<bool,std::string>> queue; size_t queuedBytes=0;
        auto lose=[&](){lost=true;std::lock_guard<std::mutex> lock(processMutex);if(active)active->Kill();};
        // Every credential this attempt holds is scrubbed from forwarded + printed output:
        // the node token, any Artifacts repo token, and the mirror push token.
        std::vector<std::string> secrets={m_transport.token};
        for(const auto& repo:spec.repos)if(!repo.authToken.empty())secrets.push_back(repo.authToken);
        if(!spec.mirror.authToken.empty())secrets.push_back(spec.mirror.authToken);
        if(!spec.lfs.authToken.empty())secrets.push_back(spec.lfs.authToken);
        if(!spec.import.artifactsToken.empty())secrets.push_back(spec.import.artifactsToken);
        auto log=[&](bool error,const std::string& raw){
            std::string line=raw.substr(0,1000);
            for(const auto& secret:secrets){size_t position=0;while((position=line.find(secret,position))!=std::string::npos){line.replace(position,secret.size(),"[redacted]");position+=10;}}
            std::printf("%s\n",line.c_str());
            if(loggingDisabled)return;
            std::lock_guard<std::mutex> lock(queueMutex);
            if(queuedBytes+line.size()>1024*1024){loggingDisabled=true;std::printf("Hosted log backlog limit reached; forwarding stopped.\n");queue.clear();queuedBytes=0;return;}
            queuedBytes+=line.size();queue.emplace_back(error,std::move(line));
        };
        const auto initialRemaining=lease.at("leaseExpiresAt").get<int64_t>()-NowMillis();
        auto steadyMillis=[](){return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();};
        std::atomic<int64_t> safeUntil{steadyMillis()+std::max<int64_t>(0,initialRemaining-5000)};
        std::thread watchdog([&](){while(!renewStop&&!lost){if(steadyMillis()>=safeUntil){lose();break;}std::this_thread::sleep_for(std::chrono::milliseconds(100));}});
        std::thread renew([&](){
            try {
                auto deadline=Clock::now()+std::chrono::milliseconds(std::max<int64_t>(0,initialRemaining-5000));
                auto next=Clock::now();
                while(!renewStop) {
                    if(Clock::now()>=deadline){lose();break;}
                    if(Clock::now()>=next) {
                        auto response=m_transport.Post("/renew",lease);
                        if(response.status==401||response.status==403||response.status==409||(response.Ok()&&response.body.value("cancelled",false))){lose();break;}
                        if(response.Ok()) { const auto remaining=response.body.at("leaseExpiresAt").get<int64_t>()-NowMillis()-5000;deadline=Clock::now()+std::chrono::milliseconds(std::max<int64_t>(0,remaining));safeUntil=steadyMillis()+std::max<int64_t>(0,remaining); }
                        next=Clock::now()+std::chrono::seconds(response.Ok()?20:2);
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            } catch(...) {lose();}
        });
        std::thread logs([&](){
            try {
                int64_t seq=0; Json batch; size_t count=0;
                while(!lost&&!loggingDisabled) {
                    if(batch.is_null()) {
                        std::lock_guard<std::mutex> lock(queueMutex);
                        if(queue.empty()){if(stop)break;}
                        else {
                            batch=lease;batch["seq"]=seq;batch["stream"]=queue.front().first?"stderr":"stdout";batch["lines"]=Json::array();count=0;
                            const bool stream=queue.front().first;
                            for(const auto& entry:queue){if(count>=32||entry.first!=stream)break;batch["lines"].push_back(entry.second);if(batch.dump(-1,' ',false,Json::error_handler_t::replace).size()>8000){batch["lines"].erase(count);break;}++count;}
                        }
                    }
                    if(!batch.is_null()) {
                        auto response=m_transport.Post("/logs",batch);
                        if(response.status==401||response.status==403||response.status==409){lose();break;}
                        if(response.status==413){loggingDisabled=true;std::printf("Hosted log storage limit reached; forwarding stopped.\n");break;}
                        if(response.Ok()&&response.body.value("accepted",false)) {
                            std::lock_guard<std::mutex> lock(queueMutex);
                            for(size_t i=0;i<count&&!queue.empty();++i){queuedBytes-=queue.front().second.size();queue.pop_front();}
                            seq=response.body.at("nextSeq").get<int64_t>();batch=nullptr;
                        } else if(stop)break; // completion persists even if final log upload is unavailable
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(250));
                }
            }catch(...){loggingDisabled=true;}
        });
        // capture (optional) receives stdout lines verbatim (unredacted) for commands whose output the
        // agent must parse; errors (optional) receives stderr lines the same way. Every line still
        // streams through log, except captured stdout when quiet (file lists, smith.json).
        auto run=[&](std::vector<std::string> argv,const fs::path& cwd,int timeout,const std::map<std::string,std::string>& env,std::vector<std::string>* capture=nullptr,std::vector<std::string>* errors=nullptr,bool quiet=false,const std::string& stdoutFile=std::string()){
            if (spec.kind == "checkin") {
                const auto remaining = 60 - std::chrono::duration_cast<std::chrono::seconds>(Clock::now() - started).count();
                if (remaining <= 0) return -1;
                timeout = static_cast<int>(std::min<int64_t>(timeout, remaining));
            }
            Process process; ProcessOptions options;options.argv=std::move(argv);options.workingDir=cwd.string();options.timeoutSeconds=timeout;options.envOverride=env;options.stdoutFile=stdoutFile;
            size_t capturedBytes = 0; bool captureOverflow = false;
            options.stopWithParent=true;   // crash containment: no orphaned build if this agent dies
            auto sink=[&](bool error,const std::string& line){
                if(capture&&!error) {
                    capturedBytes += line.size();
                    if (spec.kind == "checkin" && capturedBytes > 10 * 1024 * 1024) captureOverflow = true;
                    else if(capture->size()<100000) capture->push_back(line);
                    else captureOverflow = true;
                }
                if(errors&&error&&errors->size()<1000)errors->push_back(line);
                if(!(quiet&&capture&&!error))log(error,line);
            };
            {std::lock_guard<std::mutex> lock(processMutex);if(lost)return -1;if(!process.Start(options,sink))return -1;active=&process;}
            int rc=process.Wait();{std::lock_guard<std::mutex> lock(processMutex);active=nullptr;}return captureOverflow ? -1 : rc;
        };
        // Uploads the files the job declares (spec.artifacts.globs), relative to `cwd`.
        auto upload=[&](const fs::path& cwd){
            for(const auto& path:spec.artifacts.globs) {
                if(lost)throw std::runtime_error("Lease lost before artifact upload");
                const auto bytes=HostedReadArtifact(cwd.string(),path,20*1024*1024);
                const auto digest=HostedSha256(bytes);
                std::string normalized=path;std::replace(normalized.begin(),normalized.end(),'\\','/');
                const auto name=normalized.substr(normalized.find_last_of('/')+1);
                log(false,"Uploading artifact "+name+" ("+std::to_string(bytes.size())+" bytes, SHA256 "+digest+")");
                bool accepted=false;
                for(int attempt=0;attempt<3&&!lost;++attempt) {
                    const auto response=m_transport.Upload(lease,name,bytes,digest,lost);
                    if(response.Ok()) {
                        accepted=response.body.value("accepted",false)&&response.body.value("sha256","")==digest&&response.body.value("name","")==name;
                        break;
                    }
                    if(response.status==401||response.status==403||response.status==409){lose();break;}
                    if(response.status>=400&&response.status<500)break;
                    if(!lost)std::this_thread::sleep_for(std::chrono::seconds(1));
                }
                if(!accepted)throw std::runtime_error("Artifact upload failed or its acknowledgement did not match: "+name);
                log(false,"Artifact acknowledged: "+name);
            }
        };
        try {
            auto jobs=m_root/"jobs";HostedSecureDirectory(jobs.string());auto job=jobs/MakeUuid();HostedSecureDirectory(job.string());
            auto primary=job;
            // Git for the shared repository store (HostedRepoCache.h): the same streaming runner, with a fetch's timeout.
            const HostedGitRunFn cacheGit=[&](std::vector<std::string> argv,const fs::path& cwd,const std::map<std::string,std::string>& env,std::vector<std::string>* out,std::vector<std::string>* errors){
                return run(std::move(argv),cwd,1800,env,out,errors,out!=nullptr);
            };
            if(spec.kind=="host")result=HostJob(spec,lease,job,run,log); else if(spec.kind=="import")result=ImportJob(spec,lease,job,run,log); else {
            for(size_t i=0;i<spec.repos.size()&&!lost;++i) {
                const auto& repo=spec.repos[i];auto checkout=Contained(job,repo.checkoutDir);
                fs::create_directories(checkout.parent_path());
                if (spec.kind == "checkin") {
                    auto environment = HostedGitAuthEnv(repo.url, repo.authToken);
                    const auto config = job / "metadata.gitconfig"; HostedSecureWrite(config.string(), "");
                    environment["GIT_CONFIG_GLOBAL"] = config.string(); environment["GIT_CONFIG_NOSYSTEM"] = "1";
                    auto git = [&](std::vector<std::string> args, std::vector<std::string>* out = nullptr) {
                        auto argv = HostedAiGitArgv(args, (job / "no-hooks").string());
                        argv.insert(argv.begin() + 1, {"-c", "init.templateDir=", "-c", "protocol.file.allow=never"});
                        return run(argv, checkout, 60, environment, out, nullptr, true);
                    };
                    fs::create_directories(checkout); primary = checkout;
                    if (git({"init", "-q"}) != 0) throw std::runtime_error("Metadata repository initialization failed");
                    for (const auto& sha : {spec.checkIn.baseCommit, spec.checkIn.headCommit}) {
                        if (git({"fetch", "-q", "--no-tags", "--depth=256", repo.url, sha}) != 0) throw std::runtime_error("Pinned metadata commit unavailable");
                        std::vector<std::string> resolved;
                        if (git({"rev-parse", "--verify", sha + "^{commit}"}, &resolved) != 0 || resolved.size() != 1 || resolved[0] != sha) throw std::runtime_error("Pinned metadata commit mismatch");
                    }
                    std::vector<std::string> output;
                    if (git({"diff", "--no-ext-diff", "--no-textconv", "--numstat", "-M", "-z", spec.checkIn.baseCommit, spec.checkIn.headCommit, "--"}, &output) != 0) throw std::runtime_error("Complete metadata diff unavailable");
                    std::string raw; for (size_t n = 0; n < output.size(); ++n) { if (n) raw += '\n'; raw += output[n]; }
                    const auto ancestor = git({"merge-base", "--is-ancestor", spec.checkIn.baseCommit, spec.checkIn.headCommit});
                    if (ancestor != 0 && ancestor != 1) throw std::runtime_error("Metadata ancestry unavailable");
                    auto report = Json::parse(HostedCheckInReport(spec.checkIn.eventId, spec.checkIn.baseCommit, spec.checkIn.headCommit, raw, ancestor == 0));
                    if (ancestor == 1 && fs::exists(checkout / ".git" / "shallow")) report["complete"] = false;
                    result = {{"status", "success"}, {"exitCode", 0}, {"durationMs", 0}, {"message", "Read pinned check-in metadata"}, {"checkIn", report}};
                    continue;
                }
                // Scans and resolving builds may leave the commit empty and take the branch tip (ValidateHostedSpec allows nothing else).
                const bool tip=repo.commit.empty();
                log(false,"Repository URL: "+repo.url);
                log(false,"Requested branch: "+(repo.branch.empty()?std::string("(not specified)"):repo.branch));
                log(false,"Pinned commit: "+(tip?std::string("(branch tip)"):repo.commit));
                // Prompt-only env for GitHub/SSH sources; an Artifacts source additionally gets its
                // repo token as an Authorization header scoped to that origin (never argv/.git/config).
                // Large files (Git LFS): lfs.url + the ticket header ride the same env, so the checkout smudges pointers from Smith.
                const auto gitEnv=HostedLfsEnv(spec,HostedGitAuthEnv(repo.url,repo.authToken));
                const std::map<std::string,std::string> promptOnly={{"GIT_TERMINAL_PROMPT","0"}};
                // The coordinator may name the copy this machine keeps of a Smith-hosted repository: clone from it
                // (no network, no ticket) when it is intact and holds the expected commit, else go through the coordinator.
                bool local=false;
                if(!repo.hostedUuid.empty()){
                    const auto store=HostedGitStorePath(m_root.string(),m_options.workspaceId,repo.hostedUuid); std::error_code ec;
                    if(fs::is_directory(store,ec)&&HostedGitStoreTrusted(store)){
                        log(false,"Cloning from this machine's copy of the repository");
                        std::vector<std::string> localClone={"git","clone","--no-checkout","--no-hardlinks"};
                        if(tip&&!repo.branch.empty())localClone.insert(localClone.end(),{"--branch",repo.branch});
                        localClone.insert(localClone.end(),{"--",store,checkout.string()});
                        local=run(localClone,job,1800,promptOnly)==0;
                        if(local&&!repo.tip.empty()){std::vector<std::string> seen;local=run({"git","rev-parse","--verify","--quiet",repo.tip+"^{commit}"},checkout,120,promptOnly,&seen,nullptr,true)==0;}
                        if(!local){log(true,"The local copy could not be used; cloning through the coordinator instead");fs::remove_all(checkout,ec);}
                    } else log(false,"This machine's copy is missing or altered; cloning through the coordinator");
                }
                std::vector<std::string> gitErrors;
                auto gitFailure=[&](const std::string& what){const auto reason=HostedGitFailureReason(gitErrors);return GitFailure(what+(reason.empty()?std::string():": "+reason),HostedClassifyGitFailure(gitErrors));};
                if(!local&&spec.kind=="scan"&&!HostedRepoCacheExists(m_root,repo.url)){
                    // A first look at a repository needs only its tree and smith.json: a shallow clone without
                    // file contents, cheaper than filling the shared store for a project that may never build.
                    std::vector<std::string> clone={"git","clone","--no-checkout","--depth","1","--filter=blob:none"};
                    if(!repo.branch.empty())clone.insert(clone.end(),{"--branch",repo.branch});
                    clone.insert(clone.end(),{"--",repo.url,checkout.string()});
                    if(run(clone,job,1800,gitEnv,nullptr,&gitErrors)!=0)throw gitFailure("Repository clone failed");
                } else if(!local){
                    // One object store per repository on this machine (keyed by the URL alone), shared by every
                    // workspace, project, job and chat that uses it: the remote - GitHub, Artifacts or the
                    // coordinator's relay of a Smith-hosted repository this machine keeps no copy of - is fetched
                    // for what changed, and the job's checkout is a local clone whose objects are hard links into it.
                    const auto cache=HostedRepoCachePath(m_root,repo.url);
                    const auto lock=HostedLockRepoCache(cache);
                    log(false,std::string(HostedRepoCacheExists(m_root,repo.url)?"Updating":"Creating")+" this machine's shared copy of the repository");
                    if(!HostedUpdateRepoCache(cache,repo.url,tip?std::string():repo.commit,gitEnv,cacheGit,&gitErrors))throw gitFailure("Repository fetch failed");
                    if(!HostedCloneFromRepoCache(cache,repo.url,tip?repo.branch:std::string(),checkout,cacheGit,&gitErrors))throw gitFailure("Repository clone failed");
                }
                if(i==0)primary=checkout;
                if(spec.kind=="scan")continue;
                if(tip){
                    // --branch made the requested branch (or, without one, the remote's default) the clone's HEAD; a local
                    // copy is pinned to the tip the coordinator recorded, so the build matches what it expects.
                    if(spec.kind=="mirror"){
                        // A Pull or Push of the branch tip: objects and tags, no working tree.
                        if(run({"git","fetch","origin","--tags"},checkout,1800,gitEnv)!=0)throw std::runtime_error("Tag fetch failed");
                        continue;
                    }
                    if(run({"git","checkout","--detach",local&&!repo.tip.empty()?repo.tip:std::string("HEAD")},checkout,1800,gitEnv)!=0)throw std::runtime_error("Branch checkout failed");
                } else {
                    if(!local&&run({"git","fetch","origin",repo.commit},checkout,1800,gitEnv)!=0)throw std::runtime_error("Pinned commit fetch failed");
                    if(spec.kind=="mirror"){
                        // A copy wants the tags too; the submodule step is skipped (a mirror pushes objects, not a tree).
                        if(run({"git","fetch","origin","--tags"},checkout,1800,gitEnv)!=0)throw std::runtime_error("Tag fetch failed");
                        continue;
                    }
                    if(HostedPullKind(spec.kind))continue;   // a pull request job checks out what it needs itself
                    if(run({"git","checkout","--detach",repo.commit},checkout,1800,gitEnv)!=0)throw std::runtime_error("Pinned commit checkout failed");
                }
                if(run({"git","submodule","update","--init","--recursive"},checkout,1800,promptOnly)!=0)throw std::runtime_error("Submodule checkout failed");
            }
            // The commit the checkout landed on, for scans and resolving builds (a branch tip, or a
            // chat's pinned Verify commit): reported with the result and to /resolve.
            std::string commit;
            if(!spec.repos.empty()&&(spec.repos[0].commit.empty()||!spec.resolve.action.empty())&&!lost){
                std::vector<std::string> lines;
                if(run({"git","rev-parse","HEAD"},primary,120,{{"GIT_TERMINAL_PROMPT","0"}},&lines)!=0||lines.empty())throw std::runtime_error("Could not read the checked-out commit");
                commit=lines[0];
                log(false,"Checked out "+(spec.repos[0].branch.empty()?std::string("the default branch"):spec.repos[0].branch)+" @ "+commit.substr(0,12));
            }
            // smith.json and the tracked paths at HEAD, captured quietly so they never flood the build log.
            auto scanReport=[&](){
                const auto gitEnv=HostedLfsEnv(spec,HostedGitAuthEnv(spec.repos[0].url,spec.repos[0].authToken));
                std::vector<std::string> branchLines,paths,smith;
                std::string branch=spec.repos[0].branch;
                if(branch.empty()&&run({"git","rev-parse","--abbrev-ref","HEAD"},primary,120,gitEnv,&branchLines)==0&&!branchLines.empty()&&branchLines[0]!="HEAD")branch=branchLines[0];
                if(run({"git","-c","core.quotepath=false","ls-tree","-r","--name-only","HEAD"},primary,600,gitEnv,&paths,nullptr,true)!=0)throw std::runtime_error("Could not list the repository's files");
                const bool hasSmithJson=std::find(paths.begin(),paths.end(),"smith.json")!=paths.end();
                if(hasSmithJson&&run({"git","show","HEAD:smith.json"},primary,600,gitEnv,&smith,nullptr,true)!=0)throw std::runtime_error("Could not read smith.json");
                std::string text;for(const auto& line:smith){text+=line;text+='\n';}
                log(false,hasSmithJson?"Read smith.json and "+std::to_string(paths.size())+" paths":"No smith.json at this commit");
                return HostedScanReport(commit,branch,hasSmithJson,text,paths);
            };
            if(spec.kind=="checkin"){
                // Metadata was computed without checking out files or running repository commands.
            } else if(spec.kind=="scan"){
                result={{"status","success"},{"exitCode",0},{"durationMs",0},{"message","Read smith.json at "+commit.substr(0,12)},{"commit",commit},{"scan",Json::parse(scanReport())}};
            } else if(spec.kind=="mirror"){
                // Copy the pinned commit or branch tip (as <branch>) + tags to the target: Cloudflare Artifacts
                // with its write token, or a project's linked repository with this machine's own Git login.
                // Never forced, so a branch that moved on the target is refused rather than overwritten.
                // Artifacts limits are enforced up front so a doomed push fails with a reason, not a server error.
                const auto& source=spec.repos.at(0); const auto& target=spec.mirror;
                const std::string pushed=source.commit.empty()?commit:source.commit;
                const std::map<std::string,std::string> promptOnly={{"GIT_TERMINAL_PROMPT","0"}};
                std::vector<std::string> lines;
                if(pushed.empty())throw std::runtime_error("Could not read the commit to push");
                if(HostedArtifactsRemote(target.remote)){
                    if(run({"git","count-objects","-v"},primary,120,promptOnly,&lines)!=0)throw std::runtime_error("Repository size check failed");
                    int64_t kib=0;
                    for(const auto& line:lines){const auto colon=line.find(':');if(colon==std::string::npos)continue;const auto key=line.substr(0,colon);if(key=="size"||key=="size-pack")kib+=std::strtoll(line.c_str()+colon+1,nullptr,10);}
                    if(kib>(int64_t)1024*1024)throw std::runtime_error("Repository is "+std::to_string(kib/1024)+" MiB, over the Artifacts 1 GB repository limit");
                    lines.clear();
                    if(run({"git","rev-list","--objects","--filter=blob:limit=32m","--filter-print-omitted",pushed},primary,600,promptOnly,&lines)!=0)throw std::runtime_error("Repository blob check failed");
                    std::vector<std::string> oversized; for(const auto& line:lines)if(!line.empty()&&line[0]=='~')oversized.push_back(line.substr(1,12));
                    if(!oversized.empty()){std::string msg=std::to_string(oversized.size())+" blob(s) exceed the Artifacts 32 MB limit:";for(size_t i=0;i<oversized.size()&&i<5;++i)msg+=" "+oversized[i];throw std::runtime_error(msg);}
                }
                // No token: the machine's own Git login, with no prompt and no Credential Manager window either.
                auto pushEnv=HostedGitAuthEnv(target.remote,target.authToken);
                if(target.authToken.empty())pushEnv["GCM_INTERACTIVE"]="never";
                log(false,(target.allRefs?"Pushing every branch and tag, "+pushed+" as "+target.branch:"Pushing "+pushed+" as "+target.branch)+" to "+target.remote);
                std::vector<std::string> pushErrors;
                if(target.allRefs){
                    // Move to storage: every branch the copy's origin (this machine's copy, or the shared store, which fetches them all) knows,
                    // then the tags below; the pinned branch is among them and is verified like any other mirror.
                    if(run({"git","fetch","-q","origin","+refs/heads/*:refs/remotes/origin/*"},primary,1800,promptOnly,nullptr,&pushErrors)!=0)throw std::runtime_error("Could not fetch every branch"+(HostedGitFailureReason(pushErrors).empty()?std::string():": "+HostedGitFailureReason(pushErrors)));
                    pushErrors.clear();
                    if(run({"git","push","--progress","--",target.remote,"refs/remotes/origin/*:refs/heads/*"},primary,1800,pushEnv,nullptr,&pushErrors)!=0)throw std::runtime_error(HostedPushFailure(target.remote,pushErrors));
                } else if(run({"git","push","--progress","--",target.remote,pushed+":refs/heads/"+target.branch},primary,1800,pushEnv,nullptr,&pushErrors)!=0)throw std::runtime_error(HostedPushFailure(target.remote,pushErrors));
                pushErrors.clear();
                if(target.pushTags&&run({"git","push","--progress","--tags","--",target.remote},primary,1800,pushEnv,nullptr,&pushErrors)!=0){const auto reason=HostedGitFailureReason(pushErrors);throw std::runtime_error("Tag push to "+target.remote+" failed"+(reason.empty()?std::string():": "+reason));}
                lines.clear();
                if(run({"git","ls-remote","--",target.remote,"refs/heads/"+target.branch},primary,120,pushEnv,&lines)!=0)throw std::runtime_error("Could not verify the pushed branch");
                bool verified=false; for(const auto& line:lines)if(line.rfind(pushed,0)==0)verified=true;
                if(!verified)throw std::runtime_error("The pushed branch head does not match the pushed commit");
                result={{"status","success"},{"exitCode",0},{"durationMs",0},{"message","Pushed "+pushed+" to "+target.remote}};
                if(source.commit.empty())result["commit"]=pushed;   // a branch tip: the coordinator confirms what landed
                log(false,"Push verified");
            } else if(HostedPullKind(spec.kind)){
                // Smith's own pull requests (HostedPull.h). The head commit was fetched above; the base branch's tip is fetched
                // now, so a diff compares with, and a merge lands on, where that branch is at this moment.
                const auto& repo=spec.repos.at(0); const auto& pull=spec.pull; const auto& head=repo.commit;
                auto gitEnv=HostedGitAuthEnv(repo.url,repo.authToken);
                if(repo.authToken.empty())gitEnv["GCM_INTERACTIVE"]="never";   // the machine's own login: no prompt, no Credential Manager window
                const std::map<std::string,std::string> promptOnly={{"GIT_TERMINAL_PROMPT","0"}};
                auto firstLine=[&](std::vector<std::string> argv,const std::string& what){std::vector<std::string> lines;if(run(std::move(argv),primary,600,promptOnly,&lines,nullptr,true)!=0||lines.empty())throw std::runtime_error(what);return lines[0];};
                if(spec.kind=="publish"){
                    // With this machine's own Git login: no Smith token goes to another host.
                    log(false,"Publishing "+head.substr(0,12)+" as "+pull.targetBranch+" to "+pull.targetRemote);
                    std::vector<std::string> errors;
                    const std::map<std::string,std::string> ownLogin={{"GIT_TERMINAL_PROMPT","0"},{"GCM_INTERACTIVE","never"}};
                    if(run({"git","push","--no-verify","--",pull.targetRemote,head+":refs/heads/"+pull.targetBranch},primary,1800,ownLogin,nullptr,&errors)!=0)
                        throw std::runtime_error(HostedPushFailure(pull.targetRemote,errors)+" (this machine pushes with its own Git login)");
                    result={{"status","success"},{"exitCode",0},{"durationMs",0},{"message","Published "+pull.targetBranch+" at "+head.substr(0,12)},{"commit",head}};
                } else {
                    if(run({"git","fetch","origin","refs/heads/"+pull.baseBranch},primary,1800,gitEnv)!=0)throw std::runtime_error("Could not fetch the base branch "+pull.baseBranch);
                    const auto base=firstLine({"git","rev-parse","FETCH_HEAD"},"Could not read the base branch's commit");
                    if(spec.kind=="diff"){
                        std::vector<std::string> lines;
                        const std::string mergeBase=run({"git","merge-base",base,head},primary,600,promptOnly,&lines,nullptr,true)==0&&!lines.empty()?lines[0]:std::string();
                        const auto from=mergeBase.empty()?base:mergeBase;
                        std::vector<std::string> numstat;
                        if(run({"git","-c","core.quotepath=false","diff","--numstat","--find-renames",from,head},primary,600,promptOnly,&numstat,nullptr,true)!=0)throw std::runtime_error("Could not list the changed files");
                        const auto raw=job/"diff.raw";
                        if(run({"git","-c","core.quotepath=false","diff","--no-color","--no-ext-diff","--find-renames","--output="+raw.string(),from,head},primary,600,promptOnly)!=0)throw std::runtime_error("Could not compute the diff");
                        std::string diff;
                        { std::ifstream in(raw,std::ios::binary); std::vector<char> buffer(8*1024*1024+1); in.read(buffer.data(),static_cast<std::streamsize>(buffer.size())); diff.assign(buffer.data(),static_cast<size_t>(in.gcount())); }
                        const auto patch=HostedPullPatchText(mergeBase,head,diff,8*1024*1024);
                        HostedSecureWrite((job/kHostedPullPatch).string(),patch.text);
                        HostedSecureWrite((job/kHostedPullFiles).string(),HostedPullFilesText(mergeBase,head,numstat));
                        lines.clear();
                        const int mergeTree=run({"git","merge-tree","--write-tree","--name-only","--no-messages",base,head},primary,600,promptOnly,&lines,nullptr,true);
                        const auto check=HostedParseMergeTree(mergeTree,lines);
                        upload(job);
                        Json conflicts=Json::array(); for(const auto& path:check.conflicts)conflicts.push_back(path);
                        const std::string summary=std::to_string(numstat.size())+" file(s) changed"+(check.mergeable==1?", merges cleanly into ":check.mergeable==0?", conflicts with ":", compared with ")+pull.baseBranch;
                        result={{"status","success"},{"exitCode",0},{"durationMs",0},{"message",summary},{"commit",head},
                            {"pull",{{"baseCommit",base},{"mergeBase",mergeBase.empty()?Json(nullptr):Json(mergeBase)},{"mergeable",check.mergeable<0?Json(nullptr):Json(check.mergeable==1)},{"conflicts",conflicts},{"truncated",patch.truncated}}}};
                        log(false,summary);
                    } else {
                        // The merge commit is made on the base branch's tip and pushed without force: had the branch moved
                        // since, the push is refused and nothing changes.
                        if(run({"git","checkout","--detach",base},primary,1800,promptOnly)!=0)throw std::runtime_error("Could not check out "+pull.baseBranch);
                        if(run(HostedPullMergeArgs(pull,head),primary,1800,promptOnly)!=0){
                            run({"git","merge","--abort"},primary,120,promptOnly);
                            throw std::runtime_error("The branch no longer merges cleanly into "+pull.baseBranch+"; resolve the conflicts on the branch, then merge again");
                        }
                        const auto merged=firstLine({"git","rev-parse","HEAD"},"Could not read the merge commit");
                        log(false,"Pushing the merge "+merged.substr(0,12)+" to "+pull.baseBranch);
                        std::vector<std::string> errors;
                        if(run({"git","push","--no-verify","--",repo.url,"HEAD:refs/heads/"+pull.baseBranch},primary,1800,gitEnv,nullptr,&errors)!=0)
                            throw std::runtime_error(HostedPushFailure(repo.url,errors)+"; if "+pull.baseBranch+" moved since, merge again");
                        result={{"status","success"},{"exitCode",0},{"durationMs",0},{"message","Merged into "+pull.baseBranch+" at "+merged.substr(0,12)},{"commit",merged},{"pull",{{"baseCommit",base}}}};
                        log(false,"Merged into "+pull.baseBranch+".");
                    }
                }
            } else {
            if(!spec.resolve.action.empty()&&!lost){
                // Ask the coordinator what smith.json says to run for this action at this commit.
                Json request=lease; request["report"]=Json::parse(scanReport());
                Response response;
                for(int attempt=0;attempt<3;++attempt){response=m_transport.Post("/resolve",request);if(response.status!=0&&response.status<500)break;std::this_thread::sleep_for(std::chrono::seconds(2));}
                if(response.status==401||response.status==403||response.status==409){lose();throw std::runtime_error("Lease lost while resolving the build action");}
                if(!response.Ok()){
                    const auto reason=response.body.contains("error")&&response.body.at("error").is_object()?response.body.at("error").value("message",std::string()):std::string();
                    throw std::runtime_error(reason.empty()?"The coordinator could not resolve this build action ("+std::to_string(response.status)+")":reason);
                }
                JobSpec resolved;
                if(!response.body.contains("spec")||!FromJson(response.body.at("spec").dump(),resolved)||resolved.jobId!=spec.jobId||!resolved.resolve.action.empty())throw std::runtime_error("The coordinator returned an invalid build specification");
                const auto refused=ValidateHostedSpec(resolved); if(!refused.empty())throw std::runtime_error(refused);
                log(false,"Build action "+spec.resolve.action+" resolved at "+commit.substr(0,12));
                spec=resolved;
            }
            const auto cwd=Contained(primary,spec.workingDir);
            auto commands=spec.steps.empty()?std::vector<CommandSpec>{spec.command}:spec.steps;
            auto env=spec.env;
            if(!m_blender.empty()){
                // Blender is usually not on PATH: tell scripts where it is, and run a bare "blender" exe step with it.
                env.emplace("SMITH_BLENDER",m_blender);
                for(auto& command:commands)if(command.interpreter=="exe"&&command.script=="blender")command.script=m_blender;
            }
            int rc=-1;bool success=false;
            for(size_t i=0;i<commands.size()&&!lost;++i) {
                const auto& command=commands[i];
                if(command.interpreter!="exe" || !fs::path(command.script).is_absolute())Contained(cwd,command.script);
                log(false,"Running build step "+std::to_string(i+1)+"/"+std::to_string(commands.size()));
                rc=run(HostedCommandArgv(command,cwd.string()),cwd,spec.timeoutSeconds,env);
                success=spec.successExitCodes.empty()?rc==0:std::find(spec.successExitCodes.begin(),spec.successExitCodes.end(),rc)!=spec.successExitCodes.end();
                if(!success)break;
            }
            if(success&&!lost)upload(cwd);
            result={{"status",success?"success":"failed"},{"exitCode",rc},{"durationMs",0},{"message",success?"Build completed":"Build command failed"}};
            if(!commit.empty())result["commit"]=commit;
            log(!success,"Build process exited with code "+std::to_string(rc));
            }
            }
        }catch(const GitFailure& error){result["message"]=error.what();if(!error.failure.empty())result["failure"]=error.failure;log(true,std::string(error.what())+(error.failure.empty()?"":" (this machine's Git login cannot read the repository; another machine will be tried)"));}
        catch(const std::exception& error){result["message"]=error.what();log(true,error.what());}
        stop=true;logs.join();renewStop=true;renew.join();watchdog.join();
        if(lost){result["status"]="error";result["exitCode"]=-1;result["message"]="Lease lost or cancelled; process tree stopped";result.erase("failure");}
        result["durationMs"]=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count();return result;
    }
};
}
int RunHostedAgent(int argc,char** argv) {
    try{return Runner(Parse(argc,argv)).Run();}catch(const ReconnectNeeded& error){std::fprintf(stderr,"Hosted agent: %s\n",error.what());return kExitNeedsReconnect;}catch(const Json::exception&){std::fprintf(stderr,"Hosted agent: invalid coordinator response or saved state\n");return 1;}catch(const std::exception& error){std::fprintf(stderr,"Hosted agent: %s\n",error.what());return 1;}
}
}
