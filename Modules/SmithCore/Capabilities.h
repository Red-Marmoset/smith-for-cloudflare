// Capabilities.h - auto-derive an agent's capability labels from its environment, so
// it advertises what it can actually build without manual --agent-labels.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>

namespace Smith
{
    // Capability labels implied by a bootstrapped Una engine at enginePath. Returns
    // {"una-engine"} when enginePath has a built BuildTool (Release / MinSizeRel / Debug /
    // Bootstrap), otherwise {}. Pure + filesystem-only, so it is unit-testable. Agents
    // merge these with any manual --agent-labels before registering.
    std::vector<std::string> DetectCapabilityLabels(const std::string& enginePath);

    // Capability labels implied by installed Unity editors: "unity-linux" when any
    // editor under `editorRoots` has the Linux build-support module installed, plus
    // "unity-linux-il2cpp" when that module's IL2CPP player variations are present
    // (Unity cross-compiles Linux IL2CPP from Windows/macOS via its own sysroot, so
    // a Windows node with the module CAN build Linux players). Each root is a Unity
    // Hub "Editor" directory holding per-version installs. Pure + filesystem-only,
    // so it is unit-testable; agents pass DefaultUnityEditorRoots().
    std::vector<std::string> DetectUnityLinuxLabels(const std::vector<std::string>& editorRoots);

    // Capability labels for Unity mobile build-support modules: "unity-ios" when any
    // editor under `editorRoots` has iOSSupport installed, "unity-android" for
    // AndroidPlayer. Same layouts as DetectUnityLinuxLabels. Pure + filesystem-only.
    std::vector<std::string> DetectUnityMobileLabels(const std::vector<std::string>& editorRoots);

    // Capability labels for installed Unity editors, keyed by major version: a
    // "6000.x" editor yields "unity6" (Unity 6's version scheme), a "7000.x" ->
    // "unity7"; year-scheme editors (e.g. "2022.3.10f1") yield "unity2022". A
    // version-named dir counts only once it holds a real editor binary
    // (Editor/Unity.exe on Windows, Unity.app on macOS, Editor/Unity on Linux),
    // so an in-progress Hub download is ignored until it finishes. Deduped.
    // Pure + filesystem-only, so it is unit-testable; agents pass
    // DefaultUnityEditorRoots().
    std::vector<std::string> DetectUnityVersionLabels(const std::vector<std::string>& editorRoots);

    // The platform's default Unity Hub editor-install root(s).
    std::vector<std::string> DefaultUnityEditorRoots();

    // Labels for common build tools / interpreters found on PATH (cmake, gcc,
    // clang, node, npm, ruby, sbcl, wrangler). Each is resolved via the platform shell
    // ('where' / 'command -v') so .cmd/.bat shims like npm count. Spawns one cheap
    // probe per tool - call once at registration, not per heartbeat.
    std::vector<std::string> DetectPathToolLabels();

    // Make an npm-distributed CLI available: when `tool` isn't on PATH but npm is, run
    // `npm install -g <package>` (up to 10 min). Returns true if `tool` resolves on PATH
    // afterwards; failures (no npm, no write access to npm's global prefix, prefix bin
    // not on PATH) are logged as warnings. Spawns subprocesses - call once at startup.
    bool EnsureNpmGlobalTool(const std::string& tool, const std::string& package);

    // Pure: which shell labels a node advertises given which shell binaries resolved
    // on PATH. "cmd" is Windows-only; "bash" wherever a bash binary exists (Linux/Mac,
    // or git-bash/WSL on Windows); "powershell" when either powershell.exe OR pwsh
    // (PowerShell Core) is present - a single "powershell" label, never "pwsh". Order
    // is stable (cmd, bash, powershell) and the result is deduped. Unit-testable.
    std::vector<std::string> ShellLabelsFor(bool hasCmd, bool hasBash, bool hasPwsh,
                                            bool hasPowershell, bool isWindows);

    // Shell labels for THIS machine: probes the shells on PATH (one cheap probe each)
    // and feeds ShellLabelsFor. Spawns subprocesses - call once at registration.
    std::vector<std::string> DetectShellLabels();

    // Pure: parse Epic's LauncherInstalled.dat JSON into Unreal labels - "unreal"
    // plus one per installed major ("unreal4"/"unreal5"/...). Entries whose
    // AppName is not UE_* (e.g. the launcher itself) are ignored.
    std::vector<std::string> ParseEpicLauncherInstalled(const std::string& jsonText);

    // Filesystem scan for UE_* dirs (with an Engine/ inside) under the given
    // roots - the fallback for source builds / non-launcher installs. Pure +
    // unit-testable like DetectUnityLinuxLabels.
    std::vector<std::string> ScanUnrealInstallDirs(const std::vector<std::string>& roots);

    // Unreal labels for this machine: LauncherInstalled.dat (authoritative when
    // present) merged with a scan of the platform's default Epic install dirs.
    std::vector<std::string> DetectUnrealLabels();

    // Pure: the library roots listed in Steam's steamapps/libraryfolders.vdf (each
    // "path" value, with VDF's doubled backslashes undone). Garbage -> {}.
    std::vector<std::string> ParseSteamLibraryFolders(const std::string& vdfText);

    // Pure + filesystem-only: a Blender executable among the given places, or "".
    // Each of `installRoots` holds versioned installs ("Blender 4.2", "blender-4.2.1-linux-x64")
    // with blender.exe / blender / Blender.app inside; the newest version wins. Failing
    // that, the first of `exactPaths` that exists. Unit-testable with temp dirs.
    std::string FindBlenderIn(const std::vector<std::string>& installRoots,
                              const std::vector<std::string>& exactPaths);

    // Blender on THIS machine: PATH first (the Microsoft Store alias, snap, a distro
    // package), then the platform's install locations - Blender's Windows and macOS
    // installers do not touch PATH - and Steam libraries. "" when absent. Spawns one
    // probe; call once at registration. Agents advertise "blender" when found, give
    // builds the path as SMITH_BLENDER and run an "exe" step named "blender" with it.
    std::string FindBlender();

    // GPU VRAM in MiB. present=false when no NVIDIA GPU / nvidia-smi was found.
    // (Used to place the Discord bot on the agent with the most free GPU memory.)
    struct GpuInfo
    {
        int totalMb = 0;
        int freeMb = 0;
        bool present = false;
    };

    // Parse the CSV output of
    //   nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits
    // e.g. "24576, 23000\n8192, 8000". Sums total/free across all GPU lines. Pure +
    // unit-testable; empty/garbage -> {0,0,false}.
    GpuInfo ParseNvidiaSmiMemory(const std::string& csv);

    // Detect total/free GPU VRAM by invoking nvidia-smi. {0,0,false} if it is not
    // installed or fails. Spawns a subprocess, so callers should cache the result.
    GpuInfo DetectGpu();
}
