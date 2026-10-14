// HostedSelf_Mac.cpp - where the running Smith executable lives, on macOS.
#include "HostedPlatform.h"
#include <mach-o/dyld.h>
#include <climits>
#include <cstdlib>
#include <stdexcept>
#include <vector>
namespace Smith {
std::string HostedExecutablePath() {
    uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> path(size + 1, '\0');
    if (_NSGetExecutablePath(path.data(), &size) != 0) throw std::runtime_error("Cannot resolve running executable");
    char resolved[PATH_MAX];
    if (!realpath(path.data(), resolved)) throw std::runtime_error("Cannot resolve running executable");
    return resolved;
}
}
