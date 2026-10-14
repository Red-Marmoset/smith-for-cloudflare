#include "HostedPlatform.h"
#include "HostedAgent.h"
#include "HostedToolSetup.h"
#include <SmithCore/Uuid.h>
#include <windows.h>
#include <bcrypt.h>
#include <sddl.h>
#include <aclapi.h>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <vector>
#include <iostream>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")
namespace Smith {
namespace {
struct ToolLock final : HostedWorkspaceLock {
    HANDLE file;
    explicit ToolLock(HANDLE handle) : file(handle) {}
    ~ToolLock() { CloseHandle(file); }
};
}
std::unique_ptr<HostedWorkspaceLock> HostedTryToolLock(const std::string& path, bool exclusive) {
    HANDLE file = CreateFileW(std::filesystem::path(path).wstring().c_str(), GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open agent tool lock");
    OVERLAPPED overlap{};
    if (!LockFileEx(file, LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0), 0, 1, 0, &overlap)) {
        DWORD error = GetLastError(); CloseHandle(file);
        if (error == ERROR_LOCK_VIOLATION) return nullptr;
        throw std::runtime_error("Cannot lock agent tools");
    }
    return std::make_unique<ToolLock>(file);
}
namespace {
    struct Security {
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        SECURITY_ATTRIBUTES attributes{};
        Security() {
            HANDLE token = nullptr; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) throw std::runtime_error("Cannot inspect current user");
            DWORD length = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &length);
            std::vector<char> data(length);
            if (!GetTokenInformation(token, TokenUser, data.data(), length, &length)) { CloseHandle(token); throw std::runtime_error("Cannot inspect current user"); }
            CloseHandle(token); LPWSTR sid = nullptr;
            if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid)) throw std::runtime_error("Cannot encode user SID");
            std::wstring sddl = L"D:P(A;OICI;FA;;;" + std::wstring(sid) + L")"; LocalFree(sid);
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) throw std::runtime_error("Cannot create private ACL");
            attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
        }
        ~Security() { if (descriptor) LocalFree(descriptor); }
    };
    std::wstring Wide(const std::string& path) { return std::filesystem::path(path).wstring(); }
}
bool HostedFileIsPrivate(const std::string& path) {
    DWORD attrs=GetFileAttributesW(Wide(path).c_str());
    if(attrs==INVALID_FILE_ATTRIBUTES || (attrs&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)))return false;
    Security security; PACL expected=nullptr; BOOL present=FALSE,defaulted=FALSE;
    if(!GetSecurityDescriptorDacl(security.descriptor,&present,&expected,&defaulted)||!expected)return false;
    void* expectedAce=nullptr;if(!GetAce(expected,0,&expectedAce))return false;
    PSID currentSid=&reinterpret_cast<ACCESS_ALLOWED_ACE*>(expectedAce)->SidStart;
    PSECURITY_DESCRIPTOR descriptor=nullptr; PACL acl=nullptr;
    if(GetNamedSecurityInfoW(const_cast<wchar_t*>(Wide(path).c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&acl,nullptr,&descriptor)!=ERROR_SUCCESS)return false;
    bool safe=acl!=nullptr;
    if(acl)for(DWORD i=0;i<acl->AceCount;++i) {
        void* entry=nullptr;if(!GetAce(acl,i,&entry)){safe=false;break;}
        auto header=reinterpret_cast<ACE_HEADER*>(entry);
        if(header->AceType==ACCESS_ALLOWED_ACE_TYPE) {
            auto allowed=reinterpret_cast<ACCESS_ALLOWED_ACE*>(entry);
            if(!EqualSid(&allowed->SidStart,currentSid)){safe=false;break;}
        }else if(header->AceType!=ACCESS_DENIED_ACE_TYPE){safe=false;break;}
    }
    LocalFree(descriptor);return safe;
}
std::string HostedSha256(const std::string& bytes) {
    struct Algorithm { BCRYPT_ALG_HANDLE value=nullptr; ~Algorithm(){if(value)BCryptCloseAlgorithmProvider(value,0);} } algorithm;
    struct Hash { BCRYPT_HASH_HANDLE value=nullptr; ~Hash(){if(value)BCryptDestroyHash(value);} } hash;
    if(BCryptOpenAlgorithmProvider(&algorithm.value,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0 ||
       BCryptCreateHash(algorithm.value,&hash.value,nullptr,0,nullptr,0,0)<0 ||
       BCryptHashData(hash.value,reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),(ULONG)bytes.size(),0)<0)
        throw std::runtime_error("Cannot hash artifact");
    unsigned char digest[32];
    if(BCryptFinishHash(hash.value,digest,sizeof(digest),0)<0)throw std::runtime_error("Cannot finish artifact hash");
    std::string hex; const char* digits="0123456789abcdef";
    for(unsigned char byte:digest){hex+=digits[byte>>4];hex+=digits[byte&15];}
    return hex;
}
std::string HostedSha256File(const std::string& path) {
    struct Algorithm { BCRYPT_ALG_HANDLE value=nullptr; ~Algorithm(){if(value)BCryptCloseAlgorithmProvider(value,0);} } algorithm;
    struct Hash { BCRYPT_HASH_HANDLE value=nullptr; ~Hash(){if(value)BCryptDestroyHash(value);} } hash;
    if(BCryptOpenAlgorithmProvider(&algorithm.value,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0 || BCryptCreateHash(algorithm.value,&hash.value,nullptr,0,nullptr,0,0)<0) throw std::runtime_error("Cannot hash file");
    std::ifstream in(std::filesystem::path(path),std::ios::binary); if(!in) throw std::runtime_error("Cannot read file to hash");
    std::vector<char> buffer(1<<20);
    while(in) { in.read(buffer.data(),(std::streamsize)buffer.size()); const auto n=in.gcount(); if(n>0 && BCryptHashData(hash.value,reinterpret_cast<PUCHAR>(buffer.data()),(ULONG)n,0)<0) throw std::runtime_error("Cannot hash file"); }
    unsigned char digest[32];
    if(BCryptFinishHash(hash.value,digest,sizeof(digest),0)<0)throw std::runtime_error("Cannot finish file hash");
    std::string hex; const char* digits="0123456789abcdef";
    for(unsigned char byte:digest){hex+=digits[byte>>4];hex+=digits[byte&15];}
    return hex;
}
std::string HostedExecutablePath() {
    std::vector<wchar_t> path(32768);
    DWORD size=GetModuleFileNameW(nullptr,path.data(),(DWORD)path.size());
    if(!size || size>=path.size())throw std::runtime_error("Cannot resolve running executable");
    return std::filesystem::path(std::wstring(path.data(),size)).string();
}
namespace {
    // Check every component, including junctions (which are not fs::is_symlink).
    bool RegularAncestors(const std::filesystem::path& path) {
        auto current=path.root_path();
        for(const auto& part:path.relative_path()) {
            current/=part;
            DWORD attributes=GetFileAttributesW(current.wstring().c_str());
            if(attributes==INVALID_FILE_ATTRIBUTES) {
                DWORD error=GetLastError();
                if(error==ERROR_FILE_NOT_FOUND || error==ERROR_PATH_NOT_FOUND)return false;
                throw std::runtime_error("Cannot inspect artifact or drain path");
            }
            if(attributes&FILE_ATTRIBUTE_REPARSE_POINT)throw std::runtime_error("Artifact and drain paths must not contain links or junctions");
        }
        return true;
    }
    struct ReadHandle { HANDLE value=INVALID_HANDLE_VALUE; ~ReadHandle(){if(value!=INVALID_HANDLE_VALUE)CloseHandle(value);} };
    void OpenRegular(const std::filesystem::path& path,ReadHandle& file) {
        if(!RegularAncestors(path))throw std::runtime_error("Artifact file does not exist");
        file.value=CreateFileW(path.wstring().c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
        if(file.value==INVALID_HANDLE_VALUE)throw std::runtime_error("Cannot snapshot artifact; it may still be open for writing");
        BY_HANDLE_FILE_INFORMATION info{};
        if(!GetFileInformationByHandle(file.value,&info) || (info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)) || info.nNumberOfLinks!=1)
            throw std::runtime_error("Artifact or drain marker must be a regular file without links");
        std::vector<wchar_t> finalPath(32768);
        DWORD length=GetFinalPathNameByHandleW(file.value,finalPath.data(),(DWORD)finalPath.size(),FILE_NAME_NORMALIZED);
        if(!length || length>=finalPath.size())throw std::runtime_error("Cannot verify artifact location");
        std::wstring actual(finalPath.data(),length);
        if(actual.rfind(L"\\\\?\\",0)==0)actual.erase(0,4);
        if(_wcsicmp(actual.c_str(),path.lexically_normal().wstring().c_str())!=0)throw std::runtime_error("Artifact path changed while opening it");
    }
}
std::string HostedReadArtifact(const std::string& root,const std::string& relative,size_t maximum) {
    if(relative.empty() || relative=="." || !HostedRelativePathValid(relative))throw std::runtime_error("Artifact path must be an exact relative file");
    auto path=(std::filesystem::absolute(root)/relative).lexically_normal();
    ReadHandle file;OpenRegular(path,file);
    LARGE_INTEGER size{};
    if(!GetFileSizeEx(file.value,&size) || size.QuadPart<0 || (unsigned long long)size.QuadPart>maximum)throw std::runtime_error("Artifact exceeds the supported size limit");
    std::string bytes((size_t)size.QuadPart,'\0');DWORD read=0;
    if(!bytes.empty() && (!ReadFile(file.value,bytes.data(),(DWORD)bytes.size(),&read,nullptr) || read!=bytes.size()))throw std::runtime_error("Cannot read complete artifact snapshot");
    return bytes;
}
bool HostedDrainRequested(const std::string& value) {
    if(value.empty())return false;
    std::filesystem::path path(value);
    if(!path.is_absolute())throw std::runtime_error("--drain-file must be an absolute path");
    path=path.lexically_normal();
    if(!RegularAncestors(path))return false;
    ReadHandle marker;OpenRegular(path,marker);
    if(!HostedFileIsPrivate(path.string()))throw std::runtime_error("Drain marker must be readable only by its owner");
    return true;
}
bool HostedCrashContainmentAvailable() { return true; }
bool HostedIsLink(const std::string& path) {
    const auto attrs = GetFileAttributesW(std::filesystem::path(path).c_str());
    return attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT);
}
std::vector<std::string> HostedToolArgv(const std::string& tool, const std::vector<std::string>& args) {
    // Found wherever its installer put it (HostedFindTool): an .exe runs directly, an npm .cmd shim
    // through cmd.exe. cmd.exe mangles a quoted path, so a shim under a path with spaces, or a tool
    // not found at all, is named bare and left to the PATH as before.
    const auto path = HostedFindTool(tool);
    auto lower = path; for (auto& c : lower) c = (char)tolower((unsigned char)c);
    std::vector<std::string> argv;
    if (lower.size() > 4 && lower.compare(lower.size() - 4, 4, ".exe") == 0) argv = {path};
    else argv = {"cmd.exe", "/d", "/c", !path.empty() && path.find(' ') == std::string::npos ? path : tool};
    argv.insert(argv.end(), args.begin(), args.end()); return argv;
}
void HostedSecureDirectory(const std::string& path) {
    Security security; auto wide = Wide(path);
    if (!CreateDirectoryW(wide.c_str(), &security.attributes) && GetLastError() != ERROR_ALREADY_EXISTS) throw std::runtime_error("Cannot create private directory");
    DWORD attrs = GetFileAttributesW(wide.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY) || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Private directory is invalid or a link");
    if (!SetFileSecurityW(wide.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, security.descriptor)) throw std::runtime_error("Cannot secure private directory");
}
void HostedSecureWrite(const std::string& path, const std::string& bytes) {
    Security security; const auto temp = Wide(path + "." + MakeUuid() + ".tmp");
    HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create private file");
    DWORD written = 0; bool ok = WriteFile(file, bytes.data(), (DWORD)bytes.size(), &written, nullptr) && written == bytes.size() && FlushFileBuffers(file);
    CloseHandle(file);
    if (!ok || !MoveFileExW(temp.c_str(), Wide(path).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) { DeleteFileW(temp.c_str()); throw std::runtime_error("Cannot persist private file"); }
}
std::string HostedReadSecret() {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE); DWORD mode = 0;
    if (!GetConsoleMode(input, &mode)) throw std::runtime_error("Enrollment needs an interactive console or --enrollment-file");
    // Echo one '*' per character so a paste is visibly received; Backspace edits, Enter finishes.
    if (!SetConsoleMode(input, (mode & ~(ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT)) | ENABLE_PROCESSED_INPUT)) throw std::runtime_error("Cannot read the enrollment code");
    std::wstring secret;
    for (;;) {
        wchar_t ch = 0; DWORD read = 0;
        if (!ReadConsoleW(input, &ch, 1, &read, nullptr) || read == 0) break;
        if (ch == L'\r' || ch == L'\n') break;
        if (ch == L'\b') { if (!secret.empty()) { secret.pop_back(); std::cout << "\b \b" << std::flush; } continue; }
        if (ch < 32 || secret.size() >= 1024) continue;
        secret.push_back(ch); std::cout << '*' << std::flush;
    }
    SetConsoleMode(input, mode); std::cout << '\n';
    std::string out(WideCharToMultiByte(CP_UTF8, 0, secret.c_str(), (int)secret.size(), nullptr, 0, nullptr, nullptr), '\0');
    if (!out.empty()) WideCharToMultiByte(CP_UTF8, 0, secret.c_str(), (int)secret.size(), out.data(), (int)out.size(), nullptr, nullptr);
    return out;
}
struct Lock final : HostedWorkspaceLock { HANDLE handle; explicit Lock(HANDLE h):handle(h){} ~Lock() { CloseHandle(handle); } };
std::unique_ptr<HostedWorkspaceLock> HostedLockWorkspace(const std::string& path) {
    Security security; HANDLE file = CreateFileW(Wide(path).c_str(), GENERIC_READ | GENERIC_WRITE, 0, &security.attributes, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Another hosted agent is using this workspace");
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(file, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) { CloseHandle(file); throw std::runtime_error("Invalid workspace lock"); }
    return std::make_unique<Lock>(file);
}
}
