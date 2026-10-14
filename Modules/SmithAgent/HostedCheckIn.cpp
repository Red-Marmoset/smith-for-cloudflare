#include "HostedCheckIn.h"
#include "HostedCrewRun.h"
#include <json/single_include/nlohmann/json.hpp>
#include <regex>
namespace Smith {
std::string HostedCheckInReport(const std::string& eventId, const std::string& base, const std::string& head, const std::string& numstat, bool ancestor) {
    using Json = nlohmann::json;
    Json report = {{"eventId", eventId}, {"baseCommit", base}, {"headCommit", head}, {"changes", Json::array()}, {"complete", false}, {"ancestor", ancestor}, {"testState", "unknown"}};
    if (numstat.size() > 10 * 1024 * 1024) return report.dump();
    const auto pathValid = [](const std::string& path) {
        if (path.empty() || path.size() > 512 || path.front() == '/' || path.back() == '/' || path.find('\\') != std::string::npos || path.find(':') != std::string::npos) return false;
        for (unsigned char c : path) if (c < 32 || c == 127) return false;
        return path != "." && path != ".." && path.rfind("../", 0) != 0 && path.find("/../") == std::string::npos && path.find("/./") == std::string::npos && path.find("//") == std::string::npos && path.substr(path.find_last_of('/') + 1) != "..";
    };
    size_t offset = 0;
    auto token = [&]() { const auto end = numstat.find('\0', offset); if (end == std::string::npos) throw 0; auto value = numstat.substr(offset, end-offset); offset = end+1; return value; };
    try {
        while (offset < numstat.size()) {
            const auto entry = token(); const auto a = entry.find('\t'), b = entry.find('\t', a == std::string::npos ? 0 : a+1);
            if (a == std::string::npos || b == std::string::npos) throw 0;
            const auto count = [](const std::string& value) -> Json { if (value == "-") return nullptr; if (!std::regex_match(value, std::regex("[0-9]{1,9}"))) throw 0; return std::stoll(value); };
            Json change = {{"added", count(entry.substr(0,a))}, {"deleted", count(entry.substr(a+1,b-a-1))}};
            auto path = entry.substr(b+1);
            if (path.empty()) { const auto old = token(); if (!pathValid(old)) throw 0; change["oldPath"] = old; path = token(); }
            if (!pathValid(path)) throw 0;
            change["path"] = path; report["changes"].push_back(change);
            if (report["changes"].size() > 20000) throw 0;
        }
        report["complete"] = true;
    } catch (...) { report["changes"] = Json::array(); }
    if (report.dump().size() > 10 * 1024 * 1024) { report["changes"] = Json::array(); report["complete"] = false; }
    return report.dump();
}
}
