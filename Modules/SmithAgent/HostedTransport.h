// HostedTransport.h - the hosted agent's only way to reach the coordinator: one `curl` subprocess
// per request (no native TLS), every request authenticated with the node credential, no
// credential ever on a command line. Shared by the build loop, the chat loop and the git host.
#pragma once
#include <json/single_include/nlohmann/json.hpp>
#include <atomic>
#include <filesystem>
#include <map>
#include <string>
namespace Smith {
    struct HostedResponse { int status = 0; nlohmann::json body = nlohmann::json::object(); bool Ok() const { return status >= 200 && status < 300; } };
    // Pure: a curl config value, quoted and escaped; throws on line breaks or NULs.
    std::string HostedQuoteConfig(const std::string& text);
    class HostedTransport {
    public:
        std::string base, token; std::filesystem::path directory;
        HostedResponse Post(const std::string& route, const nlohmann::json& body) const;
        // A job artifact (at most 20 MiB) with the lease headers the coordinator checks.
        HostedResponse Upload(const nlohmann::json& lease, const std::string& name, const std::string& bytes, const std::string& sha256, const std::atomic<bool>& cancelled) const;
        // Raw bytes (at most `maximum`) with extra headers; the reply is JSON. Used for relay response parts.
        HostedResponse PostBytes(const std::string& route, const std::string& bytes, const std::string& contentType, const std::map<std::string, std::string>& headers, int timeout, size_t maximum) const;
        // GETs a route into `file`, at most `maximum` bytes, with optional extra headers. Returns the HTTP status (0: no response).
        int Download(const std::string& route, const std::filesystem::path& file, long long maximum, int timeout, const std::map<std::string, std::string>& headers = {}) const;
        // PUTs `file` to a route (with the node credential) or to an https:// URL as given (a presigned R2 URL: no
        // credential). Returns the HTTP status (0: no response). Download accepts an https:// URL the same way.
        int PutFile(const std::string& routeOrUrl, const std::filesystem::path& file, const std::map<std::string, std::string>& headers, int timeout) const;
    private:
        HostedResponse Send(const std::string& route, const std::string& payload, const std::string& contentType,
                            const std::map<std::string, std::string>& headers, int timeout, size_t maximum, const std::atomic<bool>* cancelled) const;
    };
}
