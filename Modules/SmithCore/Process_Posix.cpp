// Process_Posix.cpp - POSIX (Linux/macOS) implementation of Smith::Process.
// Not compiled on Windows.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Process.h"

#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <fcntl.h>
#include <cstring>
#include <cstdlib>
#include <thread>
#include <mutex>
#include <chrono>
#include <cerrno>
#include <string>
#include <vector>

extern char** environ;

namespace Smith
{
    struct Process::Impl
    {
        pid_t pid = -1;
        std::thread outReader;
        std::thread errReader;
        std::mutex callbackMutex;
        bool started = false;
        bool timedOut = false;
        int timeoutSeconds = 0;
        int exitCode = -1;
        int stdinFd = -1;          // write end of the child's stdin pipe (ProcessOptions::stdinPipe)
        std::mutex stdinMutex;
    };

    Process::Process() : m_impl(new Impl()) {}

    Process::~Process()
    {
        CloseStdin();
        if (m_impl->started && Running()) Kill();
        if (m_impl->outReader.joinable()) m_impl->outReader.join();
        if (m_impl->errReader.joinable()) m_impl->errReader.join();
    }

    static void ReaderLoop(int fd, bool isStderr, ProcessLineCallback onLine, std::mutex* mtx)
    {
        std::string acc;
        char buf[4096];
        for (;;)
        {
            ssize_t n = read(fd, buf, sizeof(buf));
            if (n <= 0) break;
            acc.append(buf, buf + n);
            size_t pos;
            while ((pos = acc.find('\n')) != std::string::npos)
            {
                std::string line = acc.substr(0, pos);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                if (onLine)
                {
                    std::lock_guard<std::mutex> lk(*mtx);
                    onLine(isStderr, line);
                }
                acc.erase(0, pos + 1);
            }
        }
        if (!acc.empty())
        {
            if (acc.back() == '\r') acc.pop_back();
            if (onLine)
            {
                std::lock_guard<std::mutex> lk(*mtx);
                onLine(isStderr, acc);
            }
        }
        close(fd);
    }

    // Pipe ends are close-on-exec so that a child forked concurrently on another thread
    // cannot inherit THIS pipe's write end. If it did, it would hold the pipe open for
    // its whole lifetime, our reader would never see EOF, and the thread waiting on that
    // reader would park for good - a long-lived service started next to a git fetch is
    // exactly that case. The dup2 calls below clear the flag for the child's own
    // stdout/stderr, which is the only pair it should keep across exec.
    static bool MakeClosedOnExecPipe(int fds[2])
    {
#if defined(__linux__)
        return pipe2(fds, O_CLOEXEC) == 0;
#else
        if (pipe(fds) != 0) return false;
        fcntl(fds[0], F_SETFD, FD_CLOEXEC);
        fcntl(fds[1], F_SETFD, FD_CLOEXEC);
        return true;
#endif
    }

    // Crash containment (ProcessOptions::stopWithParent). Runs in the freshly forked
    // child, after setpgid and before exec: forks a grandchild that sits in the
    // child's process group holding no pipes, and polls two things - is the build
    // (its parent) still alive, and is the agent (the original process) still alive?
    // Build gone: exit quietly. Agent gone: SIGKILL the whole group, itself included.
    // A kill(pid, 0) probe is used rather than a parent-death signal so the same
    // code serves macOS, which has no PR_SET_PDEATHSIG.
    static void ForkSentinel(pid_t agent)
    {
        pid_t sentinel = fork();
        if (sentinel != 0) return;   // the build child (or a failed fork) carries on
        const pid_t group = getpgrp();
        int devnull = open("/dev/null", O_RDWR);
        if (devnull >= 0) { dup2(devnull, STDIN_FILENO); dup2(devnull, STDOUT_FILENO); dup2(devnull, STDERR_FILENO); }
        for (int fd = 3; fd < 1024; ++fd) close(fd);   // never hold the build's pipes open
        for (;;)
        {
            if (getppid() == 1 || getppid() != group) _exit(0);              // build finished: nothing to guard
            if (kill(agent, 0) != 0 && errno == ESRCH) { killpg(group, SIGKILL); _exit(0); }
            usleep(500 * 1000);
        }
    }

    bool Process::Start(const ProcessOptions& options, ProcessLineCallback onLine)
    {
        if (options.argv.empty()) return false;
        m_impl->timeoutSeconds = options.timeoutSeconds;

        int outPipe[2], errPipe[2];
        if (!MakeClosedOnExecPipe(outPipe)) return false;
        if (!MakeClosedOnExecPipe(errPipe)) { close(outPipe[0]); close(outPipe[1]); return false; }

        // Binary stdout: the child writes straight into the file; no reader thread on that side.
        int outFd = -1;
        if (!options.stdoutFile.empty())
        {
            outFd = open(options.stdoutFile.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
            if (outFd < 0)
            {
                close(outPipe[0]); close(outPipe[1]);
                close(errPipe[0]); close(errPipe[1]);
                return false;
            }
        }

        int inFd = -1, inWrite = -1;
        if (options.stdinPipe)
        {
            // A child that exits early must not take this process down with SIGPIPE on the next write.
            static std::once_flag ignoreSigpipe;
            std::call_once(ignoreSigpipe, [] { signal(SIGPIPE, SIG_IGN); });
            int inPipe[2];
            if (!MakeClosedOnExecPipe(inPipe))
            {
                close(outPipe[0]); close(outPipe[1]);
                close(errPipe[0]); close(errPipe[1]);
                if (outFd >= 0) close(outFd);
                return false;
            }
            inFd = inPipe[0]; inWrite = inPipe[1];
        }
        else if (!options.stdinFile.empty())
        {
            inFd = open(options.stdinFile.c_str(), O_RDONLY | O_CLOEXEC);
            if (inFd < 0)
            {
                close(outPipe[0]); close(outPipe[1]);
                close(errPipe[0]); close(errPipe[1]);
                if (outFd >= 0) close(outFd);
                return false;
            }
        }

        // Names to remove from the child's environment, matched here so the child (forked from a
        // multithreaded process) does no allocation of its own.
        std::vector<std::string> unsetNames;
        for (char** entry = environ; entry && *entry && !options.envUnset.empty(); ++entry)
        {
            const std::string name(*entry, strcspn(*entry, "="));
            for (const auto& pattern : options.envUnset)
            {
                const bool prefix = !pattern.empty() && pattern.back() == '*';
                const size_t length = prefix ? pattern.size() - 1 : pattern.size();
                if (prefix ? name.compare(0, length, pattern, 0, length) == 0 && name.size() >= length : name == pattern) { unsetNames.push_back(name); break; }
            }
        }

        // Build argv as a C array (kept alive across fork).
        std::vector<char*> argv;
        argv.reserve(options.argv.size() + 1);
        for (const auto& a : options.argv) argv.push_back(const_cast<char*>(a.c_str()));
        argv.push_back(nullptr);

        const pid_t parent = getpid();
        pid_t pid = fork();
        if (pid < 0)
        {
            close(outPipe[0]); close(outPipe[1]);
            close(errPipe[0]); close(errPipe[1]);
            if (inFd >= 0) close(inFd);
            if (inWrite >= 0) close(inWrite);
            if (outFd >= 0) close(outFd);
            return false;
        }

        if (pid == 0)
        {
            // Child: own process group so we can kill the whole tree.
            setpgid(0, 0);
            if (options.stopWithParent) ForkSentinel(parent);
            dup2(outFd >= 0 ? outFd : outPipe[1], STDOUT_FILENO);
            dup2(errPipe[1], STDERR_FILENO);
            if (inFd >= 0) dup2(inFd, STDIN_FILENO);
            close(outPipe[0]); close(outPipe[1]);
            close(errPipe[0]); close(errPipe[1]);

            for (const auto& name : unsetNames) unsetenv(name.c_str());
            for (const auto& kv : options.envOverride)
            {
                setenv(kv.first.c_str(), kv.second.c_str(), 1);
            }
            if (!options.workingDir.empty())
            {
                if (chdir(options.workingDir.c_str()) != 0) _exit(126);
            }
            execvp(argv[0], argv.data());
            _exit(127); // exec failed
        }

        // Parent.
        if (inFd >= 0) close(inFd);
        if (outFd >= 0) close(outFd);
        { std::lock_guard<std::mutex> lock(m_impl->stdinMutex); m_impl->stdinFd = inWrite; }
        close(outPipe[1]);
        close(errPipe[1]);
        setpgid(pid, pid); // race-safe duplicate of the child's setpgid

        m_impl->pid = pid;
        m_impl->started = true;
        m_impl->timedOut = false;
        if (outFd >= 0) close(outPipe[0]);   // stdout went to the file: nothing to read here
        else m_impl->outReader = std::thread(ReaderLoop, outPipe[0], false, onLine, &m_impl->callbackMutex);
        m_impl->errReader = std::thread(ReaderLoop, errPipe[0], true, onLine, &m_impl->callbackMutex);
        return true;
    }

    int Process::Wait()
    {
        if (!m_impl->started) return -1;

        int status = 0;
        if (m_impl->timeoutSeconds > 0)
        {
            auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(m_impl->timeoutSeconds);
            for (;;)
            {
                pid_t r = waitpid(m_impl->pid, &status, WNOHANG);
                if (r == m_impl->pid) break;
                if (r < 0) break;
                if (std::chrono::steady_clock::now() >= deadline)
                {
                    m_impl->timedOut = true;
                    Kill();
                    waitpid(m_impl->pid, &status, 0);
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
        }
        else
        {
            waitpid(m_impl->pid, &status, 0);
        }

        CloseStdin();
        if (m_impl->outReader.joinable()) m_impl->outReader.join();
        if (m_impl->errReader.joinable()) m_impl->errReader.join();

        if (m_impl->timedOut)
            m_impl->exitCode = -1;
        else
            m_impl->exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        return m_impl->exitCode;
    }

    int Process::Run(const ProcessOptions& options, ProcessLineCallback onLine)
    {
        if (!Start(options, onLine)) return -1;
        return Wait();
    }

    void Process::Kill()
    {
        if (m_impl->pid > 0)
        {
            killpg(m_impl->pid, SIGTERM);
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            killpg(m_impl->pid, SIGKILL);
        }
    }

    bool Process::Running() const
    {
        if (!m_impl->started || m_impl->pid <= 0) return false;
        int status = 0;
        pid_t r = waitpid(m_impl->pid, &status, WNOHANG);
        return r == 0;
    }

    bool Process::TimedOut() const { return m_impl->timedOut; }

    bool Process::WriteStdin(const std::string& data)
    {
        std::lock_guard<std::mutex> lock(m_impl->stdinMutex);
        size_t offset = 0;
        while (m_impl->stdinFd >= 0 && offset < data.size())
        {
            const ssize_t n = write(m_impl->stdinFd, data.data() + offset, data.size() - offset);
            if (n > 0) { offset += (size_t)n; continue; }
            if (n < 0 && errno == EINTR) continue;
            return false;
        }
        return m_impl->stdinFd >= 0;
    }

    void Process::CloseStdin()
    {
        std::lock_guard<std::mutex> lock(m_impl->stdinMutex);
        if (m_impl->stdinFd >= 0) { close(m_impl->stdinFd); m_impl->stdinFd = -1; }
    }
}
