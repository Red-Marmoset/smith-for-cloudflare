// Process_Windows.cpp - Windows implementation of Smith::Process.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Process.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <string>
#include <vector>
#include <thread>
#include <algorithm>
#include <wchar.h>
#include <mutex>

namespace Smith
{
    static std::wstring Widen(const std::string& s)
    {
        if (s.empty()) return std::wstring();
        int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
        std::wstring w((size_t)n, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
        return w;
    }

    // Quote a single argument per the CommandLineToArgvW rules so build scripts
    // receive exactly the argv we intend.
    static void ArgvQuote(const std::string& arg, std::string& out)
    {
        if (!arg.empty() && arg.find_first_of(" \t\n\v\"") == std::string::npos)
        {
            out += arg;
            return;
        }
        out += '"';
        for (size_t i = 0;; ++i)
        {
            unsigned backslashes = 0;
            while (i < arg.size() && arg[i] == '\\') { ++i; ++backslashes; }
            if (i == arg.size())
            {
                out.append(backslashes * 2, '\\');
                break;
            }
            else if (arg[i] == '"')
            {
                out.append(backslashes * 2 + 1, '\\');
                out += '"';
            }
            else
            {
                out.append(backslashes, '\\');
                out += arg[i];
            }
        }
        out += '"';
    }

    static std::string BuildCommandLine(const std::vector<std::string>& argv)
    {
        std::string cmd;
        for (size_t i = 0; i < argv.size(); ++i)
        {
            if (i) cmd += ' ';
            ArgvQuote(argv[i], cmd);
        }
        return cmd;
    }

    struct CiLess
    {
        bool operator()(const std::wstring& a, const std::wstring& b) const
        {
            return _wcsicmp(a.c_str(), b.c_str()) < 0;
        }
    };

    // Snapshot the parent environment, apply overrides, and serialize a sorted
    // double-null-terminated Unicode block for CreateProcessW.
    // Windows environment names are case-insensitive, so the patterns are too.
    static bool Unset(const std::wstring& name, const std::vector<std::string>& patterns)
    {
        for (const auto& pattern : patterns)
        {
            std::wstring wide = Widen(pattern);
            const bool prefix = !wide.empty() && wide.back() == L'*';
            if (prefix) wide.pop_back();
            if (name.size() < wide.size() || (!prefix && name.size() != wide.size())) continue;
            if (_wcsnicmp(name.c_str(), wide.c_str(), wide.size()) == 0) return true;
        }
        return false;
    }

    static std::wstring BuildEnvironmentBlock(const std::map<std::string, std::string>& overrides, const std::vector<std::string>& unset)
    {
        std::map<std::wstring, std::wstring, CiLess> env;

        LPWCH existing = GetEnvironmentStringsW();
        if (existing)
        {
            const wchar_t* p = existing;
            while (*p)
            {
                std::wstring entry(p);
                p += entry.size() + 1;
                size_t eq = entry.find(L'=', 1); // skip leading '=' of hidden drive vars
                if (eq != std::wstring::npos && !Unset(entry.substr(0, eq), unset))
                {
                    env[entry.substr(0, eq)] = entry.substr(eq + 1);
                }
            }
            FreeEnvironmentStringsW(existing);
        }

        for (const auto& kv : overrides)
        {
            env[Widen(kv.first)] = Widen(kv.second);
        }

        std::wstring block;
        for (const auto& kv : env)
        {
            block += kv.first;
            block += L'=';
            block += kv.second;
            block.push_back(L'\0');
        }
        block.push_back(L'\0');
        return block;
    }

    struct Process::Impl
    {
        HANDLE hProcess = nullptr;
        HANDLE hJob = nullptr;
        std::thread outReader;
        std::thread errReader;
        std::mutex callbackMutex;
        bool started = false;
        bool timedOut = false;
        int timeoutSeconds = 0;
        int exitCode = -1;
        HANDLE stdinWrite = nullptr;   // write end of the child's stdin pipe (ProcessOptions::stdinPipe)
        std::mutex stdinMutex;
    };

    Process::Process() : m_impl(new Impl()) {}

    // Join a reader thread, but never park on it forever. A reader only exits when its
    // pipe reaches EOF, and EOF needs every write end closed - so a write handle leaked
    // into an unrelated long-lived child (see the inherit list in Start) would otherwise
    // hang the calling thread for the lifetime of that child. Cancel the blocking
    // ReadFile instead: it returns ERROR_OPERATION_ABORTED and the loop falls out.
    static void JoinReader(std::thread& t, DWORD graceMs)
    {
        if (!t.joinable()) return;
        HANDLE h = (HANDLE)t.native_handle();
        for (int attempt = 0; attempt < 3; ++attempt)
        {
            if (WaitForSingleObject(h, graceMs) != WAIT_TIMEOUT) break;
            CancelSynchronousIo(h);   // no-op if it is between reads; retried below
            graceMs = 1000;
        }
        t.join();
    }

    Process::~Process()
    {
        CloseStdin();
        if (m_impl->started && Running()) Kill();
        JoinReader(m_impl->outReader, 30000);
        JoinReader(m_impl->errReader, 30000);
        if (m_impl->hProcess) CloseHandle(m_impl->hProcess);
        if (m_impl->hJob) CloseHandle(m_impl->hJob);
    }

    static void ReaderLoop(HANDLE readEnd, bool isStderr, ProcessLineCallback onLine, std::mutex* mtx)
    {
        std::string acc;
        char buf[4096];
        for (;;)
        {
            DWORD n = 0;
            BOOL ok = ReadFile(readEnd, buf, (DWORD)sizeof(buf), &n, nullptr);
            if (!ok || n == 0) break;
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
        CloseHandle(readEnd);
    }

    bool Process::Start(const ProcessOptions& options, ProcessLineCallback onLine)
    {
        if (options.argv.empty()) return false;
        m_impl->timeoutSeconds = options.timeoutSeconds;

        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        sa.lpSecurityDescriptor = nullptr;

        HANDLE outRead = nullptr, outWrite = nullptr;
        HANDLE errRead = nullptr, errWrite = nullptr;
        if (!CreatePipe(&outRead, &outWrite, &sa, 0)) return false;
        if (!CreatePipe(&errRead, &errWrite, &sa, 0))
        {
            CloseHandle(outRead); CloseHandle(outWrite);
            return false;
        }
        // The parent's read ends must not be inherited by the child.
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);

        // Child stdin = NUL, so scripts that read input get EOF rather than hang, unless the
        // caller supplied a file to read from (a missing file fails the start) or asked for a pipe
        // to talk to the child (the parent keeps the write end, which the child must not inherit).
        HANDLE nulIn = nullptr, inWrite = nullptr;
        if (options.stdinPipe)
        {
            if (!CreatePipe(&nulIn, &inWrite, &sa, 0))
            {
                CloseHandle(outRead); CloseHandle(outWrite);
                CloseHandle(errRead); CloseHandle(errWrite);
                return false;
            }
            SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
        }
        else
        {
            nulIn = CreateFileW(options.stdinFile.empty() ? L"NUL" : Widen(options.stdinFile).c_str(), GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
            if (nulIn == INVALID_HANDLE_VALUE)
            {
                nulIn = nullptr;
                if (!options.stdinFile.empty())
                {
                    CloseHandle(outRead); CloseHandle(outWrite);
                    CloseHandle(errRead); CloseHandle(errWrite);
                    return false;
                }
            }
        }

        // Binary stdout: the child writes straight into the file (ProcessOptions::stdoutFile).
        HANDLE outFile = nullptr;
        if (!options.stdoutFile.empty())
        {
            outFile = CreateFileW(Widen(options.stdoutFile).c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (outFile == INVALID_HANDLE_VALUE)
            {
                CloseHandle(outRead); CloseHandle(outWrite);
                CloseHandle(errRead); CloseHandle(errWrite);
                if (nulIn) CloseHandle(nulIn);
                if (inWrite) CloseHandle(inWrite);
                return false;
            }
        }

        STARTUPINFOEXW siex{};
        siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        siex.StartupInfo.hStdInput = nulIn;
        siex.StartupInfo.hStdOutput = outFile ? outFile : outWrite;
        siex.StartupInfo.hStdError = errWrite;

        // Inherit ONLY this child's own std handles. bInheritHandles is all-or-nothing:
        // without an explicit list, a Process::Start running concurrently on another
        // thread leaks its pipe write ends into this child. That child then holds the
        // sibling's pipe open for its whole life, the sibling's reader never sees EOF,
        // and the thread waiting on it is parked for good. A long-lived service started
        // next to a git fetch is exactly that case, so keep the list authoritative.
        HANDLE inherit[3];
        DWORD inheritCount = 0;
        inherit[inheritCount++] = outFile ? outFile : outWrite;
        inherit[inheritCount++] = errWrite;
        if (nulIn) inherit[inheritCount++] = nulIn;

        SIZE_T attrSize = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);   // sizing call; fails by design
        std::vector<char> attrBuf(attrSize);
        bool haveAttr = attrSize != 0;
        if (haveAttr)
        {
            siex.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)attrBuf.data();
            haveAttr = InitializeProcThreadAttributeList(siex.lpAttributeList, 1, 0, &attrSize) &&
                       UpdateProcThreadAttribute(siex.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                                 inherit, inheritCount * sizeof(HANDLE), nullptr, nullptr);
            if (!haveAttr) siex.lpAttributeList = nullptr;
        }
        siex.StartupInfo.cb = haveAttr ? sizeof(siex) : sizeof(siex.StartupInfo);

        HANDLE job = CreateJobObjectW(nullptr, nullptr);
        if (job)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        }

        std::wstring wdir = Widen(options.workingDir);
        std::wstring envBlock = BuildEnvironmentBlock(options.envOverride, options.envUnset);
        std::wstring cmd = Widen(BuildCommandLine(options.argv));
        std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
        cmdBuf.push_back(L'\0');

        PROCESS_INFORMATION pi{};
        DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        if (haveAttr) flags |= EXTENDED_STARTUPINFO_PRESENT;

        BOOL created = CreateProcessW(
            nullptr,
            cmdBuf.data(),
            nullptr, nullptr,
            TRUE,
            flags,
            (LPVOID)envBlock.data(),
            options.workingDir.empty() ? nullptr : wdir.c_str(),
            &siex.StartupInfo, &pi);

        if (haveAttr) DeleteProcThreadAttributeList(siex.lpAttributeList);

        // Parent no longer needs the child's write ends, the stdout file or the NUL stdin handle.
        CloseHandle(outWrite);
        CloseHandle(errWrite);
        if (outFile) CloseHandle(outFile);
        if (nulIn) CloseHandle(nulIn);

        if (!created)
        {
            CloseHandle(outRead);
            CloseHandle(errRead);
            if (inWrite) CloseHandle(inWrite);
            if (job) CloseHandle(job);
            return false;
        }
        { std::lock_guard<std::mutex> lock(m_impl->stdinMutex); m_impl->stdinWrite = inWrite; }

        if (job) AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);

        m_impl->hProcess = pi.hProcess;
        m_impl->hJob = job;
        m_impl->started = true;
        m_impl->timedOut = false;

        if (outFile) CloseHandle(outRead);   // stdout went to the file: nothing to read here
        else m_impl->outReader = std::thread(ReaderLoop, outRead, false, onLine, &m_impl->callbackMutex);
        m_impl->errReader = std::thread(ReaderLoop, errRead, true, onLine, &m_impl->callbackMutex);
        return true;
    }

    int Process::Wait()
    {
        if (!m_impl->started) return -1;

        DWORD waitMs = m_impl->timeoutSeconds > 0 ? (DWORD)m_impl->timeoutSeconds * 1000u : INFINITE;
        DWORD r = WaitForSingleObject(m_impl->hProcess, waitMs);
        if (r == WAIT_TIMEOUT)
        {
            m_impl->timedOut = true;
            Kill();
            WaitForSingleObject(m_impl->hProcess, INFINITE);
        }

        CloseStdin();
        // The child is gone by here, so its output drains almost immediately; a grace
        // period this long only ever expires when a handle leaked (see JoinReader).
        JoinReader(m_impl->outReader, 30000);
        JoinReader(m_impl->errReader, 30000);

        DWORD code = 0;
        GetExitCodeProcess(m_impl->hProcess, &code);
        m_impl->exitCode = m_impl->timedOut ? -1 : (int)code;
        return m_impl->exitCode;
    }

    int Process::Run(const ProcessOptions& options, ProcessLineCallback onLine)
    {
        if (!Start(options, onLine)) return -1;
        return Wait();
    }

    void Process::Kill()
    {
        if (m_impl->hJob) TerminateJobObject(m_impl->hJob, 1);
        else if (m_impl->hProcess) TerminateProcess(m_impl->hProcess, 1);
    }

    bool Process::Running() const
    {
        if (!m_impl->started || !m_impl->hProcess) return false;
        return WaitForSingleObject(m_impl->hProcess, 0) == WAIT_TIMEOUT;
    }

    bool Process::TimedOut() const { return m_impl->timedOut; }

    bool Process::WriteStdin(const std::string& data)
    {
        std::lock_guard<std::mutex> lock(m_impl->stdinMutex);
        size_t offset = 0;
        while (m_impl->stdinWrite && offset < data.size())
        {
            DWORD written = 0;
            const DWORD chunk = (DWORD)std::min<size_t>(data.size() - offset, 1u << 20);
            if (!WriteFile(m_impl->stdinWrite, data.data() + offset, chunk, &written, nullptr) || written == 0) return false;
            offset += written;
        }
        return m_impl->stdinWrite != nullptr;
    }

    void Process::CloseStdin()
    {
        std::lock_guard<std::mutex> lock(m_impl->stdinMutex);
        if (m_impl->stdinWrite) { CloseHandle(m_impl->stdinWrite); m_impl->stdinWrite = nullptr; }
    }
}
