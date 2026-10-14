// Handoff.cpp - pure builders for the built-in handoff steps.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "Handoff.h"

#include <json/single_include/nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <vector>

namespace fs = std::filesystem;
using nlohmann::json;

namespace Smith
{
    std::string SubstituteVars(const std::string& in, const std::map<std::string, std::string>& vars)
    {
        std::string out;
        out.reserve(in.size());
        for (size_t i = 0; i < in.size(); )
        {
            if (in[i] == '$' && i + 1 < in.size() && in[i + 1] == '{')
            {
                size_t end = in.find('}', i + 2);
                if (end != std::string::npos)
                {
                    std::string key = in.substr(i + 2, end - (i + 2));
                    auto it = vars.find(key);
                    if (it != vars.end()) { out += it->second; i = end + 1; continue; }
                }
            }
            out += in[i++];
        }
        return out;
    }

    static std::string Field(const std::map<std::string, std::string>& f, const std::string& k,
                             const std::string& def = "")
    {
        auto it = f.find(k);
        return (it == f.end() || it->second.empty()) ? def : it->second;
    }

    // Resolve a (possibly relative) path under the working directory. An absolute
    // path is returned unchanged.
    static std::string AbsUnder(const std::string& workingDir, const std::string& p)
    {
        if (p.empty()) return workingDir;
        fs::path pp(p);
        if (pp.is_absolute()) return pp.string();
        return (fs::path(workingDir) / pp).string();
    }

    std::map<std::string, std::string> ResolveCredentials(const std::string& credentialsFile,
                                                          const std::string& ref)
    {
        std::map<std::string, std::string> out;
        if (credentialsFile.empty() || ref.empty()) return out;
        std::ifstream in(credentialsFile, std::ios::binary);
        if (!in) return out;
        std::stringstream ss; ss << in.rdbuf();
        json j = json::parse(ss.str(), nullptr, false);
        if (j.is_discarded() || !j.is_object() || !j.contains(ref) || !j[ref].is_object()) return out;
        for (auto it = j[ref].begin(); it != j[ref].end(); ++it)
            if (it.value().is_string()) out[it.key()] = it.value().get<std::string>();
        return out;
    }

    HandoffCommand BuildScriptCommand(const std::map<std::string, std::string>& f, const std::string& workingDir)
    {
        HandoffCommand c;
        c.workingDir = AbsUnder(workingDir, Field(f, "workingDir"));
        std::string interp = Field(f, "interpreter", "exe");
        std::string script = Field(f, "script");
        if (script.empty()) { c.error = "script handoff requires a 'script' field"; return c; }
        std::string scriptAbs = AbsUnder(workingDir, script);
        if (interp == "ps1") c.argv = { "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptAbs };
        else if (interp == "bat") c.argv = { "cmd", "/c", scriptAbs };
        else if (interp == "sh") c.argv = { "/bin/sh", scriptAbs };
        else if (interp == "python") c.argv = { "python", scriptAbs };
        else if (interp == "exe") c.argv = { scriptAbs };
        else { c.error = "unsupported script interpreter '" + interp + "'"; return c; }

        std::string args = Field(f, "args");
        if (!args.empty())
        {
            std::stringstream ss(args);
            std::string tok;
            while (std::getline(ss, tok, ' ')) if (!tok.empty()) c.argv.push_back(tok);
        }
        return c;
    }

    // Parse the optional 'appBuildVdfs' field into an ordered list of VDF paths. The
    // agent delivers it as a dumped JSON value (RepoConfig stores non-string keys via
    // json::dump). Accept a JSON array (each non-empty string element, in order), a JSON
    // string (one path), or anything that isn't valid JSON (a raw single path) as a literal.
    static void CollectVdfList(const std::string& raw, std::vector<std::string>& out)
    {
        if (raw.empty()) return;
        json j = json::parse(raw, nullptr, false);   // never throws
        if (j.is_discarded()) { out.push_back(raw); return; }          // not JSON -> literal
        if (j.is_array())
        {
            for (const auto& e : j)
                if (e.is_string()) { std::string s = e.get<std::string>(); if (!s.empty()) out.push_back(s); }
            return;
        }
        if (j.is_string()) { std::string s = j.get<std::string>(); if (!s.empty()) out.push_back(s); return; }
        out.push_back(raw);                                            // number/bool/object -> literal
    }

    std::string ParseVdfBuildOutput(const std::string& vdfText)
    {
        // Find a quoted "BuildOutput" key (any case) and return its quoted value.
        // Hand-rolled rather than regex: VDF is just `"key" "value"` pairs and the
        // text may be large (file mappings), so a linear scan is plenty.
        const std::string key = "buildoutput";
        for (size_t i = 0; (i = vdfText.find('"', i)) != std::string::npos; )
        {
            size_t end = vdfText.find('"', i + 1);
            if (end == std::string::npos) return "";
            std::string k = vdfText.substr(i + 1, end - i - 1);
            std::transform(k.begin(), k.end(), k.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            size_t vq = vdfText.find('"', end + 1);
            if (vq == std::string::npos) return "";
            size_t vend = vdfText.find('"', vq + 1);
            if (vend == std::string::npos) return "";
            if (k == key) return vdfText.substr(vq + 1, vend - vq - 1);
            i = end + 1;   // next token scan starts after this key; values are revisited as keys, harmlessly
        }
        return "";
    }

    std::string PatchVdfDesc(const std::string& vdfText, const std::string& desc)
    {
        std::string clean = desc;
        std::replace(clean.begin(), clean.end(), '"', '\'');   // VDF values are quote-delimited

        // Same quoted-token scan as ParseVdfBuildOutput: find an existing "Desc"
        // key (any case) and splice the new value over its old one.
        for (size_t i = 0; (i = vdfText.find('"', i)) != std::string::npos; )
        {
            size_t end = vdfText.find('"', i + 1);
            if (end == std::string::npos) break;
            std::string k = vdfText.substr(i + 1, end - i - 1);
            std::transform(k.begin(), k.end(), k.begin(), [](unsigned char c) { return (char)std::tolower(c); });
            size_t vq = vdfText.find('"', end + 1);
            if (vq == std::string::npos) break;
            size_t vend = vdfText.find('"', vq + 1);
            if (vend == std::string::npos) break;
            if (k == "desc")
                return vdfText.substr(0, vq + 1) + clean + vdfText.substr(vend);
            i = end + 1;
        }
        // No Desc key: insert one at the top of the root block.
        size_t brace = vdfText.find('{');
        if (brace == std::string::npos) return vdfText;
        return vdfText.substr(0, brace + 1) + "\n\t\"Desc\" \"" + clean + "\"" + vdfText.substr(brace + 1);
    }

    HandoffCommand BuildSteamCommand(const std::map<std::string, std::string>& f,
                                     const std::map<std::string, std::string>& creds,
                                     const std::string& workingDir)
    {
        HandoffCommand c;
        c.workingDir = workingDir;

        // One or more app-build VDFs. `appBuildVdfs` (a JSON array, carried as a dumped
        // string by RepoConfig) lists multiple apps to publish in a single steamcmd
        // session - e.g. the base game plus each DLC app. `appBuildVdf` (single) remains
        // supported for the one-app case; when only it is set, the command is unchanged.
        std::vector<std::string> vdfs;
        std::string single = Field(f, "appBuildVdf");
        if (!single.empty()) vdfs.push_back(single);
        CollectVdfList(Field(f, "appBuildVdfs"), vdfs);
        if (vdfs.empty()) { c.error = "steam handoff requires 'appBuildVdf' or 'appBuildVdfs'"; return c; }

        std::string user = Field(creds, "username");
        std::string pass = Field(creds, "password");
        c.argv = { Field(f, "steamcmd", "steamcmd") };
        if (!user.empty())
        {
            c.argv.push_back("+login");
            c.argv.push_back(user);
            if (!pass.empty()) c.argv.push_back(pass);
        }
        std::string desc = Field(f, "desc");
        for (const auto& v : vdfs)
        {
            std::string abs = AbsUnder(workingDir, v);
            std::string use = abs;

            std::string text;
            {
                std::ifstream in(abs, std::ios::binary);
                if (in) { std::stringstream ss; ss << in.rdbuf(); text = ss.str(); }
            }

            // A 'desc' field (the agent defaults it to the Smith build number +
            // branch) becomes the upload's Steamworks description. steamcmd only
            // reads it from the VDF, so build from a desc-patched SIBLING copy -
            // same folder, so content_root/BuildOutput relative paths resolve
            // unchanged, and the repo's own VDF is never modified.
            if (!desc.empty() && !text.empty())
            {
                fs::path p(abs);
                fs::path copy = p.parent_path() / (p.stem().string() + ".smith" + p.extension().string());
                std::ofstream o(copy, std::ios::binary | std::ios::trunc);
                if (o) { o << PatchVdfDesc(text, desc); o.close(); use = copy.string(); }
            }

            c.argv.push_back("+run_app_build");
            c.argv.push_back(use);

            // steamcmd block-buffers stdout when piped, so the only live progress
            // is what it writes into each VDF's BuildOutput dir - note those dirs
            // for the agent to tail. BuildOutput is relative to the VDF's folder.
            if (text.empty()) continue;
            std::string out = ParseVdfBuildOutput(text);
            if (out.empty()) continue;
            std::string dir = AbsUnder(fs::path(abs).parent_path().string(), out);
            if (std::find(c.tailDirs.begin(), c.tailDirs.end(), dir) == c.tailDirs.end())
                c.tailDirs.push_back(dir);
        }
        c.argv.push_back("+quit");
        return c;
    }

    HandoffCommand BuildItchCommand(const std::map<std::string, std::string>& f,
                                    const std::map<std::string, std::string>& creds,
                                    const std::string& workingDir)
    {
        HandoffCommand c;
        c.workingDir = workingDir;
        std::string target = Field(f, "target");
        if (target.empty())
        {
            std::string user = Field(f, "user"), game = Field(f, "game"), channel = Field(f, "channel");
            if (!user.empty() && !game.empty())
            {
                target = user + "/" + game;
                if (!channel.empty()) target += ":" + channel;
            }
        }
        if (target.empty()) { c.error = "itch handoff requires 'target' (or user + game [+ channel])"; return c; }

        std::string dir = AbsUnder(workingDir, Field(f, "path", Field(f, "contentRoot")));
        c.argv = { Field(f, "butler", "butler"), "push", dir, target };
        std::string key = Field(creds, "apiKey", Field(creds, "BUTLER_API_KEY"));
        if (!key.empty()) c.env["BUTLER_API_KEY"] = key;
        return c;
    }

    HandoffCommand BuildCloudflareCommand(const std::map<std::string, std::string>& f,
                                          const std::map<std::string, std::string>& creds,
                                          const std::string& workingDir)
    {
        HandoffCommand c;
        c.workingDir = workingDir;
        std::string mode = Field(f, "command", "deploy");          // "deploy" | "pages"
        c.argv = { Field(f, "wrangler", "wrangler") };
        if (mode == "pages")
        {
            c.argv.push_back("pages");
            c.argv.push_back("deploy");
            std::string dir = Field(f, "dir", Field(f, "contentRoot"));
            if (!dir.empty()) c.argv.push_back(AbsUnder(workingDir, dir));
        }
        else
        {
            c.argv.push_back("deploy");
        }
        std::string project = Field(f, "project");
        if (!project.empty()) { c.argv.push_back("--project-name"); c.argv.push_back(project); }
        std::string env = Field(f, "env");
        if (!env.empty()) { c.argv.push_back("--env"); c.argv.push_back(env); }

        std::string token = Field(creds, "apiToken", Field(creds, "CLOUDFLARE_API_TOKEN"));
        if (!token.empty()) c.env["CLOUDFLARE_API_TOKEN"] = token;
        std::string account = Field(creds, "accountId", Field(creds, "CLOUDFLARE_ACCOUNT_ID"));
        if (!account.empty()) c.env["CLOUDFLARE_ACCOUNT_ID"] = account;
        return c;
    }
}
