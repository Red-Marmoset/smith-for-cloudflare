#!/bin/sh
# RunTests.sh - build + run every Tests/<Name>/Project.json (Linux/macOS).
# POSIX sh port of RunTests.ps1. Each test exe returns its failure count as the
# exit code (0 = all passed); this script returns non-zero if any suite fails.
#
# Usage: ./RunTests.sh [Release|Debug]   (JOBS=N caps parallel compiles, default 4)
set -u

CONFIG="${1:-Release}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Locate the Una engine. UNA_ENGINE_PATH wins; else search common locations,
# validating each candidate has a bootstrapped BuildTool.
BT=""
for eng in "${UNA_ENGINE_PATH:-}" "/c/code/engine" "/code/engine" "$HOME/code/engine" "$(dirname "$DIR")/engine"; do
    [ -n "$eng" ] || continue
    for cfg in Release Debug Bootstrap; do
        if [ -x "$eng/Build/BuildTool/$cfg/BuildTool" ]; then BT="$eng/Build/BuildTool/$cfg/BuildTool"; UNA_ENGINE_PATH="$eng"; break; fi
    done
    [ -n "$BT" ] && break
done
if [ -z "$BT" ]; then
    echo "ERROR: Una engine not found. Set UNA_ENGINE_PATH to your engine checkout (with a bootstrapped BuildTool)." >&2
    exit 1
fi
export UNA_ENGINE_PATH

if [ ! -d "$DIR/Tests" ]; then
    echo "[RunTests] No Tests/ directory - nothing to run."
    exit 0
fi

passed=0
failed=0
failed_names=""

# Which engine are we actually building against? Smith consumes the engine
# out-of-tree, so an agent with a stale checkout fails in ways that look like a
# Smith bug (e.g. Agent.cpp needing Http::Client::GetToFile, added to the engine
# 2026-06-17, against an engine from before that). Record it in every log.
if command -v git >/dev/null 2>&1 && [ -d "$UNA_ENGINE_PATH/.git" ]; then
    echo "[RunTests] Engine: $UNA_ENGINE_PATH @ $(git -C "$UNA_ENGINE_PATH" log -1 --format='%h %ad %s' --date=short 2>/dev/null)"
else
    echo "[RunTests] Engine: $UNA_ENGINE_PATH (revision unknown)"
fi

# EVERY test project builds with --clean, matching RunTests.ps1. BuildTool's
# shared-cache signature does not reliably track source/header changes, so a
# module cached by one project and reused by the next can be an ABI mismatch:
# it links cleanly, then hands back garbage container sizes at runtime
# (std::length_error, or a bogus vector::size like 2078209983). Cleaning only
# the first project - as this script used to - left projects 2..N exposed and
# made SmithFeaturesTest/SmithProtocolTest fail on Linux while Windows passed.
# Correctness over the few seconds saved.

for proj in "$DIR"/Tests/*/Project.json; do
    [ -f "$proj" ] || continue
    name=$(basename "$(dirname "$proj")")
    echo ""
    echo "======== $name ========"
    # Cap parallel compiles, matching RunTests.ps1 and Build.ps1: more can exhaust compiler memory on a clean build.
    if ! "$BT" "$proj" -config "$CONFIG" --compiler clang --clean -j "${JOBS:-4}"; then
        echo "ERROR: build failed for $name" >&2
        failed=$((failed + 1)); failed_names="$failed_names $name(build)"; continue
    fi
    exe="$DIR/Build/$name/$CONFIG/$name"
    if [ ! -x "$exe" ]; then
        echo "ERROR: test exe not found: $exe" >&2
        failed=$((failed + 1)); failed_names="$failed_names $name(noexe)"; continue
    fi
    # Integration tests must never update the host's installed tools.
    # The test's own output (agent chatter: tool maintenance, chat/Codex runs,
    # heartbeats) goes to Build/TestLogs/<name>.log, not the build log; it is
    # printed only when the test fails. Keep in step with RunTests.ps1.
    mkdir -p "$DIR/Build/TestLogs"
    log="$DIR/Build/TestLogs/$name.log"
    if SMITH_AUTO_UPDATE_TOOLS=0 "$exe" >"$log" 2>&1; then
        echo "$name passed"; passed=$((passed + 1))
    else
        rc=$?
        cat "$log"
        echo "$name FAILED (exit $rc) - output above, also in $log"; failed=$((failed + 1)); failed_names="$failed_names $name"
    fi
done

echo ""
echo "========================================"
if [ "$failed" -eq 0 ]; then
    echo "ALL $passed TEST PROJECT(S) PASSED"
    exit 0
fi
echo "$failed TEST PROJECT(S) FAILED, $passed PASSED:$failed_names" >&2
exit 1
