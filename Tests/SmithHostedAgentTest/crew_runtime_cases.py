"""Crew cases of the hosted runtime test: the real agent runs crew turns end to end.

A crew turn is served from the fixture's fake coordinator. The project is a local bare repository
the fixture creates, served read-only over the fixture's HTTPS server with Git's dumb HTTP protocol
(the agent accepts only https, ssh and git@ project URLs; a crew message turn never pushes). A push
turn's Artifacts remote is mapped to a writable local bare repository by the member's own gitconfig
(url.<bare>.insteadOf), the one seam the push cases use. Claude Code is replaced by claude_stub.py
behind a claude.cmd at the front of the agent's PATH. Nothing here contacts a network host, runs the
real claude, or pushes anywhere but local bare repositories.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
API_KEY, RUN_TOKEN = "sk-ant-test", "smith_run_test"
OWNER_OAUTH = "owner-oauth-canary"   # the launcher's own sign-in: reaches only a login run, and is redacted there
MEMBER_ID = "0f6c2a4e-5b7d-4e3a-9c1f-2d8e6b4a7c90"
AUTHOR = "Standards (Smith crew) <crew-standards@smith.invalid>"
PROMPT = "# Crew run\nTidy the repository's conventions.\n"
BASE_FILES = ["README.md"]
# The coordinator's CREW_REPORT_SCHEMA_INLINE (crew-model.ts), minified the way JSON.stringify writes it.
SCHEMA = json.dumps({"type": "object", "properties": {
    "summary": {"type": "string"}, "findings": {"type": "array", "items": {"type": "object", "properties": {
        "severity": {"type": "string", "enum": ["low", "medium", "high"]}, "title": {"type": "string"}, "file": {"type": "string"},
        "line": {"type": "integer"}, "detail": {"type": "string"}}, "required": ["severity", "title", "detail"]}},
    "proposal": {"type": "object", "properties": {"title": {"type": "string"}, "summary": {"type": "string"}}, "required": ["title", "summary"]},
    "memory": {"type": "string"}, "skipped": {"type": "boolean"}}, "required": ["summary", "findings"]}, separators=(",", ":"))
# What ai-finish accepts from a crew message turn (sessions.ts); anything else is a 400 there.
FINISH_FIELDS = {"status", "message", "commit", "baseCommit", "costUsd", "files", "filesTotal", "filesTruncated", "report", "createdProjects"}
DISCARDED = "The changes could not be committed; the crew member's next run discards them."


class CrewFake:
    """The coordinator's /ai routes for crew turns, and the project's bare repository over dumb HTTP."""

    def __init__(self, root):
        self.root, self.lock = root, threading.Lock()
        self.queue, self.turns, self.errors, self.drain = [], {}, [], None

    def serve(self, claim, stop_when=None):
        with self.lock:
            turn = {"claim": claim, "batches": [], "nextSeq": claim["nextEventSeq"], "finish": None, "stopWhen": stop_when, "stopSent": None, "finishedAt": None}
            self.turns[claim["turnId"]] = turn
            self.queue.append(turn)
            return turn

    def post(self, route, payload):
        with self.lock:
            if route == "/ai/claims":
                if not self.queue:
                    return {"turn": None}, 200
                turn = self.queue.pop(0)
                turn["claimed"] = True
                return {"turn": turn["claim"]}, 200
            turn = self.turns.get(payload.get("turnId"))
            if turn is None or payload.get("leaseToken") != turn["claim"]["leaseToken"]:
                self.errors.append(f"{route} for an unknown turn or lease: {payload.get('turnId')}")
                return {"error": "stale_turn"}, 409
            if route == "/ai/events":
                if payload.get("seq") != turn["nextSeq"]:
                    self.errors.append(f"event batch seq {payload.get('seq')}, expected {turn['nextSeq']}")
                turn["batches"].append(payload)
                turn["nextSeq"] = payload.get("seq", 0) + len(payload.get("events", []))
                if turn["stopWhen"] and turn["stopSent"] is None and turn["stopWhen"]():
                    turn["stopSent"] = time.monotonic()
                return {"accepted": True, **({"stop": True} if turn["stopSent"] else {})}, 200
            if route == "/ai/finish":
                if turn["finish"] is not None and turn["finish"] != payload:
                    self.errors.append("a second, different ai-finish for the same turn")
                turn["finish"], turn["finishedAt"] = payload, time.monotonic()
                if self.drain and not self.queue and all(t["finish"] for t in self.turns.values()):
                    self.drain.write_text("drain")   # the agent exits once it is idle again
                return {"accepted": True}, 200
            self.errors.append(f"unexpected AI route {route}")
            return {"error": "not_found"}, 404

    def serve_git(self, handler):
        """GET of a file in the bare repository (dumb HTTP): info/refs, HEAD, objects. Nothing can be written."""
        if handler.path.endswith("/info/refs?service=git-upload-pack"):
            advertised = subprocess.run(["git", "upload-pack", "--stateless-rpc", "--advertise-refs", str(self.root / "project.git")], capture_output=True, check=True).stdout
            body = b"001e# service=git-upload-pack\n0000" + advertised
            handler.send_response(200); handler.send_header("Content-Type", "application/x-git-upload-pack-advertisement"); handler.send_header("Content-Length", str(len(body))); handler.end_headers(); handler.wfile.write(body)
            return
        path, prefix = handler.path.split("?", 1)[0], "/git/project.git/"
        bare = (self.root / "project.git").resolve()
        target = (bare / path[len(prefix):]).resolve() if path.startswith(prefix) else None
        body, status = b"", 404
        if target and target.is_relative_to(bare) and target.is_file():
            body, status = target.read_bytes(), 200
        handler.send_response(status)
        handler.send_header("Content-Type", "text/plain" if path.endswith("/info/refs") else "application/octet-stream")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)


class Crew:
    """One fixture run's crew side: the project, the stand-in CLI and the agent launches."""

    def __init__(self, fake, executable, origin, workspace_id, workspace, enrollment, env, cert, git_root, node_token):
        self.fake, self.executable, self.origin, self.workspace_id = fake, executable, origin, workspace_id
        self.workspace, self.enrollment, self.git_root, self.node_token = workspace, enrollment, git_root, node_token
        root = fake.root
        self.markers, self.standin, self.owner_config = root / "markers", root / "standin", root / "owner-claude-config"
        for directory in (root, self.markers, self.standin, self.owner_config):
            directory.mkdir(exist_ok=True)
        empty = root / "empty-gitconfig"
        empty.write_text("")
        # The fixture's own git: none of this machine's settings.
        self.git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(empty), "GIT_TERMINAL_PROMPT": "0"}
        self.clone = workspace / "ai" / "crew" / MEMBER_ID / "repo"
        self.base = self.make_project()
        self.url = origin + "/git/project.git"
        self.agent_env = self.make_agent_env(env, cert)

    def git(self, *args):
        result = subprocess.run([str(self.git_root / "cmd" / "git.exe"), *args], env=self.git_env, capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
        return result.stdout.strip()

    def make_project(self):
        bare, work = self.fake.root / "project.git", self.fake.root / "work"
        self.git("init", "-q", "--bare", "-b", "main", str(bare))
        self.git("init", "-q", "-b", "main", str(work))
        (work / "README.md").write_bytes(b"Fixture project for the crew runtime test.\n")
        self.git("-C", str(work), "add", "README.md")
        self.git("-C", str(work), "-c", "user.name=Fixture", "-c", "user.email=fixture@smith.invalid", "commit", "-q", "-m", "Initial commit")
        self.git("-C", str(work), "push", "-q", str(bare), "main:main")
        self.git("--git-dir", str(bare), "update-server-info")   # what dumb HTTP serves
        return self.git("--git-dir", str(bare), "rev-parse", "refs/heads/main")

    def bare_refs(self):
        return self.git("--git-dir", str(self.fake.root / "project.git"), "for-each-ref", "--format=%(refname) %(objectname)")

    def make_agent_env(self, env, cert):
        (self.standin / "claude.cmd").write_text(f'@echo off\n"{sys.executable}" "{self.standin / "claude_stub.py"}" %*\nexit /b %ERRORLEVEL%\n')
        (self.standin / "codex.cmd").write_text("@exit /b 1\n")   # the inventory finds no Codex, and never runs the real one
        shutil.copy2(HERE / "claude_stub.py", self.standin / "claude_stub.py")
        agent_env = {**env, "PATH": str(self.standin) + os.pathsep + env.get("PATH", ""),
                     # Canaries for the machine owner's own login, which must never reach the CLI.
                     "CLAUDE_CODE_OAUTH_TOKEN": OWNER_OAUTH, "ANTHROPIC_API_KEY": "sk-ant-owner-canary", "CLAUDE_CONFIG_DIR": str(self.owner_config),
                     # Git trusts the fixture's certificate, and never asks a credential manager.
                     "GIT_CONFIG_COUNT": "3", "GIT_CONFIG_KEY_0": "http.sslBackend", "GIT_CONFIG_VALUE_0": "openssl",
                     "GIT_CONFIG_KEY_1": "http.sslCAInfo", "GIT_CONFIG_VALUE_1": str(cert), "GIT_CONFIG_KEY_2": "credential.helper", "GIT_CONFIG_VALUE_2": ""}
        for tool in ("claude", "codex"):
            found = shutil.which(tool, path=agent_env["PATH"])
            assert found and Path(found).parent == self.standin, f"{tool} resolves to {found}, not the stand-in"
        return agent_env

    def claim(self, case, **overrides):
        session_id, turn_id = str(uuid.uuid4()), str(uuid.uuid4())
        claim = {"sessionId": session_id, "turnId": turn_id, "seq": 0, "leaseToken": "lease-" + turn_id, "leaseExpiresAt": int(time.time() * 1000) + 90_000,
                 "nextEventSeq": 0, "prompt": PROMPT, "tool": "claude-code", "brain": "api-key", "model": None, "permissionMode": "acceptEdits", "resume": None,
                 "kind": "message", "shared": False, "repo": {"url": self.url, "commit": self.base, "branch": "smith/crew-standards-" + turn_id[:8]},
                 "sessionKind": "crew", "systemPrompt": "You are Standards, a Smith crew member.", "schema": SCHEMA, "env": {"ANTHROPIC_API_KEY": API_KEY},
                 "mcp": {"url": self.origin + "/mcp", "token": RUN_TOKEN}, "memory": "", "inbox": [], "related": [], "skipIfCommit": None,
                 "budget": {"usdPerRun": 1, "maxMinutes": 5, "runsPerDay": 8, "buildsPerDay": 4}, "changesSince": None, "projectBranch": "main",
                 "member": {"id": MEMBER_ID, "slug": "standards", "name": "Standards", "permissionMode": "acceptEdits", "mayCreateProjects": False}}
        claim.update(overrides)
        (self.standin / "stub-case.json").write_text(json.dumps({
            "case": case, "sessionId": session_id, "memberId": MEMBER_ID, "workspace": str(self.workspace), "markers": str(self.markers),
            "mcpUrl": claim["mcp"]["url"], "prompt": PROMPT, "schema": SCHEMA, "apiKey": API_KEY, "runToken": RUN_TOKEN, "baseFiles": BASE_FILES,
            "permissionMode": ("plan" if claim.get("orchestration", {}).get("mode") == "read_only" else "default") if claim.get("orchestration") else "acceptEdits", "brain": claim["brain"], "ownerConfigDir": str(self.owner_config), "ownerOauthToken": OWNER_OAUTH, "git": str(self.git_root / "cmd" / "git.exe")}))
        return claim

    def run(self, claim, stop_when=None, timeout=90, secrets=()):
        """Serves `claim`, runs the agent until it drains after the turn's finish, and returns the turn's record."""
        turn = self.fake.serve(claim, stop_when)
        drain = self.fake.root / "drain"
        drain.unlink(missing_ok=True)
        self.fake.drain = drain
        argv = [str(self.executable), "hosted-agent", "--coordinator", self.origin, "--workspace-id", self.workspace_id, "--workspace", str(self.workspace),
                "--enrollment-file", str(self.enrollment), "--drain-file", str(drain)]
        process = subprocess.Popen(argv, cwd=self.git_root / "mingw64/bin", env=self.agent_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            output, _ = process.communicate()
            raise AssertionError(f"no crew finish and drain within {timeout}s (turn claimed: {turn.get('claimed', False)}, finished: {bool(turn['finish'])}); "
                                 f"status so far: {statuses(turn)}; markers: {self.marker_text()}\n{output}")
        assert process.returncode == 0 and "Drain requested" in output, output
        for secret in (self.node_token, API_KEY, RUN_TOKEN, *secrets):
            assert secret not in output, "a credential leaked into the agent's output"
        return turn

    def marker_text(self, session_id="", prefix=""):
        return {path.name: path.read_text() for path in sorted(self.markers.glob(f"{prefix}*{session_id}*"))}

    def finished(self, turn, cli_ran=True):
        """The turn's ai-finish result, after the checks every crew turn shares."""
        session_id = turn["claim"]["sessionId"]
        assert not self.fake.errors, self.fake.errors
        failures = self.marker_text(session_id, "fail-")
        assert not failures, "the stand-in claude found: " + "; ".join(failures.values())
        assert (self.markers / f"invoked-{session_id}.txt").exists() == cli_ran, f"the CLI {'did not run' if cli_ran else 'ran'}; status: {statuses(turn)}"
        assert turn["finish"], f"no ai-finish; status: {statuses(turn)}"
        relayed = json.dumps(turn["batches"]) + json.dumps(turn["finish"])
        for secret in (API_KEY, RUN_TOKEN):
            assert secret not in relayed, f"{secret} reached /ai/events or /ai/finish"
        result = turn["finish"]["result"]
        assert set(result) <= FINISH_FIELDS, f"ai-finish would refuse fields {set(result) - FINISH_FIELDS}"
        return result

    def show(self, *args):
        return self.git("-C", str(self.clone), *args)


def statuses(turn):
    return [event["data"] for batch in turn["batches"] for event in batch["events"] if event["kind"] == "status"]


def case_completed(crew):
    claim = crew.claim("completed")
    turn = crew.run(claim)
    result = crew.finished(turn)
    commit = result.get("commit")
    assert result["status"] == "completed", result
    assert isinstance(commit, str) and re.fullmatch("[0-9a-f]{40}", commit) and commit != crew.base, result
    assert result["baseCommit"] == crew.base and result["files"] == ["hello.txt"] and result["costUsd"] == 0.01, result
    assert result["filesTotal"] == 1 and result["filesTruncated"] is False, result   # the list is whole, so Verify may look at it
    assert result["report"]["summary"] == "Added hello" and result["message"] == "Claude Code finished", result
    # The assistant message carried both secrets: it was relayed, with each one redacted.
    assert any("[redacted]" in json.dumps(event) and "adding hello.txt" in json.dumps(event) for batch in turn["batches"] for event in batch["events"]), turn["batches"]
    assert "Preparing the crew member's copy of the project ..." in statuses(turn), statuses(turn)
    # The member's copy is a local clone of the machine's one shared store for the project: it hard-links that history
    # instead of holding a second copy of it (and origin still names the project, not the store).
    objects = lambda root: {(os.stat(path).st_dev, os.stat(path).st_ino) for path in root.rglob("*") if path.is_file()}
    stored = set().union(*(objects(store / "objects") for store in (crew.workspace / "repos").glob("*.git")))
    assert objects(crew.clone / ".git" / "objects") & stored, "the member's copy holds its own history instead of sharing the machine's store"
    assert crew.show("config", "--get", "remote.origin.url") == crew.url, crew.show("config", "--get", "remote.origin.url")
    author, subject = crew.show("show", "-s", "--format=%an <%ae>", commit), crew.show("show", "-s", "--format=%s", commit)
    assert author == AUTHOR and subject == "Smith crew standards: Add hello", (author, subject)
    files = crew.show("show", "--name-only", "--format=", commit).splitlines()
    assert files == ["hello.txt"] and not any(f.startswith(("input/", "control/")) for f in files), files
    assert crew.show("rev-parse", commit + "^") == crew.base and crew.show("rev-parse", "refs/heads/" + claim["repo"]["branch"]) == commit, "the commit is not on the run branch, on top of the base"
    assert crew.bare_refs() == f"refs/heads/main {crew.base}", crew.bare_refs()
    print("PASS: crew turn runs a stand-in claude restricted, redacts its secrets, and commits as the member")
    return claim["repo"]["branch"], commit


def case_skipped(crew, branch, commit):
    turn = crew.run(crew.claim("skip", skipIfCommit=crew.base))
    result = crew.finished(turn, cli_ran=False)
    assert result == {"status": "completed", "message": "skipped", "commit": None, "baseCommit": crew.base,
                      "report": {"summary": "No new commits", "findings": [], "skipped": True}}, result
    assert crew.show("rev-parse", "refs/heads/" + branch) == commit, "the member's persistent copy lost its last run"
    print("PASS: a second turn with no new commits is skipped without starting the CLI, and the member's copy stays")


def case_secret(crew, branch, commit):
    turn = crew.run(crew.claim("secret"))
    result = crew.finished(turn)
    assert result["status"] == "failed" and result["message"] == "the change contained a secret and was not committed", result
    assert result["commit"] is None and result["files"] == [] and result["baseCommit"] == crew.base, result
    assert crew.show("rev-parse", "HEAD") == crew.base and "leak.txt" not in crew.show("log", "--all", "--name-only", "--format="), "the secret was committed"
    assert crew.bare_refs() == f"refs/heads/main {crew.base}", crew.bare_refs()
    # The same clone, reset and cleaned: not cloned again (its earlier run's branch is still there).
    assert "Preparing the crew member's copy of the project ..." not in statuses(turn) and crew.show("rev-parse", "refs/heads/" + branch) == commit, "the member's copy was cloned again"
    print("PASS: a change holding the API key is refused, not committed, and reaches no repository")


def case_stopped(crew):
    claim = crew.claim("stop")
    sleeping = crew.markers / f"sleeping-{claim['sessionId']}.txt"
    turn = crew.run(claim, stop_when=sleeping.exists)
    result = crew.finished(turn)
    assert turn["stopSent"] is not None, f"the stand-in never reported sleeping, so the fake never sent Stop; status: {statuses(turn)}"
    assert result["status"] == "stopped" and result["message"] == "Stopped" and result["commit"] is None and result["files"] == [], result
    assert turn["finishedAt"] - turn["stopSent"] < 20, "Stop did not interrupt the CLI"
    assert not (crew.markers / f"survived-{claim['sessionId']}.txt").exists(), "the stand-in outlived Stop"
    assert DISCARDED in statuses(turn), statuses(turn)
    assert crew.show("rev-parse", "HEAD") == crew.base, "the stopped run committed"
    print("PASS: Stop during the CLI ends the run as stopped, and says its uncommitted changes are discarded")


def case_is_error(crew):
    turn = crew.run(crew.claim("is-error"))
    result = crew.finished(turn)
    assert result["status"] == "failed" and result["message"] == "Claude Code reported an error: The API refused the key [redacted]", result
    assert result["commit"] is None and result["costUsd"] == 0.002 and result["baseCommit"] == crew.base, result
    print("PASS: an is_error result with exit code 0 fails the run with its redacted message")


def case_gitlink(crew):
    runs = crew.workspace / "ai" / "crew" / MEMBER_ID / "runs"
    earlier = sorted(path.name for path in runs.iterdir())
    assert earlier, "the failed and stopped runs before this one left no run folders to clean up"
    claim = crew.claim("gitlink")
    turn = crew.run(claim)
    result = crew.finished(turn)
    assert result["status"] == "failed" and result["message"] == "the change contained a nested repository and was not committed", result
    assert result["commit"] is None and result["files"] == [], result
    assert crew.show("rev-parse", "HEAD") == crew.base, "the nested repository was committed"
    assert crew.bare_refs() == f"refs/heads/main {crew.base}", crew.bare_refs()
    # The turn removed the earlier runs' folders; its own (a failed run) stays until the member's next turn.
    assert sorted(path.name for path in runs.iterdir()) == [claim["sessionId"]], (earlier, sorted(path.name for path in runs.iterdir()))
    print("PASS: a change holding a nested repository (a gitlink) is refused, and a turn removes the folders of the member's earlier runs")
    return runs


def case_login(crew):
    turn = crew.run(crew.claim("login", brain="login", env={}))
    result = crew.finished(turn)
    assert result["status"] == "completed" and result["commit"] is None and result["report"]["summary"] == "Looked with the sign-in", result
    relayed = json.dumps(turn["batches"]) + json.dumps(turn["finish"])
    assert OWNER_OAUTH not in relayed, "the machine's sign-in token reached /ai/events or /ai/finish"
    assert any("[redacted]" in json.dumps(event) and "Signed in with" in json.dumps(event) for batch in turn["batches"] for event in batch["events"]), turn["batches"]
    assert any("this machine's Claude Code sign-in" in status for status in statuses(turn)), statuses(turn)
    print("PASS: a login crew turn keeps the machine's Claude Code sign-in and config dir, gets no API key, and redacts the sign-in token")


def case_created_project(crew):
    """A member that may create projects leaves new-project/tool-lib (and a folder holding a planted .git); the message turn's
    finish lists only tool-lib and keeps the run folder, and the push turn makes it the first commit on main of its own
    repository: a second local bare repository standing in for the Artifacts one. The member's gitconfig (which Smith creates
    empty and never rewrites) maps that Artifacts remote to the bare repository, the fixture's only seam; nothing else changes."""
    bare = crew.fake.root / "created.git"
    crew.git("init", "-q", "--bare", "-b", "main", str(bare))
    remote = "https://" + "0123456789abcdef" * 2 + ".artifacts.cloudflare.net/git/default/fixture-tool-lib.git"
    write_token = "art_v1_" + "0" * 28 + "wfixturetok?expires=9999999999"
    gitconfig = crew.workspace / "ai" / "crew" / MEMBER_ID / "control" / "gitconfig"
    gitconfig.write_text(f'[url "{bare.resolve().as_uri()}"]\n\tinsteadOf = {remote}\n')
    member = {"id": MEMBER_ID, "slug": "standards", "name": "Standards", "permissionMode": "acceptEdits", "mayCreateProjects": True}
    claim = crew.claim("create-project", member=member)
    runs = crew.workspace / "ai" / "crew" / MEMBER_ID / "runs"
    turn = crew.run(claim)
    result = crew.finished(turn)
    assert result["status"] == "completed" and result["commit"] is None and result["createdProjects"] == [{"id": "tool-lib"}], result
    assert any("new-project/planted" in status for status in statuses(turn)), statuses(turn)
    assert (runs / claim["sessionId"] / "new-project" / "tool-lib" / "README.md").is_file(), "the run folder went before its push turn"
    # The push turn Smith queues: no branch to push (the run changed nothing in the project), the created projects with their tokens.
    turn_id = str(uuid.uuid4())
    push = {"sessionId": claim["sessionId"], "turnId": turn_id, "seq": 1, "leaseToken": "lease-" + turn_id, "leaseExpiresAt": int(time.time() * 1000) + 90_000,
            "nextEventSeq": 0, "prompt": "Push branch " + claim["repo"]["branch"], "tool": "claude-code", "brain": "api-key", "model": None, "permissionMode": "", "resume": "s1",
            "kind": "push", "shared": False, "useApiKey": False, "repo": {"url": crew.url, "commit": crew.base, "branch": claim["repo"]["branch"]}, "sessionKind": "crew",
            "member": {"id": MEMBER_ID}, "pushBranch": False, "author": {"name": "Standards", "slug": "standards"},
            "createdProjects": [{"id": "tool-lib", "remote": remote, "authToken": write_token}, {"id": "planted", "remote": remote, "authToken": write_token}]}
    pushed = crew.run(push, secrets=(write_token, write_token.split("?")[0]))
    result = crew.finished(pushed)
    head = crew.git("--git-dir", str(bare), "rev-parse", "refs/heads/main")
    assert result["status"] == "completed" and result["commit"] is None and result["createdProjects"] == [{"id": "tool-lib", "commit": head}], result
    assert write_token.split("?")[0] not in json.dumps(pushed["batches"]) + json.dumps(pushed["finish"]), "the write token reached /ai/events or /ai/finish"
    files = crew.git("--git-dir", str(bare), "ls-tree", "-r", "--name-only", "main").splitlines()
    author = crew.git("--git-dir", str(bare), "log", "-1", "--format=%an <%ae>", "main")
    assert files == ["README.md", "src/parse.py"] and author == AUTHOR, (files, author)
    assert crew.git("--git-dir", str(bare), "rev-list", "--count", "main") == "1", "the new project's first push is more than one commit"
    assert any("new-project/planted" in status for status in statuses(pushed)), statuses(pushed)
    assert not (runs / claim["sessionId"]).exists(), "the push turn left the run folder behind"
    assert crew.bare_refs() == f"refs/heads/main {crew.base}", crew.bare_refs()   # the member's own project is untouched
    gitconfig.write_text("")
    print("PASS: a created project's folder is listed at the run's end and pushed by the push turn as its first commit; a planted .git is refused")


def case_branch_push(crew, branch, commit):
    """The push turn Smith queues for a run that committed pushes the run's branch, and only it, to the project's Artifacts copy:
    here a writable local bare repository (a copy of the project) that the member's gitconfig maps that Artifacts remote to, the
    same seam case_created_project uses, so the agent runs unchanged and nothing leaves the machine. A second push of the same
    branch over a head that moved elsewhere is refused (never forced), and main is never touched."""
    copy = crew.fake.root / "artifacts-copy.git"
    crew.git("clone", "-q", "--bare", str(crew.fake.root / "project.git"), str(copy))
    remote = "https://" + "fedcba9876543210" * 2 + ".artifacts.cloudflare.net/git/default/fixture-project.git"
    token = "art_v1_" + "0" * 28 + "wbranchtok?expires=9999999999"
    gitconfig = crew.workspace / "ai" / "crew" / MEMBER_ID / "control" / "gitconfig"
    gitconfig.write_text(f'[url "{copy.resolve().as_uri()}"]\n\tinsteadOf = {remote}\n')
    refs = lambda: crew.git("--git-dir", str(copy), "for-each-ref", "--format=%(refname) %(objectname)").splitlines()
    assert refs() == [f"refs/heads/main {crew.base}"], refs()
    session_id = str(uuid.uuid4())

    def push_claim():
        turn_id = str(uuid.uuid4())
        return {"sessionId": session_id, "turnId": turn_id, "seq": 1, "leaseToken": "lease-" + turn_id, "leaseExpiresAt": int(time.time() * 1000) + 90_000,
                "nextEventSeq": 0, "prompt": "Push branch " + branch, "tool": "claude-code", "brain": "api-key", "model": None, "permissionMode": "", "resume": None,
                "kind": "push", "shared": False, "useApiKey": False, "repo": {"url": remote, "commit": crew.base, "branch": branch, "authToken": token},
                "sessionKind": "crew", "member": {"id": MEMBER_ID}, "pushBranch": True}

    pushed = crew.run(push_claim(), secrets=(token, token.split("?")[0]))
    result = crew.finished(pushed, cli_ran=False)
    assert result["status"] == "completed" and result["commit"] == commit, result
    assert token.split("?")[0] not in json.dumps(pushed["batches"]) + json.dumps(pushed["finish"]), "the push token reached /ai/events or /ai/finish"
    # Only the run's smith/crew-* branch arrived; main is where it was.
    assert sorted(refs()) == sorted([f"refs/heads/main {crew.base}", f"refs/heads/{branch} {commit}"]), refs()
    assert all(line.split()[0] in ("refs/heads/main",) or line.split()[0].startswith("refs/heads/smith/crew-") for line in refs()), refs()

    # The copy's branch moved elsewhere meanwhile: the push is not a fast-forward, so git refuses it and the turn fails.
    tree = crew.git("--git-dir", str(copy), "rev-parse", crew.base + "^{tree}")
    elsewhere = crew.git("--git-dir", str(copy), "-c", "user.name=Fixture", "-c", "user.email=fixture@smith.invalid", "commit-tree", tree, "-p", crew.base, "-m", "Moved elsewhere")
    crew.git("--git-dir", str(copy), "update-ref", f"refs/heads/{branch}", elsewhere)
    refused = crew.run(push_claim(), secrets=(token, token.split("?")[0]))
    result = crew.finished(refused, cli_ran=False)
    assert result["status"] == "failed" and result["commit"] is None and result["message"].startswith("git push failed"), result
    assert sorted(refs()) == sorted([f"refs/heads/main {crew.base}", f"refs/heads/{branch} {elsewhere}"]), refs()
    gitconfig.write_text("")
    print("PASS: a crew push turn pushes only the run's smith/crew-* branch to the Artifacts copy, never main, and a non-fast-forward push is refused")


def run(crew):
    branch, commit = case_completed(crew)
    case_skipped(crew, branch, commit)
    case_secret(crew, branch, commit)
    case_stopped(crew)
    case_is_error(crew)   # its stand-in also checks the stopped run's partial.txt is gone
    runs = case_gitlink(crew)
    case_login(crew)      # its stand-in also checks the gitlink run's vendor/ is gone, and every stand-in that GIT_CONFIG_GLOBAL is the member's
    case_created_project(crew)
    case_orchestration(crew)
    case_branch_push(crew, branch, commit)   # the run branch case_completed committed, still in the member's copy
    assert not any(runs.iterdir()), f"a completed turn left run folders: {sorted(path.name for path in runs.iterdir())}"


def case_orchestration(crew):
    source = crew.fake.root / "work"
    (source / "advanced.txt").write_text("The remote branch moved after admission.\n")
    crew.git("-C", str(source), "add", ".")
    crew.git("-C", str(source), "-c", "user.name=Fixture", "-c", "user.email=fixture@smith.invalid", "commit", "--author=Codex <codex@example.com>", "-qm", "Advance fixture branch")
    crew.git("-C", str(source), "push", "-q", str(crew.fake.root / "project.git"), "main")
    def pinned(mode="read_only", scopes=None):
        return {"version": 1, "eventId": str(uuid.uuid4()), "baseCommit": crew.base, "headCommit": crew.base,
                "mode": mode, "writeScopes": scopes or [], "lease": None if mode == "read_only" else
                {"id": str(uuid.uuid4()), "generation": 1, "expiresAt": int(time.time()*1000)+300000}}
    claim = crew.claim("orchestration-reader", permissionMode="plan", orchestration=pinned(), skipIfCommit=crew.base)
    result = crew.finished(crew.run(claim))
    assert result["status"] == "completed" and result["commit"] is None and result["baseCommit"] == crew.base, result
    assert crew.show("rev-parse", "HEAD") == crew.base
    for mode, scopes in [("read_only", []), ("write", ["allowed/"])]:
        claim = crew.claim("completed", permissionMode="plan" if mode == "read_only" else "acceptEdits", orchestration=pinned(mode, scopes))
        result = crew.finished(crew.run(claim))
        assert result["status"] == "failed" and result["commit"] is None and "scope" in result["message"], result
        assert crew.show("rev-parse", "HEAD") == crew.base
    for case, message in [("orchestration-rename", "scope"), ("orchestration-junction", "junction")]:
        claim = crew.claim(case, orchestration=pinned("write", ["allowed/"]))
        result = crew.finished(crew.run(claim))
        assert result["status"] == "failed" and result["commit"] is None and message in result["message"], result
        assert crew.show("rev-parse", "HEAD") == crew.base
    claim = crew.claim("completed", orchestration=pinned("write", [""]))
    result = crew.finished(crew.run(claim))
    assert result["status"] == "completed" and result["commit"] and result["files"] == ["hello.txt"], result
    assert (crew.markers / "junction-canary.txt").read_text() == "keep", "cleanup followed a junction"
    for corrupt in ["missing", "expired", "reader-push"]:
        claim = crew.claim("no-cli", permissionMode="plan", orchestration=pinned())
        if corrupt == "missing": claim["orchestration"]["headCommit"] = "f" * 40
        elif corrupt == "reader-push": claim["kind"] = "push"
        else:
            claim["permissionMode"] = "acceptEdits"
            claim["orchestration"] = pinned("write", [""])
            claim["orchestration"]["lease"]["expiresAt"] = 1
        result = crew.finished(crew.run(claim), cli_ran=False)
        assert result["status"] == "failed" and result["commit"] is None, result
    crew.git("-C", str(source), "reset", "--hard", crew.base)
    crew.git("-C", str(source), "push", "--force", "-q", str(crew.fake.root / "project.git"), "main")
    print("PASS: pinned crew ignores moving tips; readers cannot edit/push; writer scopes and expired/missing claims fail closed")
