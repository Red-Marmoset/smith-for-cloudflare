// Capabilities.cpp - see Capabilities.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#include "Capabilities.h"
#include "Process.h"

#include <Log/Log.h>

#include <json/single_include/nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <cstdlib>

namespace fs = std::filesystem;

namespace Smith
{
    std::vector<std::string> DetectCapabilityLabels(const std::string& enginePath)
    {
        std::vector<std::string> out;
        if (enginePath.empty()) return out;
        std::error_code ec;
        // A bootstrapped Una engine has a built BuildTool; mirror RunTests' detection so
        // "una-engine" means the agent can actually run a Build.ps1/Build.sh invocation.
        for (const char* cfg : { "Release", "MinSizeRel", "Debug", "Bootstrap" })
        {
            fs::path dir = fs::path(enginePath) / "Build" / "BuildTool" / cfg;
            if (fs::exists(dir / "BuildTool.exe", ec) || fs::exists(dir / "BuildTool", ec))
            {
                out.push_back("una-engine");
                break;
            }
        }
        return out;
    }

    std::vector<std::string> DetectUnityLinuxLabels(const std::vector<std::string>& editorRoots)
    {
        std::error_code ec;
        bool hasLinux = false, hasIl2cpp = false;
        for (const auto& root : editorRoots)
        {
            for (fs::directory_iterator it(root, ec), end; it != end; it.increment(ec))
            {
                if (!it->is_directory(ec)) continue;
                // Windows/Linux installs: <version>/Editor/Data/PlaybackEngines;
                // macOS installs: <version>/PlaybackEngines (beside Unity.app).
                for (const char* rel : { "Editor/Data/PlaybackEngines", "PlaybackEngines" })
                {
                    fs::path support = it->path() / rel / "LinuxStandaloneSupport";
                    if (!fs::exists(support, ec)) continue;
                    hasLinux = true;
                    for (fs::directory_iterator vit(support / "Variations", ec), vend; vit != vend; vit.increment(ec))
                        if (vit->path().filename().string().find("il2cpp") != std::string::npos)
                        { hasIl2cpp = true; break; }
                }
            }
        }
        std::vector<std::string> out;
        if (hasLinux) out.push_back("unity-linux");
        if (hasIl2cpp) out.push_back("unity-linux-il2cpp");
        return out;
    }

    std::vector<std::string> DetectUnityMobileLabels(const std::vector<std::string>& editorRoots)
    {
        std::error_code ec;
        bool hasIos = false, hasAndroid = false;
        for (const auto& root : editorRoots)
        {
            for (fs::directory_iterator it(root, ec), end; it != end; it.increment(ec))
            {
                if (!it->is_directory(ec)) continue;
                for (const char* rel : { "Editor/Data/PlaybackEngines", "PlaybackEngines" })
                {
                    fs::path engines = it->path() / rel;
                    if (fs::is_directory(engines / "iOSSupport", ec)) hasIos = true;
                    if (fs::is_directory(engines / "AndroidPlayer", ec)) hasAndroid = true;
                }
            }
        }
        std::vector<std::string> out;
        if (hasIos) out.push_back("unity-ios");
        if (hasAndroid) out.push_back("unity-android");
        return out;
    }

    std::vector<std::string> DetectUnityVersionLabels(const std::vector<std::string>& editorRoots)
    {
        std::error_code ec;
        std::vector<std::string> out;
        auto add = [&](const std::string& l) {
            if (std::find(out.begin(), out.end(), l) == out.end()) out.push_back(l);
        };
        for (const auto& root : editorRoots)
        {
            for (fs::directory_iterator it(root, ec), end; it != end; it.increment(ec))
            {
                if (!it->is_directory(ec)) continue;
                const fs::path& d = it->path();
                // Only a version dir that actually holds an editor binary counts; a
                // Hub install still downloading/extracting has the folder but no binary.
                bool installed = fs::exists(d / "Editor" / "Unity.exe", ec)    // Windows
                              || fs::exists(d / "Editor" / "Unity", ec)        // Linux
                              || fs::exists(d / "Unity.app", ec)               // macOS (Hub layout)
                              || fs::exists(d / "Editor" / "Unity.app", ec);
                if (!installed) continue;
                // Leading digits of the version dir name: "6000.0.47f1" -> 6000.
                std::string digits;
                for (char c : d.filename().string()) { if (c >= '0' && c <= '9') digits += c; else break; }
                if (digits.empty()) continue;
                long n = std::strtol(digits.c_str(), nullptr, 10);
                if (n >= 6000) add("unity" + std::to_string(n / 1000));         // 6000.x -> unity6, 7000.x -> unity7
                else if (n >= 2017 && n <= 2099) add("unity" + std::to_string(n)); // 2017..2023 year scheme
            }
        }
        return out;
    }

    std::vector<std::string> DefaultUnityEditorRoots()
    {
#if defined(_WIN32)
        const char* pf = std::getenv("ProgramFiles");
        return { std::string(pf ? pf : "C:\\Program Files") + "\\Unity\\Hub\\Editor" };
#elif defined(__APPLE__)
        return { "/Applications/Unity/Hub/Editor" };
#else
        const char* home = std::getenv("HOME");
        return home ? std::vector<std::string>{ std::string(home) + "/Unity/Hub/Editor" }
                    : std::vector<std::string>{};
#endif
    }

    // True if `name` resolves on PATH via the platform shell ('where' / 'command -v'),
    // which also finds .cmd/.bat shims like npm on Windows.
    static bool OnPath(const std::string& name)
    {
        ProcessOptions o;
#if defined(_WIN32)
        o.argv = { "cmd", "/c", "where " + name };
#else
        o.argv = { "/bin/sh", "-c", "command -v " + name };
#endif
        o.timeoutSeconds = 10;
        Process p;
        return p.Run(o, nullptr) == 0;
    }

    bool EnsureNpmGlobalTool(const std::string& tool, const std::string& package)
    {
        if (OnPath(tool)) return true;
        if (!OnPath("npm"))
        {
            LOG_WARNING("Smith", "%s not installed and npm is not on PATH - cannot auto-install it", tool.c_str());
            return false;
        }
        LOG_INFO("Smith", "%s not on PATH - installing it: npm install -g %s", tool.c_str(), package.c_str());
        ProcessOptions o;
#if defined(_WIN32)
        o.argv = { "cmd", "/c", "npm install -g " + package };
#else
        o.argv = { "/bin/sh", "-c", "npm install -g " + package };
#endif
        o.timeoutSeconds = 600;
        std::vector<std::string> tail;   // last lines of npm output, for the failure warning
        Process p;
        int rc = p.Run(o, [&](bool, const std::string& line) {
            if (line.empty()) return;
            tail.push_back(line);
            if (tail.size() > 8) tail.erase(tail.begin());
        });
        if (rc != 0)
        {
            std::string out;
            for (const auto& l : tail) out += "\n    " + l;
            LOG_WARNING("Smith", "npm install -g %s failed (exit %d)%s", package.c_str(), rc, out.c_str());
            return false;
        }
        if (!OnPath(tool))
        {
            LOG_WARNING("Smith", "npm installed %s, but %s is still not on PATH - add npm's global bin dir (npm prefix -g) to the agent's PATH",
                        package.c_str(), tool.c_str());
            return false;
        }
        LOG_INFO("Smith", "Installed %s", tool.c_str());
        return true;
    }

    std::vector<std::string> DetectPathToolLabels()
    {
        // Tool name doubles as the label. The shell resolves PATH (incl. .cmd/.bat
        // shims like npm on Windows, which CreateProcess alone would not find).
        // sbcl = Steel Bank Common Lisp; ruby/sbcl are interpreters whose binary
        // name is the label, so they ride the same PATH probe as the build tools.
        // wrangler = Cloudflare's CLI (a global npm install), used by Cloudflare handoffs.
        // git-lfs = Git Large File Storage (the binary git dispatches to; Git for Windows puts it on PATH next to
        // git.exe), needed to build projects that keep large files in Smith.
        static const char* kTools[] = { "cmake", "gcc", "clang", "node", "npm", "ruby", "sbcl", "wrangler", "git-lfs" };
        std::vector<std::string> out;
        for (const char* tool : kTools)
            if (OnPath(tool)) out.push_back(tool);
        return out;
    }

    std::vector<std::string> ShellLabelsFor(bool hasCmd, bool hasBash, bool hasPwsh,
                                            bool hasPowershell, bool isWindows)
    {
        std::vector<std::string> out;
        if (isWindows && hasCmd) out.push_back("cmd");          // cmd is Windows-only
        if (hasBash) out.push_back("bash");                     // Linux/Mac, or git-bash/WSL on Windows
        if (hasPwsh || hasPowershell) out.push_back("powershell"); // pwsh OR powershell.exe -> one label
        return out;
    }

    std::vector<std::string> DetectShellLabels()
    {
#if defined(_WIN32)
        const bool isWindows = true;
        const bool hasCmd = true;                      // cmd.exe ships with Windows
        const bool hasPowershell = OnPath("powershell"); // Windows PowerShell (powershell.exe)
#else
        const bool isWindows = false;
        const bool hasCmd = false;
        const bool hasPowershell = false;              // Windows PowerShell is Windows-only
#endif
        const bool hasBash = OnPath("bash");
        const bool hasPwsh = OnPath("pwsh");           // PowerShell Core, any OS
        return ShellLabelsFor(hasCmd, hasBash, hasPwsh, hasPowershell, isWindows);
    }

    // "UE_5.4" -> appends "unreal5" (and the generic "unreal") to out, deduped.
    static void AddUnrealLabels(const std::string& appName, std::vector<std::string>& out)
    {
        if (appName.rfind("UE_", 0) != 0) return;
        auto add = [&](const std::string& l) {
            if (std::find(out.begin(), out.end(), l) == out.end()) out.push_back(l);
        };
        add("unreal");
        std::string major;
        for (size_t i = 3; i < appName.size() && appName[i] >= '0' && appName[i] <= '9'; ++i)
            major += appName[i];
        if (!major.empty()) add("unreal" + major);
    }

    std::vector<std::string> ParseEpicLauncherInstalled(const std::string& jsonText)
    {
        std::vector<std::string> out;
        nlohmann::json j = nlohmann::json::parse(jsonText, nullptr, false);
        if (j.is_discarded() || !j.is_object() || !j.contains("InstallationList") || !j["InstallationList"].is_array())
            return out;
        for (const auto& e : j["InstallationList"])
            if (e.is_object() && e.contains("AppName") && e["AppName"].is_string())
                AddUnrealLabels(e["AppName"].get<std::string>(), out);
        return out;
    }

    std::vector<std::string> ScanUnrealInstallDirs(const std::vector<std::string>& roots)
    {
        std::vector<std::string> out;
        std::error_code ec;
        for (const auto& root : roots)
            for (fs::directory_iterator it(root, ec), end; it != end; it.increment(ec))
            {
                if (!it->is_directory(ec)) continue;
                std::string name = it->path().filename().string();
                if (name.rfind("UE_", 0) == 0 && fs::exists(it->path() / "Engine", ec))
                    AddUnrealLabels(name, out);
            }
        return out;
    }

    std::vector<std::string> DetectUnrealLabels()
    {
        std::vector<std::string> out;
#if defined(_WIN32)
        const char* pd = std::getenv("ProgramData");
        std::string dat = std::string(pd ? pd : "C:\\ProgramData") + "\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat";
        const char* pf = std::getenv("ProgramFiles");
        std::vector<std::string> roots = { std::string(pf ? pf : "C:\\Program Files") + "\\Epic Games" };
#elif defined(__APPLE__)
        std::string dat = "/Users/Shared/Epic Games/UnrealEngineLauncher/LauncherInstalled.dat";
        std::vector<std::string> roots = { "/Users/Shared/Epic Games" };
#else
        // No Epic launcher on Linux; cover the common source/binary drop locations.
        std::string dat;
        std::vector<std::string> roots;
        if (const char* home = std::getenv("HOME"))
        { roots.push_back(std::string(home) + "/UnrealEngine"); roots.push_back(std::string(home) + "/Epic Games"); }
#endif
        if (!dat.empty())
        {
            std::ifstream in(dat, std::ios::binary);
            if (in) { std::stringstream ss; ss << in.rdbuf(); out = ParseEpicLauncherInstalled(ss.str()); }
        }
        for (const auto& l : ScanUnrealInstallDirs(roots))
            if (std::find(out.begin(), out.end(), l) == out.end()) out.push_back(l);
        return out;
    }

    std::vector<std::string> ParseSteamLibraryFolders(const std::string& vdfText)
    {
        // Lines look like:   "path"		"D:\\SteamLibrary"
        std::vector<std::string> out;
        std::istringstream in(vdfText);
        std::string line;
        while (std::getline(in, line))
        {
            size_t key = line.find("\"path\"");
            if (key == std::string::npos) continue;
            size_t open = line.find('"', key + 6);
            if (open == std::string::npos) continue;
            std::string value;
            size_t i = open + 1;
            for (; i < line.size() && line[i] != '"'; ++i)
            {
                if (line[i] == '\\' && i + 1 < line.size()) ++i;   // VDF escapes: \\ -> \, \" -> "
                value += line[i];
            }
            if (i < line.size() && !value.empty()) out.push_back(value);
        }
        return out;
    }

    // "Blender 4.2" -> {4,2}; "blender-4.2.1-linux-x64" -> {4,2,1}: the first run of digits
    // and dots, so a trailing "x64" never reads as a version. {} when the name has none.
    static std::vector<int> BlenderDirVersion(const std::string& name)
    {
        std::vector<int> v;
        size_t i = name.find_first_of("0123456789");
        if (i == std::string::npos) return v;
        int cur = 0; bool any = false;
        for (; i < name.size() && ((name[i] >= '0' && name[i] <= '9') || name[i] == '.'); ++i)
        {
            if (name[i] == '.') { if (any) v.push_back(cur); cur = 0; any = false; }
            else { cur = cur * 10 + (name[i] - '0'); any = true; }
        }
        if (any) v.push_back(cur);
        return v;
    }

    std::string FindBlenderIn(const std::vector<std::string>& installRoots,
                              const std::vector<std::string>& exactPaths)
    {
        std::error_code ec;
        std::string best;
        std::vector<int> bestVersion;
        for (const auto& root : installRoots)
        {
            for (fs::directory_iterator it(root, ec), end; it != end; it.increment(ec))
            {
                if (!it->is_directory(ec)) continue;
                std::string name = it->path().filename().string();
                std::string lower = name;
                std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return (char)std::tolower(c); });
                if (lower.rfind("blender", 0) != 0) continue;
                for (const char* exe : { "blender.exe", "blender", "Blender.app/Contents/MacOS/Blender" })
                {
                    fs::path candidate = it->path() / fs::path(exe).make_preferred();  // native separators, so callers see one style
                    if (!fs::is_regular_file(candidate, ec)) continue;
                    std::vector<int> version = BlenderDirVersion(name);
                    if (best.empty() || version > bestVersion) { best = candidate.string(); bestVersion = version; }
                    break;
                }
            }
        }
        if (!best.empty()) return best;
        for (const auto& path : exactPaths)
            if (fs::is_regular_file(path, ec)) return path;
        return "";
    }

    // The full path `name` resolves to on PATH, or "" (first line of 'where' / 'command -v').
    static std::string WhichOnPath(const std::string& name)
    {
        ProcessOptions o;
#if defined(_WIN32)
        o.argv = { "cmd", "/c", "where " + name };
#else
        o.argv = { "/bin/sh", "-c", "command -v " + name };
#endif
        o.timeoutSeconds = 10;
        std::string first;
        Process p;
        int rc = p.Run(o, [&](bool isStderr, const std::string& line) {
            if (!isStderr && first.empty() && !line.empty()) first = line;
        });
        while (!first.empty() && (first.back() == '\r' || first.back() == ' ')) first.pop_back();
        return rc == 0 ? first : "";
    }

    std::string FindBlender()
    {
        std::string onPath = WhichOnPath("blender");
        // 'command -v' prints a bare name for a shell builtin/alias; only a real path counts.
        if (!onPath.empty() && fs::path(onPath).is_absolute()) return onPath;

        std::vector<std::string> roots, exact;
        std::vector<std::string> steamApps;   // <Steam>/steamapps dirs whose libraryfolders.vdf lists more libraries
#if defined(_WIN32)
        for (const char* var : { "ProgramFiles", "ProgramW6432", "LOCALAPPDATA" })
            if (const char* v = std::getenv(var))
                roots.push_back(std::string(v) + (std::string(var) == "LOCALAPPDATA" ? "\\Programs\\Blender Foundation" : "\\Blender Foundation"));
        const char* pf86 = std::getenv("ProgramFiles(x86)");
        steamApps.push_back(std::string(pf86 ? pf86 : "C:\\Program Files (x86)") + "\\Steam\\steamapps");
        const char* steamExe = "blender.exe";
#elif defined(__APPLE__)
        exact.push_back("/Applications/Blender.app/Contents/MacOS/Blender");
        const char* home = std::getenv("HOME");
        if (home)
        {
            exact.push_back(std::string(home) + "/Applications/Blender.app/Contents/MacOS/Blender");
            steamApps.push_back(std::string(home) + "/Library/Application Support/Steam/steamapps");
        }
        const char* steamExe = "Blender.app/Contents/MacOS/Blender";
#else
        // Official tarballs are unpacked wherever people like; these are the usual places.
        roots.push_back("/opt");
        exact.push_back("/snap/bin/blender");
        exact.push_back("/usr/bin/blender");
        const char* home = std::getenv("HOME");
        if (home)
        {
            roots.push_back(home);
            roots.push_back(std::string(home) + "/Applications");
            steamApps.push_back(std::string(home) + "/.steam/steam/steamapps");
            steamApps.push_back(std::string(home) + "/.local/share/Steam/steamapps");
        }
        const char* steamExe = "blender";
#endif
        // Steam's Blender lives in <library>/steamapps/common/Blender; the main library plus
        // any others the user added (libraryfolders.vdf).
        std::vector<std::string> libraries;
        for (const auto& apps : steamApps)
        {
            libraries.push_back(fs::path(apps).parent_path().string());
            std::ifstream in(fs::path(apps) / "libraryfolders.vdf", std::ios::binary);
            if (!in) continue;
            std::stringstream ss; ss << in.rdbuf();
            for (const auto& lib : ParseSteamLibraryFolders(ss.str())) libraries.push_back(lib);
        }
        for (const auto& lib : libraries)
            exact.push_back((fs::path(lib) / "steamapps" / "common" / "Blender" / steamExe).string());
        return FindBlenderIn(roots, exact);
    }

    GpuInfo ParseNvidiaSmiMemory(const std::string& csv)
    {
        GpuInfo g;
        std::istringstream in(csv);
        std::string line;
        while (std::getline(in, line))
        {
            // Each line is "<total>, <free>" in MiB (nounits). Tolerate stray spaces,
            // a trailing " MiB", and blank lines.
            size_t comma = line.find(',');
            if (comma == std::string::npos) continue;
            auto firstInt = [](const std::string& s) -> long {
                size_t i = 0; while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
                if (i >= s.size() || s[i] < '0' || s[i] > '9') return -1;
                return std::strtol(s.c_str() + i, nullptr, 10);
            };
            long total = firstInt(line.substr(0, comma));
            long free = firstInt(line.substr(comma + 1));
            if (total < 0 || free < 0) continue;
            g.totalMb += (int)total;
            g.freeMb += (int)free;
            g.present = true;
        }
        return g;
    }

    GpuInfo DetectGpu()
    {
        ProcessOptions o;
        o.argv = { "nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits" };
        o.timeoutSeconds = 10;
        std::string out;
        Process p;
        int rc = p.Run(o, [&](bool isStderr, const std::string& line) {
            if (!isStderr) { out += line; out += '\n'; }
        });
        if (rc != 0) return GpuInfo{};   // nvidia-smi missing or errored -> no GPU
        return ParseNvidiaSmiMemory(out);
    }
}
