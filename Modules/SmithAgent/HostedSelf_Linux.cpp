// HostedSelf_Linux.cpp - where the running Smith executable lives, on Linux.
#include "HostedPlatform.h"
#include <filesystem>
#include <stdexcept>
namespace Smith {
std::string HostedExecutablePath() {
    std::error_code error;
    const auto path = std::filesystem::read_symlink("/proc/self/exe", error);
    if (error || path.empty()) throw std::runtime_error("Cannot resolve running executable");
    return path.string();
}
}
