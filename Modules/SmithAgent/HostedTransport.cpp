// HostedTransport.cpp - see HostedTransport.h.
#include "HostedTransport.h"
#include "HostedPlatform.h"
#include <SmithCore/Process.h>
#include <SmithCore/Uuid.h>
#include <chrono>
#include <fstream>
#include <stdexcept>
#include <thread>
namespace fs = std::filesystem;
namespace Smith {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
std::string ReadBoundedFile(const fs::path& path, size_t maximum) {
    if (fs::is_symlink(fs::symlink_status(path)) || !fs::is_regular_file(path) || fs::file_size(path) > maximum) throw std::runtime_error("Invalid or oversized private file");
    std::ifstream input(path, std::ios::binary); if (!input) throw std::runtime_error("Cannot read private file");
    std::string text(maximum + 1, '\0'); input.read(text.data(), (std::streamsize)text.size()); text.resize((size_t)input.gcount());
    if (text.size() > maximum) throw std::runtime_error("Oversized response"); return text;
}
struct Cleanup { fs::path path; ~Cleanup() { std::error_code ec; fs::remove_all(path, ec); } };
}
std::string HostedQuoteConfig(const std::string& text) {
    std::string out = "\"";
    for (char c : text) { if (c == '\n' || c == '\r' || c == '\0') throw std::runtime_error("Invalid transport field"); if (c == '\\' || c == '"') out += '\\'; out += c; }
    return out + "\"";
}
HostedResponse HostedTransport::Post(const std::string& route, const Json& body) const {
    return Send(route, body.dump(-1, ' ', false, Json::error_handler_t::replace), "application/json", {}, 10, 1024 * 1024, nullptr);
}
HostedResponse HostedTransport::Upload(const Json& lease, const std::string& name, const std::string& bytes, const std::string& sha256, const std::atomic<bool>& cancelled) const {
    std::map<std::string, std::string> headers = {
        {"X-Smith-Job-Id", lease.at("jobId").get<std::string>()},
        {"X-Smith-Attempt-Id", lease.at("attemptId").get<std::string>()},
        {"X-Smith-Lease-Token", lease.at("leaseToken").get<std::string>()},
        {"X-Smith-Artifact-Name", name}, {"X-Smith-SHA256", sha256},
        {"Content-Length", std::to_string(bytes.size())}, {"Expect", ""}};
    return Send("/artifacts", bytes, "application/octet-stream", headers, 90, 20 * 1024 * 1024, &cancelled);
}
HostedResponse HostedTransport::PostBytes(const std::string& route, const std::string& bytes, const std::string& contentType, const std::map<std::string, std::string>& headers, int timeout, size_t maximum) const {
    auto all = headers; all["Content-Length"] = std::to_string(bytes.size()); all["Expect"] = "";
    return Send(route, bytes, contentType, all, timeout, maximum, nullptr);
}
int HostedTransport::Download(const std::string& route, const fs::path& file, long long maximum, int timeout, const std::map<std::string, std::string>& headers) const {
    fs::path request = directory / ("request-" + MakeUuid());
    HostedSecureDirectory(request.string());
    Cleanup cleanup{request};
    const bool absolute = route.rfind("https://", 0) == 0;   // a presigned R2 URL: as given, and never the node credential
    std::string config = "url = " + HostedQuoteConfig(absolute ? route : base + route) + "\n";
    if (!absolute && !token.empty()) config += "header = " + HostedQuoteConfig("Authorization: Bearer " + token) + "\n";
    for (const auto& header : headers) config += "header = " + HostedQuoteConfig(header.first + ": " + header.second) + "\n";
    config += "output = " + HostedQuoteConfig(file.string()) + "\n";
    HostedSecureWrite((request / "curl.conf").string(), config);
    ProcessOptions options;
    options.argv = {"curl", "--disable", "--config", (request / "curl.conf").string(), "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0", "--connect-timeout", "10", "--max-time", std::to_string(timeout), "--max-filesize", std::to_string(maximum), "--write-out", "%{http_code}"};
    options.timeoutSeconds = timeout + 5;
    std::string status; Process process;
    if (process.Run(options, [&](bool error, const std::string& line) { if (!error && status.size() < 16) status += line.substr(0, 16); }) != 0) return 0;
    try { return std::stoi(status); } catch (...) { return 0; }
}
int HostedTransport::PutFile(const std::string& routeOrUrl, const fs::path& file, const std::map<std::string, std::string>& headers, int timeout) const {
    fs::path request = directory / ("request-" + MakeUuid());
    HostedSecureDirectory(request.string());
    Cleanup cleanup{request};
    const bool absolute = routeOrUrl.rfind("https://", 0) == 0;
    std::string config = "url = " + HostedQuoteConfig(absolute ? routeOrUrl : base + routeOrUrl) + "\nupload-file = " + HostedQuoteConfig(file.string()) + "\n";
    if (!absolute && !token.empty()) config += "header = " + HostedQuoteConfig("Authorization: Bearer " + token) + "\n";
    for (const auto& header : headers) config += "header = " + HostedQuoteConfig(header.first + ": " + header.second) + "\n";
    config += "header = " + HostedQuoteConfig("Expect:") + "\noutput = " + HostedQuoteConfig((request / "response").string()) + "\n";
    HostedSecureWrite((request / "curl.conf").string(), config);
    ProcessOptions options;
    options.argv = {"curl", "--disable", "--config", (request / "curl.conf").string(), "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0", "--connect-timeout", "10", "--max-time", std::to_string(timeout), "--write-out", "%{http_code}"};
    options.timeoutSeconds = timeout + 5;
    std::string status; Process process;
    if (process.Run(options, [&](bool error, const std::string& line) { if (!error && status.size() < 16) status += line.substr(0, 16); }) != 0) return 0;
    try { return std::stoi(status); } catch (...) { return 0; }
}
HostedResponse HostedTransport::Send(const std::string& route, const std::string& payload, const std::string& contentType,
                                     const std::map<std::string, std::string>& headers, int timeout, size_t maximum, const std::atomic<bool>* cancelled) const {
    HostedResponse response; fs::path request = directory / ("request-" + MakeUuid());
    HostedSecureDirectory(request.string());
    Cleanup cleanup{request};
    if (payload.size() > maximum) throw std::runtime_error("Request exceeds transport limit");
    HostedSecureWrite((request / "body").string(), payload); HostedSecureWrite((request / "response").string(), "");
    std::string config = "url = " + HostedQuoteConfig(base + route) + "\nheader = " + HostedQuoteConfig("Content-Type: " + contentType) + "\n";
    for (const auto& header : headers) config += "header = " + HostedQuoteConfig(header.first + ": " + header.second) + "\n";
    if (!token.empty()) config += "header = " + HostedQuoteConfig("Authorization: Bearer " + token) + "\n";
    config += "data-binary = " + HostedQuoteConfig("@" + (request / "body").string()) + "\noutput = " + HostedQuoteConfig((request / "response").string()) + "\n";
    HostedSecureWrite((request / "curl.conf").string(), config);
    ProcessOptions options;
    options.argv = {"curl", "--disable", "--config", (request / "curl.conf").string(), "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0", "--connect-timeout", "5", "--max-time", std::to_string(timeout), "--max-filesize", "1048576", "--write-out", "%{http_code}"};
    options.timeoutSeconds = timeout + 2;
    // No -k, --location, command-shell interpolation, or credentials in argv.
    std::string status; Process process;
    auto capture = [&](bool error, const std::string& line) { if (!error && status.size() < 16) status += line.substr(0, 16); };
    int rc = -1;
    if (cancelled) {
        if (*cancelled || !process.Start(options, capture)) return response;
        const auto deadline = Clock::now() + std::chrono::seconds(timeout + 2);
        while (process.Running()) {
            if (*cancelled || Clock::now() >= deadline) { process.Kill(); break; }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        rc = process.Wait();
    } else rc = process.Run(options, capture);
    if (rc != 0) return response;
    try { response.status = std::stoi(status); const auto bytes = ReadBoundedFile(request / "response", 1024 * 1024); response.body = Json::parse(bytes); } catch (...) { response.status = 0; }
    return response;
}
}
