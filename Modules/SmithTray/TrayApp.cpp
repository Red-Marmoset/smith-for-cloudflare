// TrayApp.cpp - SmithTray application lifecycle.
// Copyright (c) 2026 Red Marmoset Studios Ltd.

#include "TrayApp.h"
#include "TrayIcon.h"

#include <SmithCoordinator/Coordinator.h>
#include <Log/Log.h>

#include <wx/image.h>
#include <wx/imagpng.h>
#include <wx/stdpaths.h>
#include <wx/filename.h>
#include <wx/tokenzr.h>

namespace SmithTrayApp
{
    // Defined here (not =default in the header) so the unique_ptr<Coordinator>
    // deleter is instantiated where Coordinator is a complete type.
    TrayApp::TrayApp() = default;
    TrayApp::~TrayApp() = default;

    static std::vector<std::string> SplitCsv(const wxString& s)
    {
        std::vector<std::string> out;
        wxStringTokenizer tok(s, ",");
        while (tok.HasMoreTokens())
        {
            wxString t = tok.GetNextToken().Trim(true).Trim(false);
            if (!t.empty()) out.push_back(t.ToStdString());
        }
        return out;
    }

    Smith::CoordinatorConfig TrayApp::ParseArgs()
    {
        Smith::CoordinatorConfig cfg;
        cfg.withAgent = true;                 // the tray is a one-box Smith by default

        // Default data/web dirs sit next to the executable so the tray is portable.
        wxFileName exe(wxStandardPaths::Get().GetExecutablePath());
        wxString exeDir = exe.GetPath();
        cfg.dataDir = (exeDir + wxFILE_SEP_PATH + "smith-data").ToStdString();
        cfg.webDir  = (exeDir + wxFILE_SEP_PATH + "web").ToStdString();

        for (int i = 1; i < argc; ++i)
        {
            wxString a = argv[i];
            auto next = [&]() -> wxString { return (i + 1 < argc) ? wxString(argv[++i]) : wxString(); };

            if (a == "--port") cfg.port = wxAtoi(next());
            else if (a == "--data-dir") cfg.dataDir = next().ToStdString();
            else if (a == "--web-dir") cfg.webDir = next().ToStdString();
            else if (a == "--token") cfg.token = next().ToStdString();
            else if (a == "--agent-labels") cfg.agentLabels = SplitCsv(next());
            else if (a == "--project") cfg.projectConfigPaths.push_back(next().ToStdString());
            else if (a == "--project-repo") cfg.projectRepos.push_back(next().ToStdString());
            else if (a == "--poll-interval-sec") cfg.pollIntervalSec = wxAtoi(next());
            else if (a == "--no-agent") cfg.withAgent = false;
        }
        return cfg;
    }

    bool TrayApp::OnInit()
    {
        // Deliberately do NOT call wxApp::OnInit() - its default command-line
        // handling would reject our custom flags. wx has already populated argv.
        // Register only the PNG handler (the embedded icon is PNG). Using the
        // all-handlers init would pull wxWidgets' WebP handler object, whose
        // libwebp symbols this wx build doesn't link (LNK2019).
        wxImage::AddHandler(new wxPNGHandler());
        SetExitOnFrameDelete(false);          // tray-only app: no top-level window

        Smith::CoordinatorConfig cfg = ParseArgs();
        const int port = cfg.port;
        const std::string token = cfg.token;

        m_coordinator = std::make_unique<Smith::Coordinator>(cfg);
        m_coordinator->LoadProjects();
        m_coordinatorThread = std::thread([this]()
        {
            if (!m_coordinator->Start())
                LOG_ERROR("SmithTray", "embedded coordinator failed to start (port in use?)");
        });

        m_tray = new TrayIcon(port, token);
        if (!m_tray->IsOk())
            LOG_ERROR("SmithTray", "failed to install the system-tray icon");

        LOG_INFO("SmithTray", "Smith tray running; coordinator on http://127.0.0.1:%d/", port);
        return true;
    }

    int TrayApp::OnExit()
    {
        if (m_coordinator) m_coordinator->Stop();
        if (m_coordinatorThread.joinable()) m_coordinatorThread.join();
        if (m_tray)
        {
            m_tray->RemoveIcon();
            delete m_tray;
            m_tray = nullptr;
        }
        return 0;
    }
}
