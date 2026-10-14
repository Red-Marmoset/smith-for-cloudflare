# smith-notify-webhook.ps1 - example --notify-command for Slack / Discord / ntfy
# (Windows twin of smith-notify-webhook.sh).
#
# Smith's own HTTP is plaintext-only (no TLS), so it doesn't post to HTTPS
# webhooks itself - instead the coordinator runs this command on every build it
# should notify about, with the build details in SMITH_* environment variables,
# and curl (which does HTTPS) delivers the message. Point Smith at it with:
#
#   smith coordinator --notify-command "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\smith-notify-webhook.ps1"
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

$icon = if ($env:SMITH_FAILED -eq '1') { [char]0x274C } else { [char]0x2705 }   # cross mark / check mark
$text = "$icon Smith: $($env:SMITH_PROJECT)/$($env:SMITH_PRODUCT) #$($env:SMITH_BUILD_NUMBER) $($env:SMITH_STATUS)"
$text += " (branch $($env:SMITH_BRANCH)"
if ($env:SMITH_VARIANT) { $text += ", $($env:SMITH_VARIANT)" }
$text += ")"
if ($env:SMITH_NODE)            { $text += " on $($env:SMITH_NODE)" }
if ($env:SMITH_FAILED -eq '1')  { $text += " $([char]0x2014) exit $($env:SMITH_EXIT_CODE)" }

# curl.exe (built into Win10+) does the HTTPS POST; ConvertTo-Json handles the
# string escaping. Payload goes via a temp file so quoting survives cmd /c.
function Send-Json([string]$url, [string]$body)
{
    $tmp = [System.IO.Path]::GetTempFileName()
    try
    {
        [System.IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding $false))
        curl.exe -fsS -m 10 -X POST -H 'Content-Type: application/json' -d "@$tmp" $url | Out-Null
    }
    finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

if ($env:SMITH_SLACK_WEBHOOK)   { Send-Json $env:SMITH_SLACK_WEBHOOK   ('{"text":'    + (ConvertTo-Json $text) + '}') }
if ($env:SMITH_DISCORD_WEBHOOK) { Send-Json $env:SMITH_DISCORD_WEBHOOK ('{"content":' + (ConvertTo-Json $text) + '}') }
if ($env:SMITH_NTFY_TOPIC_URL)  { curl.exe -fsS -m 10 -d $text $env:SMITH_NTFY_TOPIC_URL | Out-Null }
exit 0
