#pragma once
#include <string>
#include <memory>
#include <vector>
namespace Smith {
    // Platform code creates owner-only objects, refuses links, and replaces state atomically.
    std::string HostedSha256(const std::string& bytes);
    // SHA-256 of a file read in 1 MiB chunks (large files kept on this machine); throws when it cannot be read.
    std::string HostedSha256File(const std::string& path);
    std::string HostedExecutablePath();
    std::string HostedReadArtifact(const std::string& root, const std::string& relative, size_t maximum);
    bool HostedDrainRequested(const std::string& path);
    bool HostedCrashContainmentAvailable();
    bool HostedFileIsPrivate(const std::string& path);
    void HostedSecureDirectory(const std::string& path);
    void HostedSecureWrite(const std::string& path, const std::string& bytes);
    std::string HostedReadSecret();
    // True for a symlink, junction or any other reparse point (a crew checkout must contain none).
    bool HostedIsLink(const std::string& path);
    // argv that runs a PATH-resolved command-line tool (Windows resolves npm .cmd shims through cmd.exe).
    std::vector<std::string> HostedToolArgv(const std::string& tool, const std::vector<std::string>& args);
    struct HostedWorkspaceLock { virtual ~HostedWorkspaceLock() = default; };
    std::unique_ptr<HostedWorkspaceLock> HostedLockWorkspace(const std::string& path);
    // Nonblocking OS lock: shared for tool use, exclusive for global tool updates.
    std::unique_ptr<HostedWorkspaceLock> HostedTryToolLock(const std::string& path, bool exclusive);
}
