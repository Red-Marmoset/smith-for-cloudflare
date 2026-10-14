// HostedCodexServer.cpp - one Codex turn through `codex app-server`, with approvals asked in the dashboard.
#include "HostedCodexServer.h"
#include "HostedApproval.h"
#include "HostedAiSession.h"
#include <SmithCore/Uuid.h>
#include <json/single_include/nlohmann/json.hpp>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <regex>
#include <sstream>
#include <thread>
namespace Smith {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
std::string Dump(const Json& value) { return value.dump(-1, ' ', false, Json::error_handler_t::replace); }
std::string Text(const Json& object, const char* key) { return object.is_object() && object.contains(key) && object[key].is_string() ? object[key].get<std::string>() : std::string(); }
std::string Joined(const Json& lines) {
    std::string out;
    if (lines.is_array()) for (const auto& line : lines) if (line.is_string()) out += (out.empty() ? "" : "\n") + line.get<std::string>();
    return out;
}
// The app server's camelCase statuses, in exec's words.
std::string Status(const Json& item) {
    const auto status = Text(item, "status");
    return status == "inProgress" ? "in_progress" : status;
}
// An app-server ThreadItem as the item `codex exec --json` prints (null: not shown in the dashboard).
Json ExecItem(const Json& item) {
    const auto type = Text(item, "type"), id = Text(item, "id");
    if (type == "agentMessage") return {{"id", id}, {"type", "agent_message"}, {"text", Text(item, "text")}};
    if (type == "reasoning") {
        auto text = Joined(item.value("summary", Json::array()));
        if (text.empty()) text = Joined(item.value("content", Json::array()));
        return text.empty() ? Json() : Json{{"id", id}, {"type", "reasoning"}, {"text", text}};
    }
    if (type == "commandExecution")
        return {{"id", id}, {"type", "command_execution"}, {"command", Text(item, "command")}, {"aggregated_output", Text(item, "aggregatedOutput")},
                {"exit_code", item.contains("exitCode") && item["exitCode"].is_number_integer() ? item["exitCode"] : Json()}, {"status", Status(item)}};
    if (type == "fileChange") {
        Json changes = Json::array();
        for (const auto& change : item.value("changes", Json::array()))
            changes.push_back({{"path", Text(change, "path")}, {"kind", change.contains("kind") ? Text(change["kind"], "type") : std::string()}});
        return {{"id", id}, {"type", "file_change"}, {"changes", changes}, {"status", Status(item)}};
    }
    if (type == "mcpToolCall")
        return {{"id", id}, {"type", "mcp_tool_call"}, {"server", Text(item, "server")}, {"tool", Text(item, "tool")}, {"arguments", item.value("arguments", Json())},
                {"result", item.value("result", Json())}, {"error", item.value("error", Json())}, {"status", Status(item)}};
    if (type == "webSearch") return {{"id", id}, {"type", "web_search"}, {"query", Text(item, "query")}};
    if (type == "plan") {
        Json steps = Json::array(); std::stringstream lines(Text(item, "text")); std::string line;
        while (std::getline(lines, line)) if (!line.empty()) steps.push_back({{"text", line}, {"completed", false}});
        return {{"id", id}, {"type", "todo_list"}, {"items", steps}};
    }
    return Json();
}
std::string SafeId(const std::string& id) { return std::regex_match(id, std::regex("[A-Za-z0-9_-]{1,64}")) ? id : MakeUuid(); }

class Conversation {
public:
    Conversation(const HostedCodexServerTurn& turn, const HostedCodexServerIo& io) : m_turn(turn), m_io(io) {}
    int Run() {
        ProcessOptions options; options.argv = m_turn.argv; options.workingDir = m_turn.cwd; options.envOverride = m_turn.env; options.envUnset = m_turn.envUnset;
        options.stdinPipe = true; options.timeoutSeconds = 6 * 3600;
        if (!m_process.Start(options, [this](bool error, const std::string& line) { Receive(error, line); })) return -1;
        if (m_io.running) m_io.running(&m_process);
        const int status = Converse();
        // End of input lets the app server exit by itself; it is stopped if it lingers.
        m_process.CloseStdin();
        for (int i = 0; i < 100 && m_process.Running(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (m_process.Running()) m_process.Kill();
        m_process.Wait();
        if (m_io.running) m_io.running(nullptr);
        return status;
    }
private:
    const HostedCodexServerTurn& m_turn; const HostedCodexServerIo& m_io; Process m_process;
    std::mutex m_mutex; std::condition_variable m_ready; std::deque<Json> m_inbox;
    int m_nextId = 1; std::string m_threadId, m_turnId; std::map<std::string, Json> m_items;
    std::optional<int> m_result; bool m_interrupting = false; Clock::time_point m_interruptDeadline;

    void Receive(bool error, const std::string& line) {
        auto message = error ? Json() : Json::parse(line, nullptr, false);
        if (!message.is_object()) { if (!line.empty() && m_io.stderrLine) m_io.stderrLine(line); return; }
        { std::lock_guard<std::mutex> lock(m_mutex); m_inbox.push_back(std::move(message)); }
        m_ready.notify_all();
    }
    std::optional<Json> Next() {
        std::unique_lock<std::mutex> lock(m_mutex);
        m_ready.wait_for(lock, std::chrono::milliseconds(250), [this] { return !m_inbox.empty(); });
        if (m_inbox.empty()) return std::nullopt;
        auto message = std::move(m_inbox.front()); m_inbox.pop_front(); return message;
    }
    void Send(Json message) { m_process.WriteStdin(Dump(message) + "\n"); }
    int Request(const std::string& method, Json params) { const int id = m_nextId++; Send({{"method", method}, {"id", id}, {"params", std::move(params)}}); return id; }
    // Waits for the response to request `id`, handling everything else that arrives meanwhile.
    std::optional<Json> Await(int id) {
        for (;;) {
            if (Stopping()) return std::nullopt;
            auto message = Next();
            if (!message) { if (!m_process.Running()) return std::nullopt; continue; }
            if (!message->contains("method") && message->value("id", Json()) == Json(id)) return message;
            Handle(*message);
        }
    }
    bool Stopping() {
        if (!m_io.stopRequested || !m_io.stopRequested()) return false;
        // Ask Codex to stop the turn; if it does not within ten seconds, stop the app server.
        if (!m_interrupting) {
            m_interrupting = true; m_interruptDeadline = Clock::now() + std::chrono::seconds(10);
            if (!m_turnId.empty()) Request("turn/interrupt", {{"threadId", m_threadId}, {"turnId", m_turnId}});
        }
        if (Clock::now() >= m_interruptDeadline || m_turnId.empty()) { m_process.Kill(); return true; }
        return false;
    }
    int Converse() {
        auto initialized = Await(Request("initialize", {{"clientInfo", {{"name", "smith"}, {"title", "Smith"}, {"version", "0.1.0"}}}, {"capabilities", nullptr}}));
        if (!initialized || initialized->contains("error")) return Fail(initialized, "Codex's app server did not start a conversation");
        Send({{"method", "initialized"}, {"params", Json::object()}});
        // "untrusted": Codex asks before running anything it does not consider safe, and before
        // changing files; what it is allowed to run still runs in its sandbox.
        Json thread = {{"cwd", m_turn.cwd}, {"approvalPolicy", "untrusted"}, {"sandbox", m_turn.sandbox}};
        if (!m_turn.model.empty()) { thread["model"] = m_turn.model; thread["modelProvider"] = "ollama"; }
        if (!m_turn.threadId.empty()) thread["threadId"] = m_turn.threadId;
        auto started = Await(Request(m_turn.threadId.empty() ? "thread/start" : "thread/resume", thread));
        if (!started || started->contains("error") || !(*started)["result"].contains("thread")) return Fail(started, "Codex could not open the conversation");
        m_threadId = Text((*started)["result"]["thread"], "id");
        if (m_threadId.empty()) return Fail(started, "Codex did not name the conversation");
        Emit({{"type", "thread.started"}, {"thread_id", m_threadId}});
        auto turn = Await(Request("turn/start", {{"threadId", m_threadId}, {"input", Json::array({{{"type", "text"}, {"text", m_turn.prompt}, {"text_elements", Json::array()}}})}}));
        if (!turn || turn->contains("error")) return Fail(turn, "Codex did not start working on the message");
        if ((*turn)["result"].contains("turn")) m_turnId = Text((*turn)["result"]["turn"], "id");
        while (!m_result) {
            if (Stopping()) return 1;
            auto message = Next();
            if (!message) { if (!m_process.Running()) return 1; continue; }
            Handle(*message);
        }
        return *m_result;
    }
    int Fail(const std::optional<Json>& response, const std::string& what) {
        if (!response && Stopping()) return 1;
        auto detail = response && response->contains("error") ? Text((*response)["error"], "message") : std::string();
        Emit({{"type", "error"}, {"message", what + (detail.empty() ? "." : ": " + detail)}});
        return -1;
    }
    void Emit(const Json& event) { if (m_io.event) m_io.event(Dump(event)); }
    void Handle(const Json& message) {
        const auto method = Text(message, "method");
        const auto params = message.value("params", Json::object());
        if (method.empty()) return;                                  // a response nobody waits for (turn/steer, turn/interrupt)
        if (message.contains("id")) { Answer(message["id"], method, params); return; }
        if (method == "turn/started" && params.contains("turn") && m_turnId.empty()) m_turnId = Text(params["turn"], "id");
        if (method == "item/started" && params.contains("item")) m_items[Text(params["item"], "id")] = params["item"];
        if (method == "turn/completed" && params.contains("turn") && (m_turnId.empty() || Text(params["turn"], "id") == m_turnId))
            m_result = Text(params["turn"], "status") == "completed" ? 0 : 1;
        const auto event = HostedCodexServerEvent(method, Dump(params));
        if (!event.empty() && m_io.event) m_io.event(event);
    }
    // A request from Codex: approvals go to the dashboard; anything else is declined.
    void Answer(const Json& id, const std::string& method, const Json& params) {
        const auto itemId = Text(params, "itemId");
        const auto item = m_items.count(itemId) ? Dump(m_items[itemId]) : std::string();
        const auto question = HostedCodexServerQuestion(method, Dump(params), item);
        if (question.empty()) { Send({{"id", id}, {"error", {{"code", -32601}, {"message", "Smith cannot answer " + method}}}}); return; }
        const auto ask = Json::parse(question);
        const auto answer = HostedAwaitAnswer(m_turn.approvalDir, ask["id"].get<std::string>(), ask["tool"].get<std::string>(), Dump(ask["input"]),
                                              m_turn.answerTimeoutSeconds, [this] { return m_io.stopRequested && m_io.stopRequested(); });
        Send({{"id", id}, {"result", {{"decision", answer.behavior == "allow" ? "accept" : "decline"}}}});
        // "No, do this instead": the person's words reach Codex in the same turn.
        if (answer.behavior == "deny" && !answer.message.empty() && !m_turnId.empty())
            Request("turn/steer", {{"threadId", m_threadId}, {"expectedTurnId", m_turnId}, {"input", Json::array({{{"type", "text"}, {"text", answer.message}, {"text_elements", Json::array()}}})}});
    }
};
}

int RunHostedCodexServerTurn(const HostedCodexServerTurn& turn, const HostedCodexServerIo& io) { return Conversation(turn, io).Run(); }

std::string HostedCodexServerEvent(const std::string& method, const std::string& paramsJson) {
    const auto params = Json::parse(paramsJson, nullptr, false);
    if (!params.is_object()) return "";
    if ((method == "item/started" || method == "item/completed") && params.contains("item")) {
        const auto item = ExecItem(params["item"]);
        if (item.is_null() || (method == "item/started" && item["type"] != "command_execution")) return "";
        return Dump({{"type", method == "item/started" ? "item.started" : "item.completed"}, {"item", item}});
    }
    if (method == "turn/completed" && params.contains("turn")) {
        const auto& turn = params["turn"]; const auto status = Text(turn, "status");
        if (status == "completed") return Dump({{"type", "turn.completed"}});
        auto message = turn.contains("error") ? Text(turn["error"], "message") : std::string();
        if (message.empty()) message = status == "interrupted" ? "Stopped" : "Codex stopped";
        return Dump({{"type", "turn.failed"}, {"error", {{"message", message}}}});
    }
    if (method == "error" && params.contains("error") && !params.value("willRetry", false)) return Dump({{"type", "error"}, {"message", Text(params["error"], "message")}});
    return "";
}

std::string HostedCodexServerQuestion(const std::string& method, const std::string& paramsJson, const std::string& startedItemJson) {
    const auto params = Json::parse(paramsJson, nullptr, false);
    if (!params.is_object()) return "";
    const auto approvalId = Text(params, "approvalId");
    const auto id = SafeId(approvalId.empty() ? Text(params, "itemId") : approvalId);
    Json input = Json::object();
    if (!Text(params, "reason").empty()) input["reason"] = Text(params, "reason");
    if (method == "item/commandExecution/requestApproval") {
        input["command"] = Text(params, "command");
        if (!Text(params, "cwd").empty()) input["cwd"] = Text(params, "cwd");
        return Dump({{"id", id}, {"tool", "Command"}, {"input", input}});
    }
    if (method == "item/fileChange/requestApproval") {
        // The request names only the item; its changes came with item/started.
        const auto item = Json::parse(startedItemJson.empty() ? "{}" : startedItemJson, nullptr, false);
        const auto shown = ExecItem(item.is_object() ? item : Json::object());
        input["changes"] = shown.is_object() && shown.contains("changes") ? shown["changes"] : Json::array();
        if (!Text(params, "grantRoot").empty()) input["grantRoot"] = Text(params, "grantRoot");
        return Dump({{"id", id}, {"tool", "FileChange"}, {"input", input}});
    }
    return "";
}
// Declared in HostedAiSession.h: which of `codex exec`'s JSON lines a chat relays.
bool HostedCodexEventRelayed(const std::string& clampedLine) {
    const auto value = Json::parse(clampedLine, nullptr, false);
    if (!value.is_object()) return false;
    const auto type = value.value("type", "");
    if (type == "item.updated") return false;
    if (type == "item.started") return value.contains("item") && value["item"].is_object() && value["item"].value("type", "") == "command_execution";
    return true;
}
}
