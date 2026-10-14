// HostedGitInit.cpp - see HostedGitInit.h.
#include "HostedGitInit.h"
#include <zip.h>   // kuba--/zip (miniz)
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
namespace fs = std::filesystem;
namespace Smith {
namespace {
    std::vector<std::string> Parts(std::string name) {
        std::replace(name.begin(), name.end(), '\\', '/');
        std::vector<std::string> parts; std::string part;
        for (char c : name + "/") {
            if (c != '/') { part += c; continue; }
            if (!part.empty() && part != ".") parts.push_back(part);
            part.clear();
        }
        return parts;
    }
    std::string Lower(std::string text) { std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return (char)std::tolower(c); }); return text; }
    bool Directory(const std::string& name) { return !name.empty() && (name.back() == '/' || name.back() == '\\'); }
    bool Skipped(const std::vector<std::string>& parts) {
        if (parts.empty() || parts[0] == "__MACOSX") return true;
        for (const auto& part : parts) if (Lower(part) == ".git") return true;
        return false;
    }
    // A name every platform Smith runs on can hold: no reserved characters, no trailing dot or space, no DOS device name.
    std::string Unportable(const std::string& part) {
        for (unsigned char c : part) if (c < 0x20 || std::string("<>:\"|?*").find((char)c) != std::string::npos) return "a character Windows cannot use in a file name";
        if (part.back() == '.' || part.back() == ' ') return "a name ending in a dot or space";
        std::string stem = Lower(part.substr(0, part.find('.')));
        static const std::vector<std::string> devices = {"con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"};
        if (std::find(devices.begin(), devices.end(), stem) != devices.end()) return "a name Windows reserves for a device";
        return "";
    }
    size_t WriteChunk(void* arg, uint64_t, const void* data, size_t size) {
        auto* out = static_cast<std::ofstream*>(arg);
        out->write(static_cast<const char*>(data), (std::streamsize)size);
        return out->good() ? size : 0;
    }
}

std::string HostedZipCommonRoot(const std::vector<std::string>& names) {
    std::string root; bool any = false;
    for (const auto& name : names) {
        const auto parts = Parts(name);
        if (Skipped(parts)) continue;
        const bool directory = Directory(name);
        if (!directory && parts.size() < 2) return "";   // a file at the top: nothing wraps everything
        if (!any) { root = parts[0]; any = true; } else if (parts[0] != root) return "";
    }
    return any ? root + "/" : "";
}

std::string HostedZipEntryPath(const std::string& name, const std::string& root, std::string& problem) {
    problem.clear();
    if (name.empty() || Directory(name)) return "";
    std::string normalized = name; std::replace(normalized.begin(), normalized.end(), '\\', '/');
    if (normalized[0] == '/' || (normalized.size() > 1 && normalized[1] == ':')) { problem = "an absolute path"; return ""; }
    auto parts = Parts(normalized);
    for (const auto& part : parts) if (part == "..") { problem = "a path that leaves the project folder"; return ""; }
    if (Skipped(parts)) return "";
    const auto rootParts = Parts(root);
    if (!rootParts.empty() && parts.size() > rootParts.size() && std::equal(rootParts.begin(), rootParts.end(), parts.begin())) parts.erase(parts.begin(), parts.begin() + (std::ptrdiff_t)rootParts.size());
    std::string path;
    for (const auto& part : parts) {
        const auto reason = Unportable(part);
        if (!reason.empty()) { problem = reason; return ""; }
        path += (path.empty() ? "" : "/") + part;
    }
    if (path.size() > 400) { problem = "a path longer than 400 characters"; return ""; }
    return path;
}

std::string HostedGitInitReadme(const std::string& projectName) {
    return "# " + projectName + "\n\nThis project lives in Smith. Clone it from the project card, add your files and a smith.json, and push:\n"
           "Smith reads smith.json after every push and offers its build actions.\n";
}

std::string HostedGitInitMessage(const std::string& kind, const std::string& projectName, const std::string& archiveName) {
    if (kind == "zip") return "Import " + projectName + " from " + (archiveName.empty() ? std::string("a zip") : archiveName);
    return "Start " + projectName;
}

std::string HostedExtractProjectZip(const std::string& zipPath, const std::string& dir, int64_t& files) {
    files = 0;
    struct zip_t* zip = zip_open(zipPath.c_str(), 0, 'r');
    if (!zip) return "The upload is not a zip archive Smith can read";
    struct Closer { zip_t* zip; ~Closer() { zip_close(zip); } } closer{zip};
    const ssize_t total = zip_entries_total(zip);
    if (total < 0) return "The zip archive is damaged";
    if (total > kHostedImportMaxEntries) return "The zip holds more than " + std::to_string(kHostedImportMaxEntries) + " entries";
    std::vector<std::string> names;
    for (ssize_t i = 0; i < total; ++i) {
        if (zip_entry_openbyindex(zip, (size_t)i) != 0) return "The zip archive is damaged";
        const char* raw = zip_entry_name(zip); std::string name = raw ? raw : "";
        if (zip_entry_isdir(zip) && !Directory(name)) name += "/";
        names.push_back(name); zip_entry_close(zip);
    }
    const std::string root = HostedZipCommonRoot(names);
    int64_t bytes = 0;
    for (ssize_t i = 0; i < total; ++i) {
        std::string problem; const std::string path = HostedZipEntryPath(names[(size_t)i], root, problem);
        if (!problem.empty()) return "The zip holds \"" + names[(size_t)i].substr(0, 200) + "\", " + problem;
        if (path.empty()) continue;
        if (zip_entry_openbyindex(zip, (size_t)i) != 0) return "The zip archive is damaged";
        bytes += (int64_t)zip_entry_size(zip);
        if (bytes > kHostedImportMaxBytes) { zip_entry_close(zip); return "The zip unpacks to more than 4 GB"; }
        const fs::path target = fs::path(dir) / fs::path(std::u8string(path.begin(), path.end()));   // entry names are UTF-8
        std::error_code ec; fs::create_directories(target.parent_path(), ec);
        if (ec || fs::exists(target, ec)) { zip_entry_close(zip); return "The zip holds \"" + path + "\" twice, or as both a file and a folder"; }
        std::ofstream out(target, std::ios::binary);
        const bool written = out && zip_entry_extract(zip, WriteChunk, &out) == 0 && out.good();
        zip_entry_close(zip);
        if (!written) return "Could not unpack \"" + path + "\" (the zip may be damaged, or the disk full)";
        ++files;
    }
    return "";
}

std::string HostedGitInitWorkTree(const HostedGitInitRequest& request, const HostedGitInitRun& git, std::string& workTree) {
    std::error_code ec;
    const fs::path scratch = fs::path(request.scratch), work = scratch / "work", hooks = scratch / "no-hooks", config = scratch / "empty.gitconfig";
    fs::remove_all(work, ec); fs::create_directories(work, ec); fs::create_directories(hooks, ec);
    if (ec) return "Could not make a working folder for the new repository";
    { std::ofstream empty(config, std::ios::binary); if (!empty) return "Could not make a working folder for the new repository"; }
    if (request.kind == "zip") {
        int64_t files = 0;
        const auto problem = HostedExtractProjectZip(request.zipPath, work.string(), files);
        if (!problem.empty()) return problem;
        if (files == 0) return "The zip holds no files";
    } else {
        std::ofstream readme(work / "README.md", std::ios::binary);
        readme << HostedGitInitReadme(request.name);
        if (!readme.good()) return "Could not write the README";
    }
    // Only Smith's settings apply: no system or user config (no autocrlf, excludes, signing or hooks of the person's own).
    const std::map<std::string, std::string> env = {{"GIT_CONFIG_NOSYSTEM", "1"}, {"GIT_CONFIG_GLOBAL", config.string()}, {"GIT_TERMINAL_PROMPT", "0"},
        {"GIT_AUTHOR_NAME", "Smith"}, {"GIT_AUTHOR_EMAIL", "smith@noreply.invalid"}, {"GIT_COMMITTER_NAME", "Smith"}, {"GIT_COMMITTER_EMAIL", "smith@noreply.invalid"}};
    const std::vector<std::string> settings = {"-c", "init.templateDir=", "-c", "core.hooksPath=" + hooks.string(), "-c", "core.autocrlf=false", "-c", "commit.gpgSign=false", "-c", "core.longpaths=true"};
    auto run = [&](std::vector<std::string> args, std::vector<std::string>* errors) {
        std::vector<std::string> argv = {"git"}; argv.insert(argv.end(), settings.begin(), settings.end()); argv.insert(argv.end(), args.begin(), args.end());
        return git(argv, work.string(), env, errors);
    };
    std::vector<std::string> errors;
    const auto failed = [&](const std::string& what) { return what + (errors.empty() ? std::string() : ": " + errors.back().substr(0, 300)); };
    if (run({"init", "-q", "-b", request.branch, "."}, &errors) != 0) return failed("Could not create the repository");
    errors.clear(); if (run({"add", "-A", "."}, &errors) != 0) return failed("Could not add the files");
    errors.clear(); if (run({"commit", "-q", "--no-verify", "-m", HostedGitInitMessage(request.kind, request.name, request.archiveName)}, &errors) != 0)
        return failed(request.kind == "zip" ? "Could not commit the files (a .gitignore in the zip may leave none)" : "Could not make the first commit");
    workTree = work.string();
    return "";
}
}
