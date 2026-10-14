#!/bin/sh
# Run from the extracted experiment package.
#
# The agent keeps itself up to date: when the dashboard publishes a newer package it installs it
# between builds and exits with code 10, and this launcher starts the new version at once. If the
# new version stops before the coordinator accepts it, the previous files are put back.
# Set SMITH_AGENT_AUTO_UPDATE=0 to switch that off.
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET='https://exp.redmarmosetstudios.com'

# Puts back the files an update replaced, and remembers the version so it is not tried again.
roll_back() {
    echo "The updated agent stopped before the coordinator accepted it (exit code $1); going back to the previous version."
    for previous in "$PACKAGE_DIR/.update-previous/"* "$PACKAGE_DIR/.update-previous/".[!.]*; do
        [ -e "$previous" ] && mv -f "$previous" "$PACKAGE_DIR/"
    done
    mv -f "$PACKAGE_DIR/update-pending.json" "$PACKAGE_DIR/update-rejected.json"
    rm -rf "$PACKAGE_DIR/.update-previous"
}

# Everything lives in this function, which sh reads whole before running it: an update replaces
# this file while the agent runs, and sh would otherwise carry on reading the new file mid-way.
main() {
    mode="${1:-}"
    [ "$#" -eq 0 ] || shift
    cd "$PACKAGE_DIR"
    case "$mode" in
        agent)
            echo "Smith experiment agent: $TARGET"
            SMITH_UPDATE_SUPERVISED=1
            export SMITH_UPDATE_SUPERVISED
            while :; do
                code=0
                ./Smith hosted-agent --coordinator "$TARGET" --workspace "$PACKAGE_DIR/hosted-workspace" "$@" || code=$?
                if [ "$code" -eq 10 ]; then
                    echo 'Smith updated itself; starting the new version.'
                elif [ "$code" -ne 0 ] && [ -f update-pending.json ] && [ -d .update-previous ]; then
                    roll_back "$code"
                else
                    return "$code"
                fi
            done
            ;;
        version) ./Smith version ;;
        help|--help|-h) ./Smith help hosted-agent ;;
        *) echo 'Usage: sh start-smith.sh agent|version|help [Smith arguments...]' >&2; return 2 ;;
    esac
}
main "$@"; exit $?
