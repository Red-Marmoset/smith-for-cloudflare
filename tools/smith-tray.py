#!/usr/bin/env python3
"""smith-tray.py - native Linux system-tray for Smith, with zero build/install.

The Linux counterpart of the wxWidgets SmithTray. GNOME Shell removed the legacy
system tray, so a top-bar icon must speak the StatusNotifierItem (SNI) DBus
protocol that the desktop's StatusNotifierWatcher host displays (on Ubuntu that
host is the built-in 'ubuntu-appindicators' extension). This implements SNI +
com.canonical.dbusmenu directly over DBus, so it needs only python3-dbus and
PyGObject - both of which already ship with an Ubuntu/GNOME desktop. No wx, no
GTK dev headers, no compiler, no sudo.

It shows a Smith icon with a live tooltip (coordinator + node + last build),
raises a desktop toast when a build finishes (failures = critical, like the wx
tray), and offers a menu: Open dashboard / Trigger test build / Quit.

Usage: tools/smith-tray.py [--url http://host:port] [--interval SEC]
  --url       coordinator URL (default: auto-discover via `smith discover`)
  --interval  poll seconds (default 5)
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

try:
    import gi
    gi.require_version("Notify", "0.7")
    from gi.repository import Notify
    _HAVE_NOTIFY = True
except Exception:
    _HAVE_NOTIFY = False

SNI_IFACE = "org.kde.StatusNotifierItem"
MENU_IFACE = "com.canonical.dbusmenu"
WATCHER = "org.kde.StatusNotifierWatcher"

# Menu model: (id, label, action-key). id 0 is the invisible root.
MENU_ITEMS = [
    (1, "Open dashboard", "open"),
    (2, "Trigger test build", "trigger"),
    (3, "", "sep"),
    (4, "Quit Smith tray", "quit"),
]


def _here():
    return os.path.dirname(os.path.abspath(__file__))


def discover_url(explicit):
    if explicit:
        return explicit
    sm = os.environ.get("SMITH_BIN", os.path.join(os.path.dirname(_here()), "Build/Smith/Release/Smith"))
    if os.path.exists(sm):
        try:
            out = subprocess.run([sm, "discover"], capture_output=True, text=True, timeout=12).stdout
            for line in out.splitlines():
                i = line.find("http://")
                if i >= 0:
                    return line[i:].split()[0]
        except Exception:
            pass
    return None


def http_json(url, timeout=6, data=None, method=None):
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


class DbusMenu(dbus.service.Object):
    """Minimal com.canonical.dbusmenu so the appindicator host renders the menu."""

    def __init__(self, bus, path, on_action):
        super().__init__(bus, path)
        self._on_action = on_action

    def _props(self, item_id):
        for iid, label, action in MENU_ITEMS:
            if iid == item_id:
                if action == "sep":
                    return dbus.Dictionary({"type": "separator"}, signature="sv")
                return dbus.Dictionary({"label": label, "enabled": True, "visible": True}, signature="sv")
        return dbus.Dictionary({}, signature="sv")

    @dbus.service.method(MENU_IFACE, in_signature="iias", out_signature="u(ia{sv}av)")
    def GetLayout(self, parentId, recursionDepth, propertyNames):
        children = []
        for iid, label, action in MENU_ITEMS:
            child = dbus.Struct(
                (dbus.Int32(iid), self._props(iid), dbus.Array([], signature="v")),
                signature="ia{sv}av",
            )
            children.append(dbus.Variant if False else child)  # struct wrapped as variant below
        child_variants = dbus.Array(
            [dbus.Struct((dbus.Int32(iid), self._props(iid), dbus.Array([], signature="v")), signature="ia{sv}av")
             for iid, _, _ in MENU_ITEMS],
            signature="v",
        )
        root = dbus.Struct(
            (dbus.Int32(0),
             dbus.Dictionary({"children-display": "submenu"}, signature="sv"),
             child_variants),
            signature="ia{sv}av",
        )
        return dbus.UInt32(1), root

    @dbus.service.method(MENU_IFACE, in_signature="aias", out_signature="a(ia{sv})")
    def GetGroupProperties(self, ids, propertyNames):
        return dbus.Array(
            [dbus.Struct((dbus.Int32(iid), self._props(iid)), signature="ia{sv}") for iid, _, _ in MENU_ITEMS],
            signature="(ia{sv})",
        )

    @dbus.service.method(MENU_IFACE, in_signature="is", out_signature="v")
    def GetProperty(self, id, name):
        return self._props(id).get(name, "")

    @dbus.service.method(MENU_IFACE, in_signature="isvu", out_signature="")
    def Event(self, id, eventId, data, timestamp):
        if eventId == "clicked":
            for iid, _, action in MENU_ITEMS:
                if iid == id:
                    self._on_action(action)

    @dbus.service.method(MENU_IFACE, in_signature="i", out_signature="b")
    def AboutToShow(self, id):
        return False

    @dbus.service.method(MENU_IFACE, in_signature="", out_signature="u")
    def GetProperty_unused(self):
        return dbus.UInt32(0)

    @dbus.service.signal(MENU_IFACE, signature="ui")
    def LayoutUpdated(self, revision, parent):
        pass


class StatusNotifierItem(dbus.service.Object):
    def __init__(self, bus, path, app):
        super().__init__(bus, path)
        self._app = app

    # ---- properties ----
    def _get_all(self):
        return {
            "Category": "ApplicationStatus",
            "Id": "smith",
            "Title": "Smith",
            "Status": self._app.status,         # Active | NeedsAttention
            "IconName": self._app.icon_name,
            "OverlayIconName": "",
            "AttentionIconName": "dialog-warning",
            "ToolTip": dbus.Struct(("", dbus.Array([], signature="(iiay)"), "Smith", self._app.tooltip),
                                   signature="sa(iiay)ss"),
            "ItemIsMenu": True,
            "Menu": dbus.ObjectPath(self._app.menu_path),
        }

    @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        return self._get_all().get(prop, "")

    @dbus.service.method(dbus.PROPERTIES_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return dbus.Dictionary(self._get_all(), signature="sv")

    # ---- methods (host calls these on click) ----
    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def Activate(self, x, y):
        self._app.action("open")

    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def SecondaryActivate(self, x, y):
        self._app.action("trigger")

    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def ContextMenu(self, x, y):
        pass

    @dbus.service.method(SNI_IFACE, in_signature="iis", out_signature="")
    def Scroll(self, delta, orientation, _s=""):
        pass

    @dbus.service.signal(SNI_IFACE, signature="")
    def NewIcon(self):
        pass

    @dbus.service.signal(SNI_IFACE, signature="s")
    def NewStatus(self, status):
        pass

    @dbus.service.signal(SNI_IFACE, signature="")
    def NewToolTip(self):
        pass


class TrayApp:
    def __init__(self, url, interval):
        self._explicit = url
        self.url = None
        self.interval = interval
        self.status = "Active"
        self.icon_name = "applications-development"   # themed icon; always present
        self.tooltip = "Smith - connecting..."
        self.menu_path = "/MenuBar"
        self._seen = {}
        self._baselined = False
        if _HAVE_NOTIFY:
            Notify.init("Smith")

    def toast(self, title, body, critical=False):
        if _HAVE_NOTIFY:
            n = Notify.Notification.new(title, body, "dialog-warning" if critical else "applications-development")
            n.set_urgency(2 if critical else 1)
            try:
                n.show()
            except Exception:
                pass

    def action(self, key):
        if key == "open":
            if self.url:
                subprocess.Popen(["xdg-open", self.url + "/"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif key == "trigger":
            if self.url:
                try:
                    http_json(self.url + "/api/trigger", data=json.dumps(
                        {"projectId": "smith", "product": "test", "branch": "main"}).encode(), method="POST")
                    self.toast("Smith", "Triggered smith / test")
                except Exception as e:
                    self.toast("Smith", "Trigger failed: %s" % e, critical=True)
        elif key == "quit":
            self.loop.quit()
        elif key == "sep":
            pass

    def poll(self):
        self.url = discover_url(self._explicit)
        if not self.url:
            self.tooltip = "Smith - no coordinator found"
            self.sni.NewToolTip()
            return True
        try:
            nodes = http_json(self.url + "/api/nodes")
            online = sum(1 for n in nodes if n.get("online"))
            projs = http_json(self.url + "/api/projects")
            failing = False
            last = ""
            for p in projs:
                try:
                    builds = http_json(self.url + "/api/projects/%s/builds" % p["id"])
                except Exception:
                    continue
                for b in builds:
                    st = b.get("status", "")
                    key = b["jobId"]
                    prev = self._seen.get(key)
                    self._seen[key] = st
                    if st in ("success", "failed", "error"):
                        if not last:
                            last = "%s/%s #%s: %s" % (p["id"], b.get("product", ""), b.get("buildNumber", ""), st)
                        if st != "success":
                            failing = True
                        if prev != st and self._baselined:
                            crit = st != "success"
                            self.toast("Smith: build %s" % st,
                                       "%s / %s #%s" % (p["id"], b.get("product", ""), b.get("buildNumber", "")),
                                       critical=crit)
            self._baselined = True
            self.tooltip = "Smith @ %s\n%d node(s) online\n%s" % (self.url, online, last or "no builds yet")
            new_status = "NeedsAttention" if failing else "Active"
            if new_status != self.status:
                self.status = new_status
                self.sni.NewStatus(self.status)
            self.sni.NewToolTip()
        except Exception as e:
            self.tooltip = "Smith - error: %s" % e
            self.sni.NewToolTip()
        return True

    def run(self):
        DBusGMainLoop(set_as_default=True)
        bus = dbus.SessionBus()
        self.bus_name = dbus.service.BusName("org.kde.StatusNotifierItem-%d-1" % os.getpid(), bus)
        self.menu = DbusMenu(bus, self.menu_path, self.action)
        self.sni = StatusNotifierItem(bus, "/StatusNotifierItem", self)
        # register with the desktop's watcher
        watcher = bus.get_object(WATCHER, "/StatusNotifierWatcher")
        watcher.RegisterStatusNotifierItem(self.bus_name.get_name(),
                                           dbus_interface=WATCHER)
        print("[smith-tray] registered SNI %s; icon should appear in the top bar" % self.bus_name.get_name())
        self.poll()
        GLib.timeout_add_seconds(self.interval, self.poll)
        self.loop = GLib.MainLoop()
        self.loop.run()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None)
    ap.add_argument("--interval", type=int, default=5)
    args = ap.parse_args()
    TrayApp(args.url, args.interval).run()


if __name__ == "__main__":
    main()
