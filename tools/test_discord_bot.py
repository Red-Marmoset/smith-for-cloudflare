#!/usr/bin/env python3
# test_discord_bot.py - offline unit tests for smith-discord-bot.py's discord-free
# helpers (Smith API client, auth allowlist, notification routing, intent dispatch).
# Runs without discord.py / requests / a token / a network:
#
#   python3 tools/test_discord_bot.py
import os, sys, json, types

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Inject a minimal fake `requests` so the bot imports without the real package. ---
class FakeResp:
    def __init__(self, status=200, body=b"", jsonobj=None, text=""):
        self.status_code = status; self.content = body; self._json = jsonobj; self.text = text
    def raise_for_status(self):
        if self.status_code >= 400: raise Exception("HTTP %d" % self.status_code)
    def json(self): return self._json

class FakeSession:
    def __init__(self): self.calls = []; self.next = {}
    def get(self, url, headers=None, timeout=None, **kw):
        self.calls.append(("GET", url, None)); return self.next.get(("GET", url), FakeResp(jsonobj=[]))
    def post(self, url, headers=None, data=None, timeout=None, **kw):
        self.calls.append(("POST", url, data)); return self.next.get(("POST", url), FakeResp(jsonobj={"jobId": "JID"}))

fake_requests = types.ModuleType("requests")
fake_requests.Session = FakeSession
fake_requests.get = lambda *a, **k: FakeResp()
fake_requests.exceptions = types.SimpleNamespace(RequestException=Exception)
sys.modules["requests"] = fake_requests

os.environ["SMITH_DISCORD_DRYRUN"] = "1"
sys.path.insert(0, HERE)
import importlib.util
spec = importlib.util.spec_from_file_location("smithbot", os.path.join(HERE, "smith-discord-bot.py"))
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)

passed = 0; failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1
    else: failed += 1; print("FAIL:", name)

# --- auth allowlist ---
cfg = bot.Config()
cfg.command_channels = ["100"]; cfg.allow_roles = {"7"}; cfg.allow_users = {"42"}
check("allowed by role in channel", bot.author_allowed(cfg, 100, [7, 9], 1))
check("allowed by user in channel", bot.author_allowed(cfg, 100, [9], 42))
check("denied wrong channel", not bot.author_allowed(cfg, 999, [7], 42))
check("denied no role/user", not bot.author_allowed(cfg, 100, [9], 1))
open_cfg = bot.Config(); open_cfg.command_channels = []; open_cfg.allow_roles = set(); open_cfg.allow_users = set()
check("open when no allowlist", bot.author_allowed(open_cfg, 5, [], 5))

# --- notification routing ---
ncfg = bot.Config()
ncfg.notify_start = True; ncfg.notify_running = False; ncfg.notify_success = True; ncfg.notify_fail = True
check("notify running (start on)", bot.want_notify(ncfg, {"type": "running"}))
check("notify failed", bot.want_notify(ncfg, {"type": "failed"}))
check("no notify queued", not bot.want_notify(ncfg, {"type": "queued"}))
check("batch notify on transitions only", bot.want_notify(ncfg, {"type": "batch", "status": "succeeded"})
      and bot.want_notify(ncfg, {"type": "batch", "status": "failed"})
      and not bot.want_notify(ncfg, {"type": "batch", "status": "building"}))
ncfg.notify_success = False
check("success suppressed", not bot.want_notify(ncfg, {"type": "success"}))
check("format_event has label+number", "build #12" in bot.format_event(
    {"type": "failed", "projectId": "soccer-boy", "product": "win", "buildNumber": 12, "errorCount": 2, "warningCount": 1}))

# --- build links ---
check("build_link no url -> plain text", bot.build_link("", "J", "x") == "x")
check("build_link no job -> plain text", bot.build_link("https://s.x", "", "x") == "x")
check("build_link markdown", bot.build_link("https://smith.example.com/", "J123", "build #4")
      == "[build #4](https://smith.example.com/#/build/J123)")
check("format_event links the build", "](https://s.x/#/build/JID)" in bot.format_event(
    {"type": "success", "projectId": "p", "buildNumber": 7, "jobId": "JID"}, "https://s.x"))

# --- SmithClient builds correct requests ---
sess = FakeSession()
sc = bot.SmithClient("http://x:9876/", token="tok", session=sess)
sc.trigger("soccer-boy", "win", "main")
m, url, data = sess.calls[-1]
body = json.loads(data)
check("trigger POST path", m == "POST" and url == "http://x:9876/api/trigger")
check("trigger body", body["projectId"] == "soccer-boy" and body["product"] == "win" and body["branch"] == "main")
check("trigger defaults clean off", body["clean"] is False)
sc.trigger("soccer-boy", "win", "main", clean=True)
check("trigger forwards clean", json.loads(sess.calls[-1][2])["clean"] is True)
sc.create_batch("soccer-boy", chain="steam-release", clean=True)
cb = json.loads(sess.calls[-1][2])
check("create_batch path + clean", sess.calls[-1][1] == "http://x:9876/api/batch" and cb["clean"] is True and cb["chain"] == "steam-release")
sc.cancel("J1")
check("cancel path", sess.calls[-1][1] == "http://x:9876/api/builds/J1/cancel")
sc.add_project("git@h:r.git", "dev")
check("add-project body", json.loads(sess.calls[-1][2])["url"] == "git@h:r.git")

# --- do_action dispatch (no discord) ---
class FakeSmith:
    def __init__(self): self.log = []
    def trigger(self, p, pr="", b="", reason="discord", clean=False): self.log.append(("trigger", p, pr, b, reason, clean)); return {"jobId": "JID"}
    def add_project(self, u, b=""): self.log.append(("add", u, b))
    def builds(self, p): return [{"jobId": "abcdef12", "buildNumber": 3, "status": "success",
                                  "nodeName": "RMS-ONE", "branch": "main", "commit": "624bbd66109f", "durationMs": 67000}]
    def cancel(self, j): self.log.append(("cancel", j))
    def diagnostics(self, j): return {"errorCount": 1}
    def log_text(self, j): return "boom"
    def log_tail(self, j): return "boom"
    def projects(self): return [{"id": "p", "name": "P"}]
    def autobuilds(self, p): return [{"product": "test", "branch": "main", "intervalSeconds": 300, "enabled": True}]
    def steam_guard(self, code, ref=""): self.log.append(("guard", code, ref)); return {"requestId": "R1", "node": "DRIPS"}
    def steam_guard_status(self, rid): return {"status": "done", "node": "DRIPS"}
    def create_batch(self, p, chain="", builds=None, then=None, branch="", clean=False):
        self.log.append(("batch", p, chain, builds, then, clean)); return {"batchId": "B1", "jobIds": ["a", "b", "c"]}
    def batches(self, p): return [{"name": "steam-release", "status": "deploying", "detail": "3/3 built - follow-up queued",
                                   "builds": [{"jobId": "a", "buildNumber": 5, "status": "success"}]}]
    def nodes(self): return [{"hostname": "RMS-ONE", "os": "windows", "online": True, "status": "idle", "labels": ["unity6"]},
                             {"hostname": "Ford", "os": "mac", "online": False, "status": "offline", "labels": []}]
class FakeLLM:
    def summarize_failure(self, d, t, excerpt=""): return "root cause: boom"
fs = FakeSmith(); fl = FakeLLM()
check("do trigger_build", "has been queued" in bot.do_action(fs, fl, "trigger_build", {"project": "p"}) and fs.log[-1][0] == "trigger")
check("do deploy reason", bot.do_action(fs, fl, "deploy", {"project": "p"}) and fs.log[-1][4] == "discord-deploy")
check("do explain_failure", "root cause" in bot.do_action(fs, fl, "explain_failure", {"jobId": "j"}))
check("do build_status", "success" in bot.do_action(fs, fl, "build_status", {"project": "p"}))
check("deploy is mutating", "deploy" in bot.MUTATING and "build_status" not in bot.MUTATING)
check("do trigger_build links", "](https://s.x/#/build/JID)" in bot.do_action(fs, fl, "trigger_build", {"project": "p"}, "https://s.x"))
agents_out = bot.do_action(fs, fl, "agents_status", {})
check("do agents_status counts online", "1/2 agents online" in agents_out and "RMS-ONE" in agents_out)
check("do running_builds quiet", "Nothing is building" in bot.do_action(fs, fl, "running_builds", {}))
check("no decorative emoji in replies", all(e not in (bot.do_action(fs, fl, "trigger_build", {"project": "p"})
      + bot.do_action(fs, fl, "deploy", {"project": "p"}) + bot.do_action(fs, fl, "add_project", {"url": "u"})
      + bot.do_action(fs, fl, "cancel_build", {"jobId": "j"})) for e in ("🚀", "➕", "🤔", "🔨", "🚫")))
pipe = bot.summarize_pipeline({
    "project": {"id": "soccer-boy", "description": "Unity 2D platformer"},
    "buildProducts": [{"name": "unity", "variants": [{"name": "Steam (Windows)"}],
                       "rules": [{"name": "build-profile", "branches": ["*"],
                                  "nodeSelector": {"labels": ["unity6"]},
                                  "handoff": [{"type": "collect"}]}]},
                      {"name": "steam-deploy",
                       "rules": [{"name": "publish-steam", "branches": ["main"],
                                  "nodeSelector": {"os": "windows", "labels": ["steamcmd"]},
                                  "handoff": [{"type": "steam"}]}]}],
    "triggers": [{"type": "manual"}]})
check("pipeline summary products", "unity" in pipe and "steam-deploy" in pipe)
check("pipeline summary needs", "windows, steamcmd" in pipe and "unity6" in pipe)
check("pipeline summary handoff+triggers", "handoff: steam" in pipe and "triggers: manual" in pipe)
check("pipeline summary variants", "Steam (Windows)" in pipe)
ab = bot.do_action(fs, fl, "autobuild_config", {"project": "p"})
check("autobuild summary", "test" in ab and "main" in ab and "300" in ab and "enabled" in ab)
check("resolve_job passes uuids through", bot.resolve_job(fs, "abcdef12-3456") == "abcdef12-3456")
check("resolve_job maps build number", bot.resolve_job(fs, "#3") == "abcdef12" and bot.resolve_job(fs, "3", "p") == "abcdef12")
check("resolve_job unknown number", bot.resolve_job(fs, "99") == "")
check("explain by build number", "root cause" in bot.do_action(fs, fl, "explain_failure", {"jobId": "3"}))
check("explain unknown number", "no build matches" in bot.do_action(fs, fl, "explain_failure", {"jobId": "99"}))
rc = bot.do_action(fs, fl, "run_chain", {"project": "p", "chain": "steam-release"})
check("run_chain queues batch", "B1" in rc and "3 builds" in rc and fs.log[-1][2] == "steam-release")
check("run_chain defaults clean off", fs.log[-1][5] is False)
bot.do_action(fs, fl, "trigger_build", {"project": "p", "clean": True})
check("trigger_build forwards clean", fs.log[-1][0] == "trigger" and fs.log[-1][5] is True)
bot.do_action(fs, fl, "run_chain", {"project": "p", "chain": "steam-release", "clean": True})
check("run_chain forwards clean", fs.log[-1][0] == "batch" and fs.log[-1][5] is True)
rb = bot.do_action(fs, fl, "run_batch", {"project": "p", "profiles": ["unity/Steam (Windows)"], "deploy": False})
check("run_batch explicit product", fs.log[-1][3] == [{"product": "unity", "profile": "Steam (Windows)"}])
bs = bot.do_action(fs, fl, "batch_status", {"project": "p"})
check("batch_status summarizes", "steam-release" in bs and "deploying" in bs and "3/3 built" in bs)
check("format_event batch", "batch steam-release — succeeded" in bot.format_event(
    {"type": "batch", "projectId": "p", "name": "steam-release", "status": "succeeded", "summary": "3/3 built"}))
sg = bot.do_action(fs, fl, "steam_guard", {"code": " ABC12 "})
check("steam_guard accepted", "accepted on **DRIPS**" in sg and fs.log[-1] == ("guard", "ABC12", ""))
check("steam_guard needs no confirm (codes expire)", "steam_guard" not in bot.MUTATING)
check("help lists slash commands", "/build" in bot.HELP_TEXT and "/agents" in bot.HELP_TEXT and "/help" in bot.HELP_TEXT)
info = bot.do_action(fs, fl, "build_info", {"project": "p", "buildNumber": 3}, "https://s.x")
check("build_info names the agent", "RMS-ONE" in info and "success" in info and "](https://s.x/#/build/abcdef12)" in info)
check("build_info unknown number", "no record exists" in bot.do_action(fs, fl, "build_info", {"project": "p", "buildNumber": 99}))
check("build_status shows node", "on RMS-ONE" in bot.do_action(fs, fl, "build_status", {"project": "p"}))
check("format_event stays terse (no node)", "DRIPS" not in bot.format_event(
    {"type": "failed", "projectId": "p", "buildNumber": 9, "node": "DRIPS"}))

# --- failure_excerpt: the cause buried mid-log must survive a noisy tail ---
unity_log = "\n".join(
    ["importing asset %d" % i for i in range(50)] +
    ["BuildFailedException: Build path contains a project previously built with the Mono2x scripting backend, the current setting is for IL2CPP",
     "Player build result: Failed"] +
    ["teardown line %d" % i for i in range(200)] +
    ["Exiting batchmode successfully now!"])
exc = bot.failure_excerpt(unity_log)
check("excerpt finds buried exception", "Mono2x scripting backend" in exc)
check("excerpt finds result line", "Player build result: Failed" in exc)
check("excerpt drops benign noise", "importing asset" not in exc and "teardown line" not in exc)
check("excerpt empty for clean log", bot.failure_excerpt("all fine\nnothing to see") == "")
big = bot.failure_excerpt("\n".join("ERROR: e%d" % i for i in range(500)), max_chars=1000)
check("excerpt respects cap", len(big) <= 1100 and "[...clipped...]" in big)
check("excerpt keeps head and tail", "e0" in big and "e499" in big)

# --- config health alerts ---
bad = {"ok": False, "state": "invalid-using-last-known-good", "severity": "error",
       "fileError": "parse error at line 60, column 17", "startupError": "parse error at line 60, column 17",
       "message": "smith-coordinator.json is invalid"}
st0 = {"key": "", "at": 0.0}
check("config ok stays quiet", bot.config_alert(st0, {"ok": True, "state": "ok"}, 100)[1] is None)
check("config unreachable stays quiet", bot.config_alert(st0, {}, 100)[1] is None)
st1, m1 = bot.config_alert(st0, bad, 100)
check("config invalid complains", m1 is not None and "invalid" in m1 and "smith-coordinator.json is invalid" in m1)
check("config same problem not repeated", bot.config_alert(st1, bad, 200)[1] is None)
check("config reminder after interval", bot.config_alert(st1, bad, 100 + bot.CONFIG_REMIND_SEC)[1] is not None)
moved = dict(bad, fileError="parse error at line 12, column 3")
check("config new problem announced", bot.config_alert(st1, moved, 200)[1] is not None)
warn = {"ok": False, "state": "restart-needed", "severity": "warn", "fileError": "", "startupError": "x", "message": "restart it"}
check("config restart-needed says restart", "restart" in bot.config_alert(st1, warn, 200)[1])
st2, m2 = bot.config_alert(st1, {"ok": True, "state": "ok"}, 300)
check("config fix announced once", m2 is not None and "healthy" in m2 and st2["key"] == "")
check("config fix not repeated", bot.config_alert(st2, {"ok": True}, 400)[1] is None)
sess = FakeSession(); sess.next[("GET", "http://c/api/config/status")] = FakeResp(body=b"{}", jsonobj={"ok": True})
check("client config_status path", bot.SmithClient("http://c", session=sess).config_status() == {"ok": True})

print("\nsmith-discord-bot tests: %d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
