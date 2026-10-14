// Variants.cpp - generic build-variant discovery. Globs a repo for matching files
// and turns each into a selectable variant (named by its filename stem), classified
// to the node it needs. No project-type knowledge (Unity, build profiles, ...) lives
// here - a project's smith.json supplies the glob and classify patterns.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Domain.h"
#include "Strings.h"

#include <filesystem>
#include <regex>
#include <algorithm>
#include <set>
#include <cctype>
#include <cstring>

namespace fs = std::filesystem;

namespace Smith
{
    // Lowercase, runs of non-alphanumerics collapse to a single '-', trimmed.
    // "Steam (Windows)" -> "steam-windows".
    std::string SlugifyName(const std::string& raw)
    {
        std::string out;
        bool prevDash = false;
        for (char c : raw)
        {
            unsigned char uc = (unsigned char)c;
            if (std::isalnum(uc)) { out += (char)std::tolower(uc); prevDash = false; }
            else if (!prevDash && !out.empty()) { out += '-'; prevDash = true; }
        }
        while (!out.empty() && out.back() == '-') out.pop_back();
        return out.empty() ? "build" : out;
    }

    // (File-path globbing lives in Strings.h GlobToRegex; '*' stays inside a path
    // segment there, unlike branch globs.)
    ProductVariant ClassifyVariant(const std::string& name, const DiscoverSpec& spec)
    {
        ProductVariant v;
        v.name = name;
        v.slug = SlugifyName(name);   // friendly alias: "Steam (Windows)" -> "steam-windows"
        for (const auto& rule : spec.classify)
        {
            bool matches = rule.match.empty();   // empty pattern = catch-all
            if (!matches)
            {
                try { matches = std::regex_search(name, std::regex(rule.match, std::regex::ECMAScript)); }
                catch (const std::regex_error&) { matches = false; }
            }
            if (!matches) continue;
            v.os = rule.os.empty() ? "any" : rule.os;
            v.labels = rule.labels;
            v.preferOs = rule.preferOs;
            return v;
        }
        return v;   // no rule matched: os stays "any"
    }

    std::vector<ProductVariant> DiscoverVariants(const std::string& baseDir, const DiscoverSpec& spec)
    {
        std::vector<ProductVariant> out;

        // "list": variants are declared directly (a build matrix), no repo scan.
        if (spec.type == "list")
        {
            std::set<std::string> seen;
            for (const auto& v : spec.values)
            {
                if (v.empty() || seen.count(v)) continue;
                seen.insert(v);
                out.push_back(ClassifyVariant(v, spec));
            }
            std::sort(out.begin(), out.end(),
                      [](const ProductVariant& a, const ProductVariant& b) { return a.name < b.name; });
            return out;
        }

        if (spec.type != "files" || spec.glob.empty() || baseDir.empty()) return out;

        std::error_code ec;
        fs::path base(baseDir);
        if (!fs::is_directory(base, ec)) return out;

        std::regex re;
        try { re = GlobToRegex(spec.glob); }
        catch (const std::regex_error&) { return out; }

        // Bound the walk to the glob's wildcard-free leading directory, so a huge
        // repo (e.g. a Unity project's multi-GB Library/) is never scanned whole.
        std::string g = spec.glob;
        for (char& c : g) if (c == '\\') c = '/';
        size_t firstWild = g.find_first_of("*?");
        std::string fixedDir;
        {
            std::string head = (firstWild == std::string::npos) ? g : g.substr(0, firstWild);
            size_t lastSlash = head.find_last_of('/');
            if (lastSlash != std::string::npos) fixedDir = g.substr(0, lastSlash);
        }
        fs::path start = fixedDir.empty() ? base : (base / fixedDir);
        if (!fs::is_directory(start, ec)) return out;

        std::set<std::string> seen;
        for (auto it = fs::recursive_directory_iterator(start, ec);
             it != fs::recursive_directory_iterator(); it.increment(ec))
        {
            if (ec) break;
            if (!it->is_regular_file(ec)) continue;
            fs::path rel = fs::relative(it->path(), base, ec);
            if (ec) continue;
            if (!std::regex_match(rel.generic_string(), re)) continue;

            std::string name = it->path().stem().string();   // filename without extension
            if (name.empty() || seen.count(name)) continue;
            seen.insert(name);
            out.push_back(ClassifyVariant(name, spec));
        }

        std::sort(out.begin(), out.end(),
                  [](const ProductVariant& a, const ProductVariant& b) { return a.name < b.name; });
        return out;
    }
}
