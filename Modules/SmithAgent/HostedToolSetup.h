// HostedToolSetup.h - finding, installing and signing in to the coding CLIs from the dashboard.
//
// The owner never has to visit a terminal: the agent finds Claude Code / Codex wherever their
// installers put them, reports what is missing or signed out, and installs or signs in when the
// owner clicks the button on the page. Nothing here opens a browser or any other window by itself:
// sign-in links are relayed to the page and open only when the owner clicks them there.
#pragma once
#include "HostedAiSession.h"
#include <atomic>
#include <functional>
#include <map>
#include <shared_mutex>
#include <string>
#include <vector>
namespace Smith {
    // Pure: where each platform's installers put command-line tools, searched after the PATH (the
    // agent often runs from a logon task whose PATH predates the install). `env` reads a variable.
    std::vector<std::string> HostedToolSearchDirs(const std::string& os, const std::function<std::string(const std::string&)>& env);
    // The absolute path of a command-line tool (PATH first, then HostedToolSearchDirs); empty when absent.
    std::string HostedFindTool(const std::string& tool);
    // Pure: the variables holding an API key that a CLI prefers over its owner's subscription login.
    std::vector<std::string> HostedApiKeyVars(const std::string& tool);
    // Pure: a BROWSER value that opens nothing. Claude Code runs `$BROWSER <url>`; every CLI Smith
    // starts gets this, so no sign-in or MCP link can pop up a tab the owner did not ask for.
    std::string HostedNoBrowser(const std::string& os);
    // Pure: the environment every CLI Smith starts gets on top of its own (BROWSER, no prompts).
    std::map<std::string, std::string> HostedCliQuietEnv(const std::string& os);
    // Pure: whether a CLI's status output says it is signed in: 1 yes, 0 no, -1 cannot tell.
    // Claude Code: `claude auth status --json`; Codex: `codex login status` (output and exit code).
    int HostedClaudeSignedIn(const std::string& statusOutput);
    int HostedCodexSignedIn(const std::string& statusOutput, int exitCode);
    // Pure: the commands that install a tool here, given which package managers exist; empty when
    // this machine cannot install it unattended (the dashboard then says what it needs instead).
    // Nothing that needs an administrator prompt is ever chosen.
    struct HostedInstallStep { std::string tool; std::vector<std::string> args; };
    std::vector<HostedInstallStep> HostedInstallPlan(const std::string& tool, const std::string& os, bool hasNpm, bool hasBrew);
    // What the machine has for chats: [{id, version, signedIn?, apiKey?}], and the missing tools it can install.
    struct HostedAiToolReport { std::string tools; std::string installable; }; // JSON arrays
    HostedAiToolReport DetectHostedAiTools();
    // Runs one install / sign-in task the coordinator handed out (`setupJson`: {setupId, leaseToken,
    // tool, action}) to its end, streaming its output to the page and the page's input to its stdin.
    void RunHostedSetupTask(const HostedPostFn& post, const std::string& setupJson, const std::atomic<bool>& stop, std::shared_mutex& toolGate);
}
