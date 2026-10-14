// Handoff.h - built-in deploy/handoff steps.
//
// The builders here are PURE: they turn a handoff step's fields + resolved
// credentials into an argv/env command, with no process execution. That keeps
// them unit-testable without ever invoking steamcmd / butler / wrangler - Smith
// never runs a real publish during development. The agent executes the returned
// command via the streaming Process.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>
#include <map>

namespace Smith
{
    // A resolved external command for a handoff step. Credentials are injected as
    // environment variables (never logged), never passed back to the coordinator.
    struct HandoffCommand
    {
        std::vector<std::string> argv;                  // argv[0] = program
        std::map<std::string, std::string> env;         // extra env (credentials etc.)
        std::string workingDir;
        std::string error;                              // non-empty => misconfigured step
        // Directories whose *.log files the agent tails into the build log while
        // the command runs. steamcmd block-buffers its stdout when piped (all
        // output arrives on exit) but writes depot progress to each app-build
        // VDF's BuildOutput dir live - tailing those is the only live signal.
        std::vector<std::string> tailDirs;
    };

    // ${VAR} substitution; unknown variables are left untouched.
    std::string SubstituteVars(const std::string& in, const std::map<std::string, std::string>& vars);

    // Resolve credentials for `ref` from an agent-local JSON file of the form
    //   { "ref-name": { "key": "value", ... }, ... }
    // Returns an empty map if the file/ref is absent. Credentials live only on the
    // agent; the coordinator only ever names a ref.
    std::map<std::string, std::string> ResolveCredentials(const std::string& credentialsFile,
                                                          const std::string& ref);

    // Extract the "BuildOutput" value from app-build VDF text ("" if absent).
    // Pure text parsing; the caller resolves it against the VDF's directory.
    std::string ParseVdfBuildOutput(const std::string& vdfText);

    // Return `vdfText` with its "Desc" value (the description Steamworks shows
    // next to the upload) replaced by `desc`; a missing "Desc" key is inserted at
    // the top of the root block. Double quotes in `desc` become single quotes
    // (VDF values are quote-delimited). Pure text transform.
    std::string PatchVdfDesc(const std::string& vdfText, const std::string& desc);

    // Pure builders. `fields` are assumed already ${VAR}-substituted; `workingDir`
    // is the absolute build directory. Relative path fields resolve under it.
    // One declared exception to purity: when a steam step carries a 'desc' field,
    // BuildSteamCommand writes a desc-patched sibling copy of each app-build VDF
    // (<name>.smith.vdf) and builds from that - steamcmd only reads the upload
    // description from the VDF itself.
    HandoffCommand BuildScriptCommand(const std::map<std::string, std::string>& fields,
                                      const std::string& workingDir);
    HandoffCommand BuildSteamCommand(const std::map<std::string, std::string>& fields,
                                     const std::map<std::string, std::string>& creds,
                                     const std::string& workingDir);
    HandoffCommand BuildItchCommand(const std::map<std::string, std::string>& fields,
                                    const std::map<std::string, std::string>& creds,
                                    const std::string& workingDir);
    HandoffCommand BuildCloudflareCommand(const std::map<std::string, std::string>& fields,
                                          const std::map<std::string, std::string>& creds,
                                          const std::string& workingDir);
}
