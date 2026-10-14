#!/usr/bin/env bash
# smith-notify-webhook.sh - example --notify-command for Slack / Discord / ntfy.
#
# Smith's own HTTP is plaintext-only (no TLS), so it doesn't post to HTTPS
# webhooks itself - instead the coordinator runs this command on every build it
# should notify about, with the build details in SMITH_* environment variables,
# and curl (which does HTTPS) delivers the message. Point Smith at it with:
#
#   smith coordinator --notify-command /path/to/smith-notify-webhook.sh
#   smith coordinator --notify-command "..." --notify-on all   # successes too
#
# Set ONE of the webhook env vars below (export it where the coordinator runs).
#   SMITH_SLACK_WEBHOOK   - https://hooks.slack.com/services/XXX/YYY/ZZZ
#   SMITH_DISCORD_WEBHOOK - https://discord.com/api/webhooks/XXX/YYY
#   SMITH_NTFY_TOPIC_URL  - https://ntfy.sh/your-topic   (plain POST body)
#
# Smith provides: SMITH_STATUS SMITH_PROJECT SMITH_PRODUCT SMITH_VARIANT
#   SMITH_BUILD_NUMBER SMITH_BRANCH SMITH_COMMIT SMITH_JOB_ID SMITH_NODE
#   SMITH_EXIT_CODE SMITH_FAILED
set -u

icon="✅"; [ "${SMITH_FAILED:-0}" = "1" ] && icon="❌"
text="$icon Smith: ${SMITH_PROJECT}/${SMITH_PRODUCT} #${SMITH_BUILD_NUMBER} ${SMITH_STATUS}"
text="$text (branch ${SMITH_BRANCH}${SMITH_VARIANT:+, ${SMITH_VARIANT}})"
[ -n "${SMITH_NODE:-}" ] && text="$text on ${SMITH_NODE}"
[ "${SMITH_FAILED:-0}" = "1" ] && text="$text — exit ${SMITH_EXIT_CODE}"

if [ -n "${SMITH_SLACK_WEBHOOK:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
        -d "$(printf '{"text":%s}' "$(printf '%s' "$text" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" \
        "$SMITH_SLACK_WEBHOOK" >/dev/null
fi
if [ -n "${SMITH_DISCORD_WEBHOOK:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
        -d "$(printf '{"content":%s}' "$(printf '%s' "$text" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" \
        "$SMITH_DISCORD_WEBHOOK" >/dev/null
fi
if [ -n "${SMITH_NTFY_TOPIC_URL:-}" ]; then
    curl -fsS -m 10 -d "$text" "$SMITH_NTFY_TOPIC_URL" >/dev/null
fi
exit 0
