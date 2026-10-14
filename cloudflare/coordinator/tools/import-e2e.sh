#!/bin/sh
# Runs tools/import-e2e.mjs with Node (usage at the top of that file).
exec node "$(dirname "$0")/import-e2e.mjs" "$@"
