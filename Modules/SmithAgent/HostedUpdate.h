// HostedUpdate.h - hosted agents keep themselves on the coordinator's published package.
//
// The coordinator's heartbeat reply names the current package for this machine's OS. When the
// running agent differs and is idle, it downloads that package, checks it (the commit in its
// release-info.json is the advertised version and hashes the binary inside it, and the staged
// binary runs), swaps the files into its own folder keeping the replaced ones in .update-previous,
// and exits with kHostedExitUpdated. The launcher (Start-Smith.bat / start-smith.sh) restarts it at
// once. The new agent confirms itself after its first accepted heartbeat; if it exits first, or
// is not online within a few minutes, the launcher puts the previous files back and records the
// version as rejected so it is not tried again.
//
// Only an agent started by such a launcher (SMITH_UPDATE_SUPERVISED=1) from a packaged folder (one
// with release-info.json) updates itself; a development build never touches its build folder.
#pragma once
#include <string>
namespace Smith {
    // The launcher restarts the agent straight away.
    constexpr int kHostedExitUpdated = 10;
    // The new version never came online: the launcher goes back to the previous one.
    constexpr int kHostedExitUpdateUnconfirmed = 11;

    struct HostedUpdateOffer { std::string version, sha256; long long size = 0; };

    // Pure: the "update" object of a heartbeat reply, validated. False when there is none or it
    // is malformed (an older coordinator sends none).
    bool HostedParseUpdateOffer(const std::string& heartbeatReply, HostedUpdateOffer& offer);
    // Pure: whether a package entry may be unpacked: a plain file name, no folders or links.
    bool HostedPackageEntryValid(const std::string& name);
    // The version a packaged folder carries ("hosted-<12 hex>"), checked against its binary's hash.
    // Throws when release-info.json is invalid or does not describe `executableName`.
    std::string HostedPackageVersion(const std::string& directory, const std::string& executableName);

    // Whether this agent may update itself, and if not, why (printed once).
    bool HostedSelfUpdateEnabled(std::string& reason);
    // A version the launcher rolled back from, so it is not offered again ("" when none).
    std::string HostedRejectedVersion(const std::string& installDir);
    // The version an unconfirmed update installed ("" when none is pending).
    std::string HostedPendingUpdate(const std::string& installDir);
    // The new version is online: forget the pending marker and the previous files.
    void HostedConfirmUpdate(const std::string& installDir);

    // Unpacks `zipPath` into a fresh `stagingDir` and checks it carries `version` and that its
    // binary starts. Returns "" when the package is good, otherwise why not.
    std::string HostedStagePackage(const std::string& zipPath, const std::string& stagingDir,
                                   const std::string& executableName, const std::string& version);
    // Moves the staged files into `installDir`, the replaced ones into installDir/.update-previous,
    // and writes the pending marker. On failure the files moved so far are put back and it throws.
    void HostedApplyStagedPackage(const std::string& installDir, const std::string& stagingDir,
                                  const std::string& fromVersion, const std::string& toVersion);
}
