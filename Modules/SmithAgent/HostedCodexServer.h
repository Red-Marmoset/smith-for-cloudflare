// HostedCodexServer.h - a Codex chat turn run through `codex app-server`, so Codex asks before acting.
//
// `codex exec` cannot ask for approval, so "Ask before each action" talks to Codex's app server
// instead (JSON-RPC over stdin/stdout). Its approval requests become dashboard questions through the
// same folder as Claude Code's (HostedAwaitAnswer); its items are relayed in the `codex exec --json`
// shape the dashboard already renders.
#pragma once
#include <SmithCore/Process.h>
#include <functional>
#include <map>
#include <string>
#include <vector>
namespace Smith {
    struct HostedCodexServerTurn {
        std::vector<std::string> argv;            // starts `codex app-server`
        std::string cwd;
        std::map<std::string, std::string> env;
        std::vector<std::string> envUnset;        // see ProcessOptions::envUnset
        std::string prompt;
        std::string threadId;                     // resume this Codex thread; empty starts a new one
        std::string sandbox = "workspace-write";  // Codex's sandbox for commands it is allowed to run
        std::string model;                        // a local Ollama model; empty uses the owner's login
        std::string approvalDir;                  // where questions meet the dashboard's answers
        int answerTimeoutSeconds = 900;
    };
    struct HostedCodexServerIo {
        std::function<void(const std::string& json)> event;        // a `codex exec --json` style event
        std::function<void(const std::string& line)> stderrLine;
        std::function<bool()> stopRequested;
        std::function<void(Process*)> running;                     // the app server while it runs, then nullptr
    };
    // 0 when the turn completed, 1 when Codex reported it failed or was stopped, -1 when no
    // conversation could be had (the app server did not start or answer).
    int RunHostedCodexServerTurn(const HostedCodexServerTurn& turn, const HostedCodexServerIo& io);
    // Pure: an app-server notification as the `codex exec --json` event to relay (empty: nothing to show).
    std::string HostedCodexServerEvent(const std::string& method, const std::string& paramsJson);
    // Pure: a dashboard question for an app-server approval request, as {"id","tool","input"} (empty:
    // not an approval Smith relays). `startedItemJson` is the item it refers to, when known.
    std::string HostedCodexServerQuestion(const std::string& method, const std::string& paramsJson, const std::string& startedItemJson);
}
