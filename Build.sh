#!/bin/sh
# Build.sh - Build Smith using the Una engine's BuildTool (Linux/macOS).
# POSIX sh (Smith runs build scripts via /bin/sh, which may be dash).
# Usage: ./Build.sh [ProjectName] [extra BuildTool args...]   (default: Smith)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="${1:-Smith}"
[ $# -gt 0 ] && shift

# Locate the Una engine. UNA_ENGINE_PATH wins; otherwise search common locations,
# validating each candidate actually has a bootstrapped BuildTool.
ENGINE=""
for c in "${UNA_ENGINE_PATH:-}" "/c/code/engine" "/code/engine" "$HOME/code/engine" "$(dirname "$SCRIPT_DIR")/engine"; do
    [ -n "$c" ] || continue
    for cfg in Release Debug Bootstrap; do
        if [ -x "$c/Build/BuildTool/$cfg/BuildTool" ]; then ENGINE="$c"; break; fi
    done
    [ -n "$ENGINE" ] && break
done
if [ -z "$ENGINE" ]; then
    echo "ERROR: Una engine not found. Set UNA_ENGINE_PATH to your engine checkout (with a bootstrapped BuildTool)." >&2
    exit 1
fi
export UNA_ENGINE_PATH="$ENGINE"
echo "[Build.sh] Una engine: $ENGINE"

PROJECT="$SCRIPT_DIR/Workspaces/Projects/$PROJECT_NAME/Project.json"
if [ ! -f "$PROJECT" ]; then
    echo "ERROR: Project file not found at $PROJECT" >&2
    exit 1
fi

BUILDTOOL=""
for cfg in Release Debug Bootstrap; do
    if [ -x "$ENGINE/Build/BuildTool/$cfg/BuildTool" ]; then BUILDTOOL="$ENGINE/Build/BuildTool/$cfg/BuildTool"; break; fi
done

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
cd "$SCRIPT_DIR"

# Which engine are we actually building against? Smith consumes the engine
# out-of-tree, so a build agent with a stale checkout fails in ways that look
# like a Smith bug - a missing engine API surfaces only as "Compilation failed"
# with no diagnostic. Record the revision in every build log so the next one is
# diagnosable from the log alone.
if command -v git >/dev/null 2>&1 && [ -d "$ENGINE/.git" ]; then
    echo "[Build.sh] Engine: $ENGINE @ $(git -C "$ENGINE" log -1 --format='%h %ad %s' --date=short 2>/dev/null)"
else
    echo "[Build.sh] Engine: $ENGINE (revision unknown)"
fi

# Keep the coordinator's embedded web assets (Modules/SmithCoordinator/WebAssets.cpp)
# in sync with web/ so the production binary never serves a stale UI. WebAssets.cpp is
# generated - never hand-edited. Skips quietly if python3 or the generator is absent.
if [ -d "$SCRIPT_DIR/web" ] && [ -f "$SCRIPT_DIR/tools/gen-web-assets.py" ] && command -v python3 >/dev/null 2>&1; then
    echo "[Build.sh] Regenerating embedded web assets"
    python3 "$SCRIPT_DIR/tools/gen-web-assets.py" >/dev/null \
        || echo "[Build.sh] WARNING: web-asset regen failed; building with existing WebAssets.cpp" >&2
fi
# Stale-cache guard. BuildTool's shared cache is keyed per module, so after a
# header LAYOUT change (adding a member to a struct in a header another module
# includes - typically after switching branches or pulling) it can hand back a
# module compiled against the OLD layout. That links cleanly and then corrupts
# memory at runtime: garbage container sizes, std::length_error, or a hang. So
# hash the headers/manifests and nuke the cache whenever they move. Same
# belt-and-braces clean as Build.ps1 -Clean: BuildTool's own --clean has proved
# less reliable than removing the directories ourselves.
HASH_FILE="$SCRIPT_DIR/Build/.header-state"
HEADER_HASH="$(find "$SCRIPT_DIR/Modules" "$SCRIPT_DIR/Workspaces" \
                    -type f \( -name '*.h' -o -name 'Module.manifest' -o -name 'Project.json' \) 2>/dev/null \
               | sort | xargs cat 2>/dev/null | cksum | cut -d' ' -f1)"
if [ -n "$HEADER_HASH" ] && [ "$HEADER_HASH" != "$(cat "$HASH_FILE" 2>/dev/null)" ]; then
    if [ -d "$SCRIPT_DIR/.una" ] || [ -d "$SCRIPT_DIR/Build/Intermediate" ]; then
        echo "[Build.sh] Headers changed since the last build - clearing the build cache"
        rm -rf "$SCRIPT_DIR/.una" "$SCRIPT_DIR/Build/Intermediate"
    fi
fi

# Force clang on Unix: the Project.json compiler field is "msvc" (for Windows),
# but BuildTool honours it verbatim and would try msvc here. clang is the engine's
# default Unix toolchain. Callers can still override by passing --compiler in "$@".
"$BUILDTOOL" "$PROJECT" -config Release --compiler clang -j "$JOBS" "$@"
RC=$?
# Only record the header state once the build actually succeeded, so a failed
# build doesn't leave the next one thinking the cache is already consistent.
if [ "$RC" -eq 0 ] && [ -n "$HEADER_HASH" ]; then
    mkdir -p "$SCRIPT_DIR/Build"
    printf '%s' "$HEADER_HASH" > "$HASH_FILE"
fi
exit "$RC"
