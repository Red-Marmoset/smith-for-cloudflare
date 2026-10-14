#!/usr/bin/env bash
# smith-notify.sh - desktop toast notifications for Smith builds (macOS + Linux).
#
# The headless complement to SmithTray (which links wxWidgets). It pops a desktop
# toast when a build reaches a terminal state - osascript on macOS, notify-send on
# Linux - so you get the tray's failure-toast behaviour on a headless box (or a
# GNOME/Ubuntu desktop where the wx tray isn't built). Mirrors TrayIcon.cpp: it
# baselines existing builds on the first poll (no history spam), then toasts only
# new transitions.
#
# Usage: tools/smith-notify.sh [--url http://host:port] [--interval SEC] [--all]
#   --url       coordinator URL (default: auto-discover on the LAN via `smith discover`)
#   --interval  poll seconds (default 5)
#   --all       toast successes too (default: failures only, like the wx tray)
#
# Runs in the foreground; background it with `setsid nohup ... &` to keep it alive.
set -u

SM_BIN="${SMITH_BIN:-$(cd "$(dirname "$0")/.." && pwd)/Build/Smith/Release/Smith}"
URL=""
INTERVAL=5
ALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --url)      URL="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --all)      ALL=1; shift ;;
        *) shift ;;
    esac
done

OS="$(uname -s)"
# On Linux, notify-send needs a display + session bus; default them so this also
# works when launched detached from the desktop session (cron, nohup, ssh).
if [ "$OS" = "Linux" ]; then
    export DISPLAY="${DISPLAY:-:0}"
    export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
fi

discover_url() {
    [ -n "$URL" ] && { echo "$URL"; return; }
    [ -x "$SM_BIN" ] && "$SM_BIN" discover 2>/dev/null | sed -n 's/.*at \(http[^ ]*\).*/\1/p' | head -1
}

toast() { # title  body  urgency(normal|critical)
    case "$OS" in
        Darwin)
            # osascript has no urgency levels; give criticals a sound. Escape
            # backslashes and double quotes for the AppleScript string literals.
            _t=$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')
            _b=$(printf '%s' "$2" | sed 's/[\\"]/\\&/g')
            if [ "$3" = "critical" ]; then
                osascript -e "display notification \"$_b\" with title \"$_t\" sound name \"Basso\"" 2>/dev/null
            else
                osascript -e "display notification \"$_b\" with title \"$_t\"" 2>/dev/null
            fi
            ;;
        *)
            notify-send -a "Smith" -u "$3" "$1" "$2" 2>/dev/null
            ;;
    esac
}

echo "[smith-notify] watching for build results (interval ${INTERVAL}s, all=${ALL})"
declare -A SEEN
baselined=0
while true; do
    u="$(discover_url)"
    if [ -z "$u" ]; then sleep "$INTERVAL"; continue; fi

    builds="$(curl -s --max-time 6 "$u/api/projects" 2>/dev/null | python3 -c '
import sys, json, urllib.request
base = sys.argv[1]
try:
    projs = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for p in projs:
    pid = p["id"]
    try:
        with urllib.request.urlopen(base + "/api/projects/" + pid + "/builds", timeout=6) as r:
            for b in json.load(r):
                print(b["jobId"], b.get("status",""), pid, b.get("product",""), b.get("buildNumber",""))
    except Exception:
        pass
' "$u" 2>/dev/null)"

    while read -r job st pid prod num; do
        [ -z "$job" ] && continue
        prev="${SEEN[$job]:-}"
        SEEN[$job]="$st"
        case "$st" in
            success|failed|error)
                if [ "$prev" != "$st" ] && [ "$baselined" = "1" ]; then
                    if [ "$st" = "success" ]; then
                        [ "$ALL" = "1" ] && toast "Smith: build passed" "$pid / $prod #$num" normal
                    else
                        toast "Smith: build $st" "$pid / $prod #$num" critical
                    fi
                    echo "[smith-notify] toast: $pid/$prod #$num -> $st"
                fi
                ;;
        esac
    done <<< "$builds"
    baselined=1
    sleep "$INTERVAL"
done
