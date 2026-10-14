// TrayApp.h - the SmithTray wxApp. Runs an embedded coordinator (with a
// co-located agent) on a background thread and shows a system-tray icon.
//
// This is the ONLY Smith component that links wxWidgets; everything it drives
// (the coordinator + agent) is wx-free.
//
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <wx/wx.h>

#include <SmithCore/Config.h>

#include <memory>
#include <thread>

namespace Smith { class Coordinator; }

namespace SmithTrayApp
{
    class TrayIcon;

    class TrayApp : public wxApp
    {
    public:
        TrayApp();                            // ctor + dtor are out-of-line so the
        ~TrayApp();                           // unique_ptr<Coordinator> deleter is only
                                              // instantiated in the .cpp (complete type)
        bool OnInit() override;
        int OnExit() override;

    private:
        Smith::CoordinatorConfig ParseArgs();

        std::unique_ptr<Smith::Coordinator> m_coordinator;
        std::thread m_coordinatorThread;
        TrayIcon* m_tray = nullptr;
    };
}

wxDECLARE_APP(SmithTrayApp::TrayApp);
