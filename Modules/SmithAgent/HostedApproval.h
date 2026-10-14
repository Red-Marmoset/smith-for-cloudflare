// HostedApproval.h - dashboard answers to Claude Code's permission questions ("ask before each action").
//
// In ask mode Claude Code runs `smith ai-approve <dir>` as a local stdio MCP server whose one tool,
// `approve`, is its --permission-prompt-tool. Each question is written to <dir>/<id>.request.json;
// the hosted agent relays it to the dashboard over its existing lease and writes the person's answer
// to <dir>/<id>.response.json. No credential is involved: the helper only reads and writes that folder.
#pragma once
#include <functional>
#include <iosfwd>
#include <string>
namespace Smith {
    // The MCP server name and the tool name Claude Code is told to ask.
    constexpr const char* kHostedApprovalServer = "smith_approval";
    constexpr const char* kHostedApprovalTool = "mcp__smith_approval__approve";

    // Serves MCP over newline-delimited JSON-RPC until `in` ends. A question nobody answers within
    // `answerTimeoutSeconds` is declined, so Claude Code never waits forever.
    int RunHostedApprovalServer(std::istream& in, std::ostream& out, const std::string& dir, int answerTimeoutSeconds);
    // Writes a question to <dir>/<id>.request.json and waits for the dashboard's answer in
    // <dir>/<id>.response.json. `behavior` is "allow" or "deny", or empty when nobody answered in time
    // or `cancelled` returned true. Used by the helper above and by Codex's approval requests.
    struct HostedAnswer { std::string behavior; std::string message; };
    HostedAnswer HostedAwaitAnswer(const std::string& dir, const std::string& id, const std::string& tool, const std::string& inputJson, int timeoutSeconds,
                                   const std::function<bool()>& cancelled = nullptr);
    // Pure: the --mcp-config JSON that starts that server from `executable`.
    std::string HostedApprovalMcpConfig(const std::string& executable, const std::string& dir);
    // Pure: Claude Code's permission result for the dashboard's answer: allow (with the tool's
    // original input, unchanged) or deny with the person's message.
    std::string HostedApprovalResult(const std::string& behavior, const std::string& message, const std::string& inputJson);
    // Pure: the question IDs and tool names Smith relays (the coordinator checks the same rules).
    bool HostedApprovalIdValid(const std::string& id);
    bool HostedApprovalToolValid(const std::string& tool);
}
