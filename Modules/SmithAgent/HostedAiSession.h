// HostedAiSession.h - runs dashboard chat turns with the machine owner's own coding CLI.
//
// The CLI is launched unmodified, with whatever login its owner completed on this machine;
// Smith never reads, stores or forwards those credentials. Only the CLI's output is relayed.
#pragma once
#include <atomic>
#include <functional>
#include <map>
#include <shared_mutex>
#include <string>
#include <vector>
namespace Smith {
    // POSTs a JSON body to a coordinator route, returning the HTTP status (0 = no response)
    // and the response body.
    using HostedPostFn = std::function<int(const std::string& route, const std::string& body, std::string& response)>;

    // Claims and runs chat turns for this machine until `stop` is set. Returns early when the
    // coordinator does not offer chat sessions or the node credential is rejected. The claims also hand
    // out install / sign-in tasks (HostedToolSetup.h), run beside chats; when one ends `toolsChanged`
    // is bumped so the heartbeat reports the tools again at once. `busy` counts the chat turns and
    // setup tasks running right now, so the agent only updates itself when nobody is mid-conversation.
    void RunHostedAiLoop(const HostedPostFn& post, const std::string& workspaceRoot, const std::atomic<bool>& stop, std::shared_mutex& toolGate,
                         std::atomic<unsigned>* toolsChanged = nullptr, std::atomic<int>* busy = nullptr);

    // Pure: Claude Code headless arguments for a turn whose prompt arrives on stdin. Empty when
    // the permission mode or resume ID is not one Smith accepts. Ask mode ("default") needs the
    // --mcp-config file that starts Smith's approval helper (see HostedApproval.h). `briefing` is the
    // coordinator's note on where the CLI is (branch, what Smith does for it), appended to its system prompt.
    std::vector<std::string> HostedClaudeArgs(const std::string& permissionMode, const std::string& resumeId, const std::string& approvalConfig = "", const std::string& briefing = "");
    // Pure: a briefing the coordinator sent, as Smith will hand it to a CLI: at most 8 KB of plain text that
    // starts with a letter (never a flag), or "" when it is not usable.
    std::string HostedBriefing(const std::string& text);
    // Pure: Codex has no system-prompt option, so its briefing goes ahead of the first message of a
    // thread (a resumed thread already knows); the prompt itself is unchanged otherwise.
    std::string HostedCodexPrompt(const std::string& briefing, const std::string& prompt, bool resumed);
    // Pure: Codex non-interactive (`codex exec --json`) arguments for a turn whose prompt arrives
    // on stdin; `sandbox` is Codex's own sandbox mode. Empty when either value is not one Smith accepts.
    // With `ollamaModel`, Codex runs that local Ollama model (`--oss --local-provider ollama -m`).
    std::vector<std::string> HostedCodexArgs(const std::string& sandbox, const std::string& resumeId, const std::string& ollamaModel = "");
    // Pure: an Ollama model name Smith passes to a CLI (as reported by the agent's own inventory).
    bool HostedOllamaModelValid(const std::string& model);
    // Pure: a model Claude Code runs with the owner's own login (`--model`, e.g. "claude-opus-5-5"):
    // lowercase letters, digits, dots and dashes, starting with a letter (never a flag).
    bool HostedLoginModelValid(const std::string& model);
    // Pure: the environment a CLI gets to run on a local Ollama model. Claude Code talks to Ollama's
    // Anthropic-compatible API; for a guest (another member using this machine's shared models) each
    // CLI also gets an empty config directory of its own (`guestConfigDir`) and common credential
    // variables are blanked, so nothing of the owner's logins is reachable from that session.
    std::map<std::string, std::string> HostedOllamaEnv(const std::string& tool, const std::string& model, const std::string& guestConfigDir);
    // Pure: what is removed from the inherited environment first (ProcessOptions::envUnset). The CLIs
    // find credentials in many variables (Claude Code: an OAuth token, a token file, Bedrock/Vertex
    // settings...), so an Ollama session starts without any of them, and a guest's without the CLI's
    // own settings either.
    std::vector<std::string> HostedOllamaEnvUnset(const std::string& tool, bool guest);
    // Pure: the permission modes a guest's chat may use (edit only in its own copy, or read only).
    bool HostedGuestModeAllowed(const std::string& tool, const std::string& mode);
    // Pure: whether a Codex JSONL event is worth relaying. Progress updates are dropped; a
    // command's start is kept so a long-running command shows up before it finishes.
    bool HostedCodexEventRelayed(const std::string& clampedLine);
    // Pure: a stream-json line re-serialized with long strings shortened to `maxString` bytes,
    // or empty when the line is not a JSON object.
    std::string HostedClampJsonLine(const std::string& line, size_t maxString);
    // Pure: whether Codex's own Windows sandbox is usable, from its config.toml and whether its
    // setup marker exists: "ready", "setup-pending" (elevated chosen but never set up, which needs an
    // administrator prompt nobody sees on a headless agent) or "not-set-up". Without it Codex refuses
    // to run commands or edit files in its sandboxed modes.
    std::string HostedCodexWindowsSandbox(const std::string& configToml, bool setupMarkerExists);
    // Pure: a log line without terminal escape sequences (colors, cursor moves, titles).
    std::string HostedPlainText(const std::string& line);
    // Pure: the session branch names Smith creates (smith/ai-<8 hex>, smith/ai-<slug>-<8 hex>, smith/crew-<slug>-<8 hex>).
    bool HostedAiBranchValid(const std::string& branch);
    // What this agent can do for chats beyond plain replies, reported with its AI inventory so the
    // dashboard only offers what the machine supports ("ask", "push", ...).
    std::vector<std::string> HostedAiFeatures();
    // Pure: the git argv Smith runs in a chat's copy of the project after the CLI has worked in it.
    // Repository hooks and fsmonitor are switched off, so files the CLI wrote under .git cannot make
    // Smith's own commit or push run a program.
    std::vector<std::string> HostedAiGitArgv(const std::vector<std::string>& args, const std::string& noHooksDir);
}
