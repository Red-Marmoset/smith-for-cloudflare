// TrayIcon.cpp - tray icon, context menu, status polling and failure toasts.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "TrayIcon.h"
#include "TrayIconData.h"

#include <Http/Http.h>
#include <SmithCore/Process.h>

#include <json/single_include/nlohmann/json.hpp>

#include <wx/app.h>
#include <wx/menu.h>
#include <wx/image.h>
#include <wx/bitmap.h>
#include <wx/mstream.h>
#include <wx/notifmsg.h>
#include <wx/utils.h>          // wxLaunchDefaultBrowser

#include <vector>
#include <utility>
#include <algorithm>
#include <cctype>

using nlohmann::json;

namespace SmithTrayApp
{
    enum { ID_OPEN = wxID_HIGHEST + 1, ID_QUIT };

    TrayIcon::TrayIcon(int port, const std::string& token)
        : m_port(port), m_token(token)
    {
        m_baseUrl = "http://127.0.0.1:" + std::to_string(port);

        // Resolve the local git identity once, so we toast only this user's own
        // breakages (each build is attributed by its commit author email).
        {
            Smith::Process gp;
            Smith::ProcessOptions o;
            o.argv = { "git", "config", "user.email" };
            std::string email;
            gp.Run(o, [&](bool isErr, const std::string& line) { if (!isErr && email.empty()) email = line; });
            size_t a = email.find_first_not_of(" \t\r\n");
            if (a != std::string::npos)
            {
                size_t b = email.find_last_not_of(" \t\r\n");
                m_localEmail = email.substr(a, b - a + 1);
                std::transform(m_localEmail.begin(), m_localEmail.end(), m_localEmail.begin(),
                               [](unsigned char c) { return (char)std::tolower(c); });
            }
        }

        // Load the embedded Agent Smith mark (web/favicon.png, 32x32) as the icon.
        wxMemoryInputStream mis(Smith::kTrayIconPng, Smith::kTrayIconPngLen);
        wxImage img(mis, wxBITMAP_TYPE_PNG);
        if (img.IsOk())
        {
            wxBitmap bmp(img);
            m_icon.CopyFromBitmap(bmp);
            SetIcon(m_icon, "Smith - starting...");
        }

        Bind(wxEVT_MENU, &TrayIcon::OnOpen, this, ID_OPEN);
        Bind(wxEVT_MENU, &TrayIcon::OnQuit, this, ID_QUIT);
        Bind(wxEVT_TASKBAR_LEFT_DCLICK, &TrayIcon::OnLeftDClick, this);

        m_timer.SetOwner(this);
        Bind(wxEVT_TIMER, &TrayIcon::OnTimer, this);
        m_timer.Start(4000);                  // poll the local coordinator every 4s
    }

    wxMenu* TrayIcon::CreatePopupMenu()
    {
        wxMenu* menu = new wxMenu();
        wxString status = m_up
            ? wxString::Format("Smith - %d node%s%s", m_nodeCount, m_nodeCount == 1 ? "" : "s",
                               m_building ? ", building..." : "")
            : wxString("Smith - coordinator starting...");
        menu->Append(wxID_ANY, status)->Enable(false);
        menu->AppendSeparator();
        menu->Append(ID_OPEN, "&Open Smith in browser");
        menu->AppendSeparator();
        menu->Append(ID_QUIT, "&Quit Smith");
        return menu;
    }

    void TrayIcon::OnOpen(wxCommandEvent&) { OpenBrowser(); }
    void TrayIcon::OnLeftDClick(wxTaskBarIconEvent&) { OpenBrowser(); }

    void TrayIcon::OnQuit(wxCommandEvent&)
    {
        m_timer.Stop();
        wxTheApp->ExitMainLoop();             // OnExit() then stops the coordinator
    }

    void TrayIcon::OnTimer(wxTimerEvent&) { Poll(); }

    void TrayIcon::OpenBrowser()
    {
        wxLaunchDefaultBrowser(wxString::Format("http://127.0.0.1:%d/", m_port));
    }

    void TrayIcon::Poll()
    {
        Http::Client client(m_baseUrl);
        if (!m_token.empty()) client.SetBearerToken(m_token);
        client.SetTimeoutSeconds(2);

        Http::Result nodes = client.Get("/api/nodes");
        if (!nodes.ok || nodes.status != 200)
        {
            m_up = false;
            UpdateTooltip();
            return;
        }
        m_up = true;

        int count = 0;
        bool building = false;
        json jn = json::parse(nodes.body, nullptr, false);
        if (jn.is_array())
        {
            count = (int)jn.size();
            for (const auto& n : jn)
                if (n.is_object() && n.value("status", std::string()) == "busy") building = true;
        }
        m_nodeCount = count;
        m_building = building;

        // Scan each project's recent builds for newly-failed jobs -> toast. Only the
        // local user's own breakages are surfaced (attributed by commit email), with
        // the error/test-failure counts once the diagnostics have been parsed.
        std::set<std::string> currentFailures;
        struct FreshFail { std::string title, body; };
        std::vector<FreshFail> fresh;

        Http::Result projects = client.Get("/api/projects");
        if (projects.ok && projects.status == 200)
        {
            json jp = json::parse(projects.body, nullptr, false);
            if (jp.is_array())
            {
                for (const auto& p : jp)
                {
                    if (!p.is_object()) continue;
                    std::string pid = p.value("id", std::string());
                    if (pid.empty()) continue;
                    std::string label = p.value("name", pid);

                    // Only builds that failed since the last poll can be fresh, so
                    // the newest few are enough - no need to pull the whole history
                    // on every tick.
                    Http::Result builds = client.Get("/api/projects/" + pid + "/builds?limit=25");
                    if (!builds.ok || builds.status != 200) continue;
                    json jb = json::parse(builds.body, nullptr, false);
                    if (!jb.is_array()) continue;

                    for (const auto& b : jb)
                    {
                        if (!b.is_object()) continue;
                        if (b.value("status", std::string()) != "failed") continue;
                        std::string jobId = b.value("jobId", std::string());
                        if (jobId.empty()) continue;
                        currentFailures.insert(jobId);
                        if (!m_baselined || m_seenFailures.count(jobId)) continue;
                        m_seenFailures.insert(jobId);     // mark seen now so it never re-toasts

                        // Skip if this is provably someone else's breakage.
                        std::string author = b.value("authorEmail", std::string());
                        std::transform(author.begin(), author.end(), author.begin(),
                                       [](unsigned char c) { return (char)std::tolower(c); });
                        bool mine = m_localEmail.empty() || author.empty() || author == m_localEmail;
                        if (!mine) continue;

                        int errs = 0, tf = 0; bool parsed = false;
                        if (b.contains("diag") && b["diag"].is_object())
                        {
                            errs = b["diag"].value("errors", 0);
                            tf = b["diag"].value("testsFailed", 0);
                            parsed = b["diag"].value("parsed", false);
                        }
                        std::string counts;
                        if (parsed && (errs || tf))
                        {
                            counts = " - ";
                            if (errs) counts += std::to_string(errs) + (errs == 1 ? " error" : " errors");
                            if (errs && tf) counts += ", ";
                            if (tf) counts += std::to_string(tf) + (tf == 1 ? " test failure" : " test failures");
                        }
                        bool isMineExactly = !author.empty() && author == m_localEmail;
                        std::string title = isMineExactly ? "Smith - your commit broke the build" : "Smith - build failed";
                        std::string body = label + " / " + b.value("product", std::string())
                            + " #" + std::to_string(b.value("buildNumber", 0)) + counts;
                        fresh.push_back({ title, body });
                    }
                }
            }
        }

        if (!m_baselined)
        {
            m_seenFailures = currentFailures;     // first poll: baseline, don't toast history
            m_baselined = true;
        }
        else
        {
            for (const auto& f : fresh)
            {
                wxNotificationMessage note(wxString::FromUTF8(f.title.c_str()),
                                           wxString::FromUTF8(f.body.c_str()), nullptr);
                note.Show(wxNotificationMessage::Timeout_Auto);
            }
        }

        UpdateTooltip();
    }

    void TrayIcon::UpdateTooltip()
    {
        if (!m_icon.IsOk()) return;
        wxString tip = m_up
            ? wxString::Format("Smith - %d node%s%s", m_nodeCount, m_nodeCount == 1 ? "" : "s",
                               m_building ? ", building..." : "")
            : wxString("Smith - coordinator starting...");
        SetIcon(m_icon, tip);
    }
}
