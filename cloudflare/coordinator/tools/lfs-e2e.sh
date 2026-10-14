#!/bin/sh
# Runs tools/lfs-e2e.mjs with Node (usage at the top of that file).
exec node "$(dirname "$0")/lfs-e2e.mjs" "$@"
