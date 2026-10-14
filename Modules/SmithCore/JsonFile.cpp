// JsonFile.cpp - see JsonFile.h.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "JsonFile.h"

#include <filesystem>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;

namespace Smith
{
    bool WriteFileAtomic(const std::string& pathStr, const std::string& content)
    {
        fs::path path(pathStr);
        std::error_code ec;
        fs::create_directories(path.parent_path(), ec);
        fs::path tmp = path;
        tmp += ".tmp";
        {
            std::ofstream o(tmp, std::ios::binary | std::ios::trunc);
            if (!o) return false;
            o.write(content.data(), (std::streamsize)content.size());
            if (!o) return false;
        }
        fs::rename(tmp, path, ec);
        if (ec)
        {
            // Windows: rename-over-existing can fail; remove the target and retry.
            fs::remove(path, ec);
            fs::rename(tmp, path, ec);
            if (ec) return false;
        }
        return true;
    }

    bool LoadJsonFile(const std::string& path, nlohmann::json& out)
    {
        std::ifstream in(path, std::ios::binary);
        if (!in) return false;
        std::stringstream ss;
        ss << in.rdbuf();
        nlohmann::json j = nlohmann::json::parse(ss.str(), nullptr, false);
        if (j.is_discarded()) return false;
        out = std::move(j);
        return true;
    }

    bool SaveJsonFileAtomic(const std::string& path, const nlohmann::json& j, int indent)
    {
        return WriteFileAtomic(path, j.dump(indent));
    }
}
