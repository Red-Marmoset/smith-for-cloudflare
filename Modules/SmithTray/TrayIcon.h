// TrayIcon.h - the wxTaskBarIcon: status tooltip, context menu, failure toasts.
// Copyright (c) 2026 Red Marmoset Studios Ltd.
#pragma once

#include <wx/taskbar.h>
#include <wx/timer.h>
#include <wx/icon.h>

#include <string>
#include <set>

namespace SmithTrayApp
{
    // A tray icon that polls the local coordinator for status. One icon (the
    // Agent Smith mark) with a live tooltip; failures raise a desktop toast.
    class TrayIcon : public wxTaskBarIcon
    {
    public:
        TrayIcon(int port, const std::string& token);

        wxMenu* CreatePopupMenu() override;

    private:
        void OnOpen(wxCommandEvent&);
        void OnQuit(wxCommandEvent&);
        void OnLeftDClick(wxTaskBarIconEvent&);
        void OnTimer(wxTimerEvent&);

        void Poll();
        void UpdateTooltip();
        void OpenBrowser();

        int m_port;
        std::string m_token;
        std::string m_baseUrl;
        std::string m_localEmail;             // local git identity, to toast only the user's own breakages
        wxIcon m_icon;
        wxTimer m_timer;

        bool m_up = false;
        bool m_building = false;
        int m_nodeCount = 0;
        bool m_baselined = false;             // seed failures on first poll, don't toast them
        std::set<std::string> m_seenFailures; // failed jobIds already surfaced
    };
}
