// HostedApproval.cpp - the local MCP helper that relays Claude Code's permission questions.
#include "HostedApproval.h"
#include "HostedPlatform.h"
#include <SmithCore/Uuid.h>
#include <json/single_include/nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <istream>
#include <ostream>
#include <regex>
#include <sstream>
#include <thread>
#include <vector>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
// 2026-07-28 clients discover the server instead of initializing, and expect cache hints on lists.
const std::string kModern = "2026-07-28";
const std::vector<std::string> kLegacy = {"2025-11-25", "2025-06-18", "2025-03-26"};

std::string Dump(const Json& value) { return value.dump(-1, ' ', false, Json::error_handler_t::replace); }
std::string ReadFile(const fs::path& path) { std::ifstream in(path, std::ios::binary); std::stringstream text; text << in.rdbuf(); return text.str(); }
Json ServerInfo() { return {{"name", kHostedApprovalServer}, {"title", "Smith dashboard approvals"}, {"version", "0.1.0"}}; }
Json ApproveTool() {
    return {{"name", "approve"}, {"title", "Ask in the Smith dashboard"},
            {"description", "Asks the person using the Smith dashboard whether Claude Code may use a tool. Claude Code calls this as its "
                            "permission prompt tool; there is no need to call it directly."},
            {"inputSchema", {{"type", "object"}, {"required", {"tool_name", "input"}},
                             {"properties", {{"tool_name", {{"type", "string"}}}, {"input", {{"type", "object"}}}, {"tool_use_id", {{"type", "string"}}}}}}}};
}
// Writes the question, then waits for the hosted agent to drop the person's answer beside it.
std::string Ask(const fs::path& dir, const Json& args, int timeoutSeconds) {
    const auto tool = args.contains("tool_name") && args["tool_name"].is_string() ? args["tool_name"].get<std::string>() : std::string();
    // Claude Code sends the tool's arguments as "input" (hooks call the same thing "tool_input").
    const auto input = args.contains("input") && args["input"].is_object() ? args["input"]
                     : args.contains("tool_input") && args["tool_input"].is_object() ? args["tool_input"] : Json::object();
    if (!HostedApprovalToolValid(tool)) return HostedApprovalResult("deny", "Smith cannot show a question about this tool in the dashboard.", Dump(input));
    auto id = args.contains("tool_use_id") && args["tool_use_id"].is_string() ? args["tool_use_id"].get<std::string>() : std::string();
    if (!HostedApprovalIdValid(id)) id = MakeUuid();
    const auto answer = HostedAwaitAnswer(dir.string(), id, tool, Dump(input), timeoutSeconds);
    if (answer.behavior.empty())
        return HostedApprovalResult("deny", "Nobody answered in the Smith dashboard within " + std::to_string(timeoutSeconds / 60) + " minutes, so this was not allowed.", Dump(input));
    return HostedApprovalResult(answer.behavior, answer.message, Dump(input));
}
}

HostedAnswer HostedAwaitAnswer(const std::string& folder, const std::string& id, const std::string& tool, const std::string& inputJson, int timeoutSeconds,
                               const std::function<bool()>& cancelled) {
    const fs::path dir(folder);
    const auto request = dir / (id + ".request.json"), response = dir / (id + ".response.json");
    const auto input = Json::parse(inputJson, nullptr, false);
    HostedSecureWrite(request.string(), Dump({{"id", id}, {"tool", tool}, {"input", input.is_object() ? input : Json::object()}}));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeoutSeconds);
    std::error_code ignored;
    for (;;) {
        if (fs::exists(response, ignored)) {
            const auto answer = Json::parse(ReadFile(response), nullptr, false);
            fs::remove(request, ignored); fs::remove(response, ignored);
            HostedAnswer result;
            if (answer.is_object() && answer.contains("behavior") && answer["behavior"].is_string()) result.behavior = answer["behavior"].get<std::string>();
            if (answer.is_object() && answer.contains("message") && answer["message"].is_string()) result.message = answer["message"].get<std::string>();
            if (result.behavior != "allow") result.behavior = "deny";   // anything but a clear yes is a no
            return result;
        }
        if (std::chrono::steady_clock::now() >= deadline || (cancelled && cancelled())) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    fs::remove(request, ignored);
    return {};
}

bool HostedApprovalIdValid(const std::string& id) { return std::regex_match(id, std::regex("[A-Za-z0-9_-]{1,64}")); }
bool HostedApprovalToolValid(const std::string& tool) { return std::regex_match(tool, std::regex("[A-Za-z][A-Za-z0-9_-]{0,127}")); }

std::string HostedApprovalMcpConfig(const std::string& executable, const std::string& dir) {
    return Dump({{"mcpServers", {{kHostedApprovalServer, {{"type", "stdio"}, {"command", executable}, {"args", {"ai-approve", dir}}}}}}});
}

std::string HostedApprovalResult(const std::string& behavior, const std::string& message, const std::string& inputJson) {
    if (behavior == "allow") {
        auto input = Json::parse(inputJson, nullptr, false);
        return Dump({{"behavior", "allow"}, {"updatedInput", input.is_object() ? input : Json::object()}});
    }
    return Dump({{"behavior", "deny"}, {"message", message.empty() ? "The person using Smith said no." : message}});
}

int RunHostedApprovalServer(std::istream& in, std::ostream& out, const std::string& dir, int answerTimeoutSeconds) {
    bool discovered = false;
    auto send = [&](const Json& message) { out << Dump(message) << '\n'; out.flush(); };
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        const auto message = Json::parse(line, nullptr, false);
        if (!message.is_object()) { send({{"jsonrpc", "2.0"}, {"id", nullptr}, {"error", {{"code", -32700}, {"message", "Parse error"}}}}); continue; }
        // Notifications (no id) and the client's own responses (no method) need no reply.
        if (!message.contains("id") || !message.contains("method") || !message["method"].is_string()) continue;
        const auto& id = message["id"];
        const auto method = message["method"].get<std::string>();
        const auto params = message.contains("params") && message["params"].is_object() ? message["params"] : Json::object();
        const auto meta = params.contains("_meta") && params["_meta"].is_object() ? params["_meta"] : Json::object();
        const bool modern = discovered || meta.value("io.modelcontextprotocol/protocolVersion", Json()) == Json(kModern);
        auto reply = [&](Json result) {
            if (modern) result["resultType"] = "complete";
            send({{"jsonrpc", "2.0"}, {"id", id}, {"result", std::move(result)}});
        };
        const Json cache = {{"ttlMs", 3600000}, {"cacheScope", "private"}};
        if (method == "server/discover") {
            discovered = true;
            Json versions = Json::array({kModern}); for (const auto& v : kLegacy) versions.push_back(v);
            Json result = cache; result.update({{"supportedVersions", versions}, {"capabilities", {{"tools", {{"listChanged", false}}}}},
                                                {"_meta", {{"io.modelcontextprotocol/serverInfo", ServerInfo()}}}});
            result["resultType"] = "complete";
            send({{"jsonrpc", "2.0"}, {"id", id}, {"result", result}});
        } else if (method == "initialize") {
            const auto requested = params.contains("protocolVersion") && params["protocolVersion"].is_string() ? params["protocolVersion"].get<std::string>() : std::string();
            const bool known = std::find(kLegacy.begin(), kLegacy.end(), requested) != kLegacy.end();
            reply({{"protocolVersion", known ? requested : kLegacy.front()}, {"capabilities", {{"tools", {{"listChanged", false}}}}}, {"serverInfo", ServerInfo()}});
        } else if (method == "ping") {
            reply(Json::object());
        } else if (method == "tools/list") {
            Json result = modern ? cache : Json::object(); result["tools"] = Json::array({ApproveTool()});
            reply(result);
        } else if (method == "tools/call" && params.value("name", Json()) == Json("approve")) {
            const auto args = params.contains("arguments") && params["arguments"].is_object() ? params["arguments"] : Json::object();
            std::string text;
            try { text = Ask(fs::path(dir), args, answerTimeoutSeconds); }
            catch (const std::exception& error) { text = HostedApprovalResult("deny", std::string("Smith could not relay this question: ") + error.what(), "{}"); }
            reply({{"content", Json::array({{{"type", "text"}, {"text", text}}})}, {"isError", false}});
        } else {
            send({{"jsonrpc", "2.0"}, {"id", id}, {"error", {{"code", method == "tools/call" ? -32602 : -32601}, {"message", method == "tools/call" ? "Unknown tool" : "Method not found"}}}});
        }
    }
    return 0;
}
}
