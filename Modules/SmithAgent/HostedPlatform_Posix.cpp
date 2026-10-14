// HostedPlatform_Posix.cpp - Linux/macOS side of the hosted agent's platform layer.
// Mirrors HostedPlatform_Windows.cpp: owner-only files, no links anywhere in an
// artifact or drain path, atomic replacement, and a release identity hash that
// needs no OpenSSL (a self-contained SHA-256 below).
#include "HostedPlatform.h"
#include "HostedAgent.h"
#include "HostedToolSetup.h"
#include <SmithCore/Uuid.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <termios.h>
#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <iostream>
#include <vector>
namespace Smith {
namespace {
// FIPS 180-4 SHA-256, byte-oriented; enough for release identity + artifact digests.
struct Sha256 {
    uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    unsigned char block[64]{}; size_t used = 0; uint64_t total = 0;
    static uint32_t Rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
    void Compress(const unsigned char* p) {
        static const uint32_t k[64] = {
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) w[i] = (uint32_t)p[i*4] << 24 | (uint32_t)p[i*4+1] << 16 | (uint32_t)p[i*4+2] << 8 | p[i*4+3];
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = Rotr(w[i-15],7) ^ Rotr(w[i-15],18) ^ (w[i-15] >> 3), s1 = Rotr(w[i-2],17) ^ Rotr(w[i-2],19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t t1 = hh + (Rotr(e,6) ^ Rotr(e,11) ^ Rotr(e,25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
            uint32_t t2 = (Rotr(a,2) ^ Rotr(a,13) ^ Rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c));
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
    }
    void Update(const unsigned char* data, size_t size) {
        total += size;
        while (size > 0) {
            size_t n = std::min(size, (size_t)64 - used); std::memcpy(block + used, data, n); used += n; data += n; size -= n;
            if (used == 64) { Compress(block); used = 0; }
        }
    }
    std::string Hex() {
        const uint64_t bits = total * 8; const unsigned char pad = 0x80, zero = 0; Update(&pad, 1);
        while (used != 56) Update(&zero, 1);
        unsigned char length[8]; for (int i = 0; i < 8; ++i) length[i] = (unsigned char)(bits >> (56 - 8*i)); Update(length, 8);
        std::string hex; const char* digits = "0123456789abcdef";
        for (uint32_t v : h) for (int i = 3; i >= 0; --i) { unsigned char byte = (unsigned char)(v >> (8*i)); hex += digits[byte >> 4]; hex += digits[byte & 15]; }
        return hex;
    }
};
// No user-created link anywhere in the path (the POSIX twin of the Windows
// reparse-point walk). A symlink owned by root is part of the OS layout - macOS
// keeps /var, /tmp and /etc as links into /private, and the temp dir lives there -
// so those are followed; a link anyone else could have planted is refused.
// false = a component is missing.
bool RegularAncestors(const std::filesystem::path& path) {
    auto current = path.root_path();
    for (const auto& part : path.relative_path()) {
        current /= part; struct stat info{};
        if (lstat(current.c_str(), &info) != 0) {
            if (errno == ENOENT || errno == ENOTDIR) return false;
            throw std::runtime_error("Cannot inspect artifact or drain path");
        }
        if (S_ISLNK(info.st_mode) && info.st_uid != 0) throw std::runtime_error("Artifact and drain paths must not contain links");
    }
    return true;
}
struct ReadFd { int value = -1; ~ReadFd() { if (value >= 0) close(value); } };
void OpenRegular(const std::filesystem::path& path, ReadFd& file, struct stat& info) {
    if (!RegularAncestors(path)) throw std::runtime_error("Artifact file does not exist");
    file.value = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (file.value < 0) throw std::runtime_error("Cannot snapshot artifact; it may still be open for writing");
    if (fstat(file.value, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1)
        throw std::runtime_error("Artifact or drain marker must be a regular file without links");
}
}
bool HostedFileIsPrivate(const std::string& path) {
    struct stat info{};
    return lstat(path.c_str(),&info)==0 && S_ISREG(info.st_mode) && info.st_uid==geteuid() && !(info.st_mode&0077);
}
std::string HostedSha256(const std::string& bytes) {
    Sha256 digest; digest.Update(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size()); return digest.Hex();
}
std::string HostedSha256File(const std::string& path) {
    std::ifstream in(path, std::ios::binary); if (!in) throw std::runtime_error("Cannot read file to hash");
    Sha256 digest; std::vector<char> buffer(1 << 20);
    while (in) { in.read(buffer.data(), (std::streamsize)buffer.size()); const auto n = in.gcount(); if (n > 0) digest.Update(reinterpret_cast<const unsigned char*>(buffer.data()), (size_t)n); }
    return digest.Hex();
}
std::string HostedReadArtifact(const std::string& root, const std::string& relative, size_t maximum) {
    if (relative.empty() || relative == "." || !HostedRelativePathValid(relative)) throw std::runtime_error("Artifact path must be an exact relative file");
    auto path = (std::filesystem::absolute(root) / relative).lexically_normal();
    ReadFd file; struct stat info{}; OpenRegular(path, file, info);
    if (info.st_size < 0 || (unsigned long long)info.st_size > maximum) throw std::runtime_error("Artifact exceeds the supported size limit");
    std::string bytes((size_t)info.st_size, '\0'); size_t offset = 0;
    while (offset < bytes.size()) {
        ssize_t n = read(file.value, bytes.data() + offset, bytes.size() - offset);
        if (n <= 0) throw std::runtime_error("Cannot read complete artifact snapshot");
        offset += (size_t)n;
    }
    return bytes;
}
bool HostedDrainRequested(const std::string& value) {
    if (value.empty()) return false;
    std::filesystem::path path(value);
    if (!path.is_absolute()) throw std::runtime_error("--drain-file must be an absolute path");
    path = path.lexically_normal();
    if (!RegularAncestors(path)) return false;
    ReadFd marker; struct stat info{}; OpenRegular(path, marker, info);
    if (!HostedFileIsPrivate(path.string())) throw std::runtime_error("Drain marker must be readable only by its owner");
    return true;
}
// Builds run in their own process group with a sentinel that kills the group if
// this agent dies (ProcessOptions::stopWithParent, Process_Posix.cpp) - the POSIX
// counterpart of the Windows kill-on-close job object.
bool HostedCrashContainmentAvailable() { return true; }
bool HostedIsLink(const std::string& path) {
    struct stat info {};
    return lstat(path.c_str(), &info) != 0 || S_ISLNK(info.st_mode);
}
std::vector<std::string> HostedToolArgv(const std::string& tool, const std::vector<std::string>& args) {
    // Found wherever its installer put it (HostedFindTool), else left to the PATH as before.
    const auto path = HostedFindTool(tool);
    std::vector<std::string> argv = {path.empty() ? tool : path}; argv.insert(argv.end(), args.begin(), args.end()); return argv;
}
void HostedSecureDirectory(const std::string& path) {
    if (mkdir(path.c_str(), 0700) != 0 && errno != EEXIST) throw std::runtime_error("Cannot create private directory");
    struct stat info{};
    if (lstat(path.c_str(), &info) || !S_ISDIR(info.st_mode) || info.st_uid != geteuid() || chmod(path.c_str(),0700)) throw std::runtime_error("Private directory has unsafe ownership or type");
}
void HostedSecureWrite(const std::string& path, const std::string& bytes) {
    const auto temp = path + "." + MakeUuid() + ".tmp";
    int fd = open(temp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) throw std::runtime_error("Cannot create private file");
    size_t offset = 0;
    while (offset < bytes.size()) { auto n = write(fd, bytes.data()+offset, bytes.size()-offset); if (n <= 0) break; offset += (size_t)n; }
    bool ok = offset == bytes.size() && fsync(fd) == 0; close(fd);
    if (!ok || rename(temp.c_str(),path.c_str())) { unlink(temp.c_str()); throw std::runtime_error("Cannot persist private file"); }
    int dir = open(std::filesystem::path(path).parent_path().c_str(), O_RDONLY | O_CLOEXEC); if (dir >= 0) { fsync(dir); close(dir); }
}
std::string HostedReadSecret() {
    termios old{}; if (tcgetattr(STDIN_FILENO,&old)) throw std::runtime_error("Enrollment needs an interactive console or --enrollment-file");
    // Echo one '*' per character so a paste is visibly received; Backspace edits, Enter finishes.
    auto mode = old; mode.c_lflag &= ~(ECHO | ICANON); mode.c_cc[VMIN] = 1; mode.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO,TCSANOW,&mode)) throw std::runtime_error("Cannot read the enrollment code");
    std::string secret;
    for (;;) {
        unsigned char ch = 0;
        if (read(STDIN_FILENO, &ch, 1) != 1) break;
        if (ch == '\r' || ch == '\n') break;
        if (ch == 127 || ch == '\b') {
            if (!secret.empty()) {
                // Drop a whole UTF-8 sequence, not just its last byte.
                while (!secret.empty() && (static_cast<unsigned char>(secret.back()) & 0xC0) == 0x80) secret.pop_back();
                if (!secret.empty()) secret.pop_back();
                std::cout << "\b \b" << std::flush;
            }
            continue;
        }
        if (ch < 32 || secret.size() >= 1024) continue;
        secret.push_back(static_cast<char>(ch));
        if ((ch & 0xC0) != 0x80) std::cout << '*' << std::flush;
    }
    tcsetattr(STDIN_FILENO,TCSANOW,&old); std::cout << '\n'; return secret;
}
struct Lock final : HostedWorkspaceLock { int fd; explicit Lock(int f):fd(f){} ~Lock(){close(fd);} };
std::unique_ptr<HostedWorkspaceLock> HostedTryToolLock(const std::string& path, bool exclusive) {
    int fd = open(path.c_str(), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) throw std::runtime_error("Cannot open agent tool lock");
    if (flock(fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)) {
        int error = errno; close(fd);
        if (error == EWOULDBLOCK || error == EAGAIN) return nullptr;
        throw std::runtime_error("Cannot lock agent tools");
    }
    return std::make_unique<Lock>(fd);
}
std::unique_ptr<HostedWorkspaceLock> HostedLockWorkspace(const std::string& path) {
    int fd = open(path.c_str(), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB)) { if(fd>=0)close(fd); throw std::runtime_error("Another hosted agent is using this workspace"); }
    return std::make_unique<Lock>(fd);
}
}
