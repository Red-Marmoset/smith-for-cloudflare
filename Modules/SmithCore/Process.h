// Process.h - Streaming cross-platform subprocess.
//
// Unlike the engine's blocking ExecuteAndCaptureOutput, this delivers stdout and
// stderr line-by-line as they arrive (for live build logs), captures the exit
// code, injects environment variables, sets the working directory, and can kill
// the whole child process tree (Unity / npm spawn children) on demand or timeout.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <string>
#include <vector>
#include <map>
#include <functional>
#include <memory>

namespace Smith
{
    struct ProcessOptions
    {
        std::vector<std::string> argv;                  // argv[0] = program/script
        std::string workingDir;                         // empty = inherit current dir
        std::map<std::string, std::string> envOverride; // merged over the inherited env
        std::vector<std::string> envUnset;              // removed from the inherited env first; "NAME_*" removes a prefix
                                                        // (case-insensitive on Windows). envOverride still applies after.
        int timeoutSeconds = 0;                         // 0 = no timeout
        std::string stdinFile;                          // child's stdin; empty = none (EOF on Windows, inherited on POSIX).
                                                        // Lets callers hand over text without shell or argv quoting.
        bool stdinPipe = false;                         // child's stdin is a pipe fed by WriteStdin() (overrides stdinFile),
                                                        // for a conversation with the child (e.g. a JSON-RPC server).
        std::string stdoutFile;                         // child's stdout written to this file as raw bytes (created 0600,
                                                        // truncated), for binary output such as a git packfile; the line
                                                        // callback then receives stderr only. Empty = stream stdout by line.
        // Kill the child's whole process tree if THIS process dies while it runs
        // (crash, kill -9, power-off of the agent). Windows always does this via the
        // kill-on-close job object; on POSIX it forks a sentinel into the child's
        // process group that SIGKILLs the group when it sees the parent go.
        bool stopWithParent = false;
    };

    // Invoked for each complete output line as it arrives (trailing newline and
    // CR stripped). May be called concurrently is prevented: calls are serialized.
    using ProcessLineCallback = std::function<void(bool isStderr, const std::string& line)>;

    class Process
    {
    public:
        Process();
        ~Process();
        Process(const Process&) = delete;
        Process& operator=(const Process&) = delete;

        // Launch the process. stdout/stderr are drained on background threads and
        // delivered to onLine (may be null). Returns false if it could not start.
        bool Start(const ProcessOptions& options, ProcessLineCallback onLine);

        // Block until the process exits (or the timeout elapses, which triggers a
        // Kill()). Returns the exit code; a killed/timed-out process returns a
        // negative value. Call once after Start().
        int Wait();

        // Convenience: Start() then Wait().
        int Run(const ProcessOptions& options, ProcessLineCallback onLine);

        // Terminate the process and its child tree.
        void Kill();

        // With ProcessOptions::stdinPipe: write to the child's stdin (false once it is closed or the
        // child stopped reading), and close it so the child sees end of input. Thread-safe.
        bool WriteStdin(const std::string& data);
        void CloseStdin();

        bool Running() const;

        // True if the last Wait() ended because the timeout elapsed.
        bool TimedOut() const;

    private:
        struct Impl;
        std::unique_ptr<Impl> m_impl;
    };
}
