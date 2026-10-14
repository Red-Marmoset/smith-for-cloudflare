"""A stand-in for Claude Code in the hosted runtime test's crew cases (see crew_runtime_cases.py).

The test copies this file beside a claude.cmd at the front of the agent's PATH, with stub-case.json
saying which case runs. It checks how Smith started it (argv, environment, working directory, stdin
and the control files it was pointed at), then prints the stream-json the agent reads. It cannot fail
the test itself: each failed check becomes a fail-*.txt marker that the test reports. Never contacts
a network host. Prints the run's two secrets into an assistant message on purpose, so the test can
show that Smith redacts them before relaying anything.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

CASE = json.loads((Path(__file__).resolve().parent / "stub-case.json").read_text())
MARKERS = Path(CASE["markers"])
SESSION = CASE["sessionId"]
API_KEY, RUN_TOKEN = CASE["apiKey"], CASE["runToken"]


def same(a, b):
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def emit(event):
    print(json.dumps(event), flush=True)


def option(args, name):
    """Every value given for `name` (--add-dir comes twice)."""
    return [args[i + 1] for i, arg in enumerate(args[:-1]) if arg == name]


def read_json(path, label, failures):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        failures.append(f"{label} at {path} is not readable JSON: {error}")
        return {}


def check_settings(path, input_dir, repo_dir, failures):
    deny = read_json(path, "--settings", failures).get("permissions", {}).get("deny", [])
    missing = [] if "Bash(*)" in deny else ["Bash(*)"]
    for tool in ("Edit", "Write"):
        paths = [m.group(1) for m in (re.fullmatch(re.escape(tool) + r"\((.*)/\*\*\)", rule) for rule in deny) if m]
        for label, target in (("the input dir", input_dir), ("the checkout's .git", os.path.join(repo_dir, ".git"))):
            if not any(not p.startswith("//") and same(p, target) for p in paths):
                missing.append(f"{tool} of {label}, native path")
            if not any(p.startswith("//") and "\\" not in p and same(p[2:], target) for p in paths):
                missing.append(f"{tool} of {label}, //-prefixed forward-slash path")
            # A drive path also comes as //c/..., the form Claude Code normalises Windows paths to before matching.
            drive = re.match(r"([A-Za-z]):[\\/]", target)
            if drive and ("//" + drive.group(1).lower() + target[2:].replace("\\", "/")) not in paths:
                missing.append(f"{tool} of {label}, //c/-style path")
    if missing:
        failures.append(f"settings.json denies no {'; no '.join(missing)}. Its deny list: {deny}")


def check_mcp(path, failures):
    text = Path(path).read_text() if Path(path).is_file() else ""
    server = read_json(path, "--mcp-config", failures).get("mcpServers", {}).get("smith", {})
    if server.get("url") != CASE["mcpUrl"]:
        failures.append(f"mcp.json names {server.get('url')!r}, not the fixture's {CASE['mcpUrl']}")
    if server.get("headers", {}).get("Authorization") != "Bearer ${SMITH_RUN_TOKEN}":
        failures.append("mcp.json does not take the run token from ${SMITH_RUN_TOKEN}")
    if RUN_TOKEN in text:
        failures.append("mcp.json holds the run token itself")


def checks(args, prompt):
    failures = []
    member = Path(CASE["workspace"]) / "ai" / "crew" / CASE["memberId"]
    run = member / "runs" / SESSION
    control = run / "control"
    for flag in ("-p", "--restricted", "--strict-mcp-config", "--verbose"):
        if flag not in args:
            failures.append(f"argv lacks {flag}")
    if "--bare" in args:
        failures.append("argv has --bare, which would skip the API key login Smith relies on")
    for name, expected in (("--output-format", "stream-json"), ("--permission-mode", CASE.get("permissionMode", "acceptEdits")), ("--permission-prompts", "none")):
        if option(args, name) != [expected]:
            failures.append(f"{name} is {option(args, name)}, not [{expected!r}]")
    schema = option(args, "--json-schema")
    try:
        if len(schema) != 1 or json.loads(schema[0]) != json.loads(CASE["schema"]):
            failures.append(f"--json-schema did not arrive intact as the claim's inline schema: {schema}")
    except ValueError:
        failures.append(f"--json-schema is not JSON after cmd.exe: {schema}")
    disallowed = (option(args, "--disallowedTools") or [""])[0].split(",")
    if not {"WebFetch", "WebSearch"} <= set(disallowed):
        failures.append(f"--disallowedTools does not name WebFetch and WebSearch: {disallowed}")
    add_dirs = option(args, "--add-dir")
    if len(add_dirs) != 2 or not same(add_dirs[0], run / "input") or not same(add_dirs[1], run / "new-project"):
        failures.append(f"--add-dir is {add_dirs}, not the run's input and new-project dirs")
    if not same(os.getcwd(), member / "repo"):
        failures.append(f"the CLI runs in {os.getcwd()}, not the member's checkout")
    settings, mcp = option(args, "--settings"), option(args, "--mcp-config")
    if len(settings) != 1 or not same(settings[0], control / "settings.json"):
        failures.append(f"--settings is {settings}, not the run's control/settings.json")
    else:
        check_settings(settings[0], str(run / "input"), str(member / "repo"), failures)
    if len(mcp) != 1 or not same(mcp[0], control / "mcp.json"):
        failures.append(f"--mcp-config is {mcp}, not the run's control/mcp.json")
    else:
        check_mcp(mcp[0], failures)
    if prompt != CASE["prompt"]:
        failures.append(f"stdin was {prompt!r}, not the claim's prompt")
    if os.environ.get("SMITH_RUN_TOKEN") != RUN_TOKEN:
        failures.append("SMITH_RUN_TOKEN is missing or is not the claim's run token")
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", "")
    if CASE["brain"] == "login":
        # The machine's own sign-in, as a chat runs it: the launcher's config dir and OAuth token arrive, no API key does.
        for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
            if name in os.environ:
                failures.append(f"{name} reached a login run, where it would replace the machine's sign-in")
        if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") != CASE["ownerOauthToken"]:
            failures.append("CLAUDE_CODE_OAUTH_TOKEN (the launcher's sign-in canary) did not reach the login run")
        if not same(config_dir or ".", CASE["ownerConfigDir"]):
            failures.append(f"CLAUDE_CONFIG_DIR is {config_dir!r}, not the launcher's {CASE['ownerConfigDir']}")
        return failures + common_checks(member)
    # The environment: the claim's key and the run token in, the machine owner's login out (values are never echoed).
    if os.environ.get("ANTHROPIC_API_KEY") != API_KEY:
        failures.append("ANTHROPIC_API_KEY is not the claim's key")
    if "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
        failures.append("CLAUDE_CODE_OAUTH_TOKEN (the launcher's canary) reached the CLI")
    allowed = {"ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"}
    inherited = sorted(name for name in os.environ if name.upper().startswith(("ANTHROPIC_", "CLAUDE_")) and name.upper() not in allowed)
    if inherited:
        failures.append(f"the launcher's {inherited} reached the CLI")
    if not config_dir or not same(config_dir, control / "claude-config") or not os.path.isdir(config_dir) or os.listdir(config_dir):
        failures.append(f"CLAUDE_CONFIG_DIR is {config_dir!r}, not the run's existing, empty control/claude-config")
    return failures + common_checks(member)


def common_checks(member):
    failures = []
    # The owner's global git config never applies to a crew clone: every process of the turn gets the member's own.
    git_config = os.environ.get("GIT_CONFIG_GLOBAL")
    if git_config is None:
        failures.append("GIT_CONFIG_GLOBAL is not set in the CLI's environment")
    elif not same(os.path.dirname(git_config), member / "control"):
        failures.append(f"GIT_CONFIG_GLOBAL is {git_config}, not under the member's control dir")
    # Every run starts from the project's tip in a reset, cleaned copy: nothing an earlier run wrote is left.
    present = sorted(name for name in os.listdir(".") if name != ".git")
    if present != CASE["baseFiles"]:
        failures.append(f"the checkout holds {present}, not just the project's files {CASE['baseFiles']}")
    return failures


def main():
    args = sys.argv[1:]
    if args == ["--version"]:   # the agent's tool inventory
        print("2.0.0 (Claude Code stand-in)", flush=True)
        return 0
    if args[:2] == ["auth", "status"]:   # the agent's sign-in probe (tool setup); never a run
        print('{"loggedIn": false}', flush=True)
        return 0
    (MARKERS / f"invoked-{SESSION}.txt").write_text(json.dumps(args))
    prompt = sys.stdin.read()
    for number, reason in enumerate(checks(args, prompt)):
        (MARKERS / f"fail-{SESSION}-{number}.txt").write_text(reason)
    emit({"type": "system", "subtype": "init", "session_id": "s1", "tools": ["Edit", "Read", "Write", "Glob", "Grep"]})
    case = CASE["case"]
    if case == "orchestration-reader":
        settings = json.loads(Path(option(args, "--settings")[0]).read_text())
        assert all(tool in settings["permissions"]["deny"] for tool in ["Edit", "Write", "NotebookEdit"])
        emit({"type": "result", "subtype": "success", "structured_output": {"summary": "Read pinned commit", "findings": []}})
    elif case == "orchestration-rename":
        Path("allowed").mkdir()
        Path("README.md").rename("allowed/README.md")
        emit({"type": "result", "subtype": "success", "structured_output": {"summary": "Moved a file", "findings": []}})
    elif case == "orchestration-junction":
        (MARKERS / "junction-canary.txt").write_text("keep")
        subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", "allowed", str(MARKERS)], check=True, capture_output=True)
        emit({"type": "result", "subtype": "success", "structured_output": {"summary": "Created junction", "findings": []}})
    elif case == "completed":
        Path("hello.txt").write_text("hello\n")
        emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": f"Checked {API_KEY} and {RUN_TOKEN}; adding hello.txt."}]}})
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.01,
              "structured_output": {"summary": "Added hello", "findings": [], "proposal": {"title": "Add hello", "summary": "adds a file"}}})
    elif case == "secret":
        Path("leak.txt").write_text(f"key={API_KEY}\n")
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.01, "structured_output": {"summary": "Wrote a file", "findings": []}})
    elif case == "login":
        emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": f"Signed in with {os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')}, token {RUN_TOKEN}."}]}})
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.03, "structured_output": {"summary": "Looked with the sign-in", "findings": []}})
    elif case == "gitlink":
        # A nested repository with a commit of its own: `git add -A` stages it as a gitlink, which Smith must not commit.
        git = [CASE["git"], "-c", "user.name=Nested", "-c", "user.email=nested@smith.invalid"]
        subprocess.run([*git, "init", "-q", "vendor"], check=True, capture_output=True)
        Path("vendor/lib.txt").write_text("nested\n")
        subprocess.run([*git, "-C", "vendor", "add", "lib.txt"], check=True, capture_output=True)
        subprocess.run([*git, "-C", "vendor", "commit", "-q", "-m", "nested"], check=True, capture_output=True)
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.01, "structured_output": {"summary": "Vendored a library", "findings": []}})
    elif case == "create-project":
        # A project for the crew in the writable new-project/ dir, and one holding a planted repository that Smith must not push.
        new_project = Path(option(args, "--add-dir")[1])
        (new_project / "tool-lib" / "src").mkdir(parents=True, exist_ok=True)
        (new_project / "tool-lib" / "README.md").write_text("# Tool lib\nShared log parsing.\n")
        (new_project / "tool-lib" / "src" / "parse.py").write_text("def parse(line):\n    return line.split()\n")
        (new_project / "planted" / ".git").mkdir(parents=True, exist_ok=True)
        (new_project / "planted" / "README.md").write_text("planted\n")
        (new_project / "planted" / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        settings = read_json(option(args, "--settings")[0], "--settings", [])
        if "mcp__smith__crew_create_project" not in settings.get("permissions", {}).get("allow", []):
            (MARKERS / f"fail-{SESSION}-allow.txt").write_text("settings.json does not allow crew_create_project for a member that may create projects")
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.01, "structured_output": {"summary": "Made a shared tool library", "findings": []}})
    elif case == "is-error":
        emit({"type": "result", "subtype": "error_during_execution", "is_error": True, "total_cost_usd": 0.002, "result": f"The API refused the key {API_KEY}"})
    elif case == "stop":
        Path("partial.txt").write_text("unfinished\n")
        (MARKERS / f"sleeping-{SESSION}.txt").write_text("sleeping")
        time.sleep(60)   # the test stops the turn long before this ends
        (MARKERS / f"survived-{SESSION}.txt").write_text("the stand-in was not killed by Stop")
        emit({"type": "result", "subtype": "success", "total_cost_usd": 0.01, "structured_output": {"summary": "Slept", "findings": []}})
    else:
        (MARKERS / f"fail-{SESSION}-case.txt").write_text(f"the CLI ran for case {case!r}, which must not start it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
