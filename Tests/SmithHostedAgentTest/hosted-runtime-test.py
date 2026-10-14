"""Exercise the actual Windows hosted-agent binary through a disposable TLS fixture.

Requires Python, Git for Windows (curl/OpenSSL), and a built Smith binary.
This starts no Smith coordinator and touches no production identity or services.
Run: python Tests/SmithHostedAgentTest/hosted-runtime-test.py [--crew-only]
(the crew turns are in crew_runtime_cases.py; --crew-only runs just those)
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time

import crew_runtime_cases

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / "Build/Smith/Release/Smith.exe"
GIT = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git"
WORKSPACE_ID = "a" * 64
TOKEN = "smn.fixture-node.fixture-token-for-test-only"


def main():
    if os.name != "nt":
        raise SystemExit("This runtime fixture tests the Windows hosted agent")
    with tempfile.TemporaryDirectory(prefix="smith-hosted-runtime-") as directory:
        base = Path(directory)
        acl_script = "$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl('" + str(base).replace("'", "''") + "',$acl)"
        subprocess.run(["powershell.exe", "-NoProfile", "-Command", acl_script], check=True)
        release = base / "release"
        release.mkdir()
        executable = release / "Smith.exe"
        shutil.copy2(BINARY, executable)
        cert, key = base / "cert.pem", base / "key.pem"
        subprocess.run([str(GIT / "usr/bin/openssl.exe"), "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        shared = {"enrollments": 0, "assignment": None, "completions": [], "logs": [], "seq": 0}
        crew = crew_runtime_cases.CrewFake(base / "crew")

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                crew.serve_git(self)

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                if self.path == "/git/project.git/git-upload-pack":
                    body = subprocess.run(["git", "upload-pack", "--stateless-rpc", str(crew.root / "project.git")], input=raw, capture_output=True, check=False).stdout
                    self.send_response(200); self.send_header("Content-Type", "application/x-git-upload-pack-result"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
                    return
                payload = json.loads(raw) if self.headers.get("Content-Type") == "application/json" else {}
                route = self.path.removeprefix(f"/api/v2/workspaces/{WORKSPACE_ID}")
                response, status = {}, 200
                if route == "/nodes/enroll":
                    assert payload["code"] == "fixture-enrollment-code"
                    assert payload["protocolVersion"] == 2
                    shared["enrollments"] += 1
                    response = {"nodeId": "fixture-node", "token": TOKEN, "protocolVersion": 2}
                    status = 201
                else:
                    assert self.headers.get("Authorization") == f"Bearer {TOKEN}"
                    if route == "/heartbeat":
                        shared["agentVersion"] = payload["agentVersion"]
                        response = {"accepted": True}
                    elif route == "/claims":
                        shared["claims"] = shared.get("claims", 0) + 1
                        response = shared["assignment"] or {"hasJob": False}
                    elif route.startswith("/ai/"):
                        # Agents poll for chat alongside builds; only the crew cases serve a turn.
                        response, status = crew.post(route, payload)
                    elif route == "/renew":
                        shared["renewals"] = shared.get("renewals", 0) + 1
                        cancelled = bool(shared.get("upload_active") and shared.get("cancel_during_upload"))
                        if cancelled:
                            shared["cancel_seen"] = True
                        response = {"leaseExpiresAt": int(time.time() * 1000) + 90_000, "cancelled": cancelled}
                    elif route == "/logs":
                        assert payload["seq"] == shared["seq"]
                        assert len(json.dumps(payload["lines"]).encode()) < 16_384
                        shared["logs"].extend(payload["lines"])
                        if "drain-test" in payload["lines"] and shared.get("drain_path"):
                            shared["drain_path"].write_text("drain")
                        shared["seq"] += 1
                        response = {"accepted": True, "nextSeq": shared["seq"]}
                    elif route == "/artifacts":
                        assert self.headers.get("Content-Type") == "application/octet-stream"
                        assert self.headers["X-Smith-Job-Id"] == "fixture-job"
                        assert self.headers["X-Smith-Attempt-Id"] == "fixture-attempt"
                        assert self.headers["X-Smith-Lease-Token"] == "fixture-lease"
                        assert self.headers["X-Smith-SHA256"] == hashlib.sha256(raw).hexdigest()
                        shared.setdefault("uploads", []).append((self.headers["X-Smith-Artifact-Name"], raw))
                        delay = shared.get("upload_delay", 0)
                        cancel_upload = shared.get("cancel_during_upload", False)
                        if delay:
                            shared["upload_active"] = True
                            time.sleep(delay)
                        if cancel_upload:
                            response, status = {"error": "cancelled"}, 409
                        elif shared.get("reject_upload"):
                            response, status = {"error": "forbidden"}, 403
                        elif shared.get("drop_upload"):
                            shared["drop_upload"] = False
                            self.close_connection = True
                            self.connection.close()
                            return
                        else:
                            response = {"accepted": True, "name": self.headers["X-Smith-Artifact-Name"], "sha256": hashlib.sha256(raw).hexdigest()}
                    elif route == "/complete":
                        if shared.get("drop_completion"):
                            shared["drop_completion"] = False
                            time.sleep(1)
                            self.close_connection = True
                            self.connection.close()
                            return
                        shared["completions"].append(payload)
                        shared["assignment"] = None
                        response = {"accepted": True}
                    else:
                        raise AssertionError(route)
                body = json.dumps(response).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLEOFError):
                    pass  # Cancellation intentionally terminates an in-flight upload.

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"https://localhost:{server.server_port}"
        # Some hosts (Claude Code among them) set NoDefaultCurrentDirectoryInExePath, which stops
        # CreateProcess searching the agent's current directory, so it would run System32's Schannel curl.
        env = {k: v for k, v in os.environ.items() if k.upper() != "NODEFAULTCURRENTDIRECTORYINEXEPATH"}
        env["CURL_CA_BUNDLE"] = str(cert)
        env["CURL_SSL_BACKEND"] = "openssl"
        env["SMITH_AUTO_UPDATE_TOOLS"] = "0"   # as RunTests does: the agent's tool maintenance never updates this machine
        enrollment = base / "enrollment"
        enrollment.write_text("fixture-enrollment-code")
        workspace = base / "workspace"
        argv = [str(executable), "hosted-agent", "--coordinator", origin, "--workspace-id", WORKSPACE_ID, "--workspace", str(workspace), "--enrollment-file", str(enrollment), "--once"]

        def launch(wait=True, trusted=True):
            process_env = env.copy()
            if not trusted:
                process_env.pop("CURL_CA_BUNDLE", None)
            # CreateProcess searches the current directory before System32. Use Git's
            # OpenSSL curl with a fixture CA; production uses normal verified TLS.
            process = subprocess.Popen(argv, cwd=GIT / "mingw64/bin", env=process_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if not wait:
                return process
            output, _ = process.communicate(timeout=90)
            assert TOKEN not in output, "credential leaked into process output"
            return process.returncode, output

        def assignment(command):
            shared["logs"], shared["seq"] = [], 0
            lease = {"jobId": "fixture-job", "attemptId": "fixture-attempt", "leaseToken": "fixture-lease", "nodeId": "fixture-node", "leaseExpiresAt": int(time.time() * 1000) + 90_000}
            spec = {"jobId": "fixture-job", "projectId": "fixture", "buildNumber": 1, "repos": [], "command": command, "steps": [], "workingDir": ".", "env": {}, "timeoutSeconds": 30, "successExitCodes": [0], "artifacts": {"globs": [], "exclude": [], "excludeDefaults": True, "package": "none", "archiveName": ""}, "handoff": [], "inputs": [], "clean": False}
            shared["assignment"] = {"hasJob": True, "envelope": {"protocolVersion": 2, "workspaceId": WORKSPACE_ID, "lease": lease, "spec": spec}}

        def crew_cases():
            crew_runtime_cases.run(crew_runtime_cases.Crew(crew, executable, origin, WORKSPACE_ID, workspace, enrollment, env, cert, GIT, TOKEN))

        try:
            if "--lease-expiry-only" in sys.argv[1:]:
                fixture = crew_runtime_cases.Crew(crew, executable, origin, WORKSPACE_ID, workspace, enrollment, env, cert, GIT, TOKEN)
                claim = fixture.claim("stop", orchestration={"version":1,"eventId":"expiry-fixture","baseCommit":fixture.base,"headCommit":fixture.base,
                    "mode":"write","writeScopes":[""],"lease":{"id":"expiry-lease","generation":1,"expiresAt":int(time.time()*1000)+20000}})
                started = time.monotonic()
                result = fixture.finished(fixture.run(claim))
                assert result["status"] == "failed" and result["commit"] is None and time.monotonic()-started < 35, result
                assert not (fixture.markers / f"survived-{claim['sessionId']}.txt").exists()
                print("PASS: writer CLI terminated at lease expiry without commit")
                return
            if "--orchestration-only" in sys.argv[1:]:
                fixture = crew_runtime_cases.Crew(crew, executable, origin, WORKSPACE_ID, workspace, enrollment, env, cert, GIT, TOKEN)
                crew_runtime_cases.case_orchestration(fixture)
                return
            if "--metadata-only" in sys.argv[1:]:
                fixture = crew_runtime_cases.Crew(crew, executable, origin, WORKSPACE_ID, workspace, enrollment, env, cert, GIT, TOKEN)
                env["GIT_SSL_CAINFO"] = str(cert)
                fixture.git("-C", str(crew.root / "project.git"), "config", "uploadpack.allowReachableSHA1InWant", "true")
                source = crew.root / "work"
                fixture.git("-C", str(source), "mv", "README.md", "renamed.md")
                (source / "CLAUDE.md").write_text("Untrusted repository instructions must only be read as metadata.\n")
                fixture.git("-C", str(source), "add", ".")
                fixture.git("-C", str(source), "-c", "user.name=Fixture", "-c", "user.email=fixture@smith.invalid", "commit", "--author=Codex <codex@example.com>", "-qm", "Metadata rename fixture")
                head = fixture.git("-C", str(source), "rev-parse", "HEAD")
                fixture.git("-C", str(source), "push", "-q", str(crew.root / "project.git"), "main")
                assignment({})
                spec = shared["assignment"]["envelope"]["spec"]
                spec.update(kind="checkin", repos=[{"url": fixture.url, "commit": head, "checkoutDir": "repo"}],
                            checkIn={"eventId": "event-fixture", "baseCommit": fixture.base, "headCommit": head})
                rc, output = launch()
                assert rc == 0, output
                result = shared["completions"][-1]["result"]["checkIn"]
                assert result["complete"] and result["ancestor"] and result["headCommit"] == head, result
                assert {item["path"] for item in result["changes"]} == {"CLAUDE.md", "renamed.md"}, result
                assert next(item for item in result["changes"] if item["path"] == "renamed.md")["oldPath"] == "README.md", result
                assert not list(fixture.markers.glob("invoked-*")), "metadata started the AI CLI"
                assignment({})
                spec = shared["assignment"]["envelope"]["spec"]
                spec.update(kind="checkin", repos=[{"url": fixture.url, "commit": "f"*40, "checkoutDir": "repo"}],
                            checkIn={"eventId": "event-missing", "baseCommit": fixture.base, "headCommit": "f"*40})
                rc, output = launch()
                assert rc != 0 and shared["completions"][-1]["result"]["status"] == "error", output
                print("PASS: metadata-only exact commits, no CLI or checkout scripts, missing commit fails")
                return
            if "--crew-only" in sys.argv[1:]:
                crew_cases()
                return
            rc, output = launch(trusted=False)
            assert rc != 0 and shared["enrollments"] == 0 and "Enrollment failed" in output, output
            print("PASS: TLS rejects an untrusted certificate")
            assignment({"interpreter": "exe", "script": "cmd.exe", "args": ["/d", "/c", "echo native-runtime-output"]})
            rc, output = launch()
            assert rc == 0, output
            assert shared["completions"][-1]["result"]["status"] == "success"
            assert "native-runtime-output" in shared["logs"], shared["logs"]
            print("PASS: real HTTPS enrollment, native command, streamed logs, completion")
            # Simulate a crash after the server accepted completion but before the
            # agent cleared its saved result. Recovery must resend the same result.
            state_file = workspace / "hosted-state.json"
            state = json.loads(state_file.read_text())
            completed = shared["completions"][-1]
            state["pending"] = {"lease": {k: v for k, v in completed.items() if k != "result"}, "result": completed["result"]}
            state_file.write_text(json.dumps(state))
            rc, output = launch()
            assert rc == 0, output
            assert shared["completions"][-1] == completed
            assert shared["enrollments"] == 1
            print("PASS: saved completion is replayed without re-enrollment or execution")
            # One-paste setup: the connect code carries the workspace ID, so no --workspace-id is needed,
            # and --enroll-only connects and exits without claiming work.
            connect = base / "connect"
            connect_workspace = base / "connect-workspace"
            connect_argv = [str(executable), "hosted-agent", "--coordinator", origin, "--workspace", str(connect_workspace), "--enrollment-file", str(connect), "--enroll-only"]
            def run_connect():
                process = subprocess.run(connect_argv, cwd=GIT / "mingw64/bin", env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=90)
                assert TOKEN not in process.stdout, "credential leaked into process output"
                return process.returncode, process.stdout
            connect.write_text("fixture-enrollment-code\n")
            rc, output = run_connect()
            assert rc != 0 and "only the enrollment code" in output and shared["enrollments"] == 1, output
            connect.write_text(f"  {WORKSPACE_ID}:fixture-enrollment-code\n")
            rc, output = run_connect()
            assert rc == 0 and "Connected" in output and shared["enrollments"] == 2, output
            assert json.loads((connect_workspace / "hosted-state.json").read_text())["workspaceId"] == WORKSPACE_ID
            rc, output = run_connect()
            assert rc == 0 and "already connected" in output and shared["enrollments"] == 2, output
            print("PASS: a connect code enrolls without --workspace-id; --enroll-only exits and is idempotent")
            shared["uploads"], shared["drop_upload"] = [], True
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", "[IO.File]::WriteAllBytes('release.bin',[byte[]](0,1,2,255))"]})
            shared["assignment"]["envelope"]["spec"]["artifacts"]["globs"] = ["release.bin"]
            rc, output = launch()
            assert rc == 0, output
            assert shared["completions"][-1]["result"]["status"] == "success"
            assert shared["uploads"] == [("release.bin", bytes([0, 1, 2, 255]))] * 2, shared["uploads"]
            print("PASS: artifact bytes and SHA256 survive a lost response and immutable retry")
            shared["reject_upload"] = True
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", "[IO.File]::WriteAllText('denied.bin','test')"]})
            shared["assignment"]["envelope"]["spec"]["artifacts"]["globs"] = ["denied.bin"]
            rc, output = launch()
            assert rc != 0 and shared["completions"][-1]["result"]["status"] == "error", output
            shared["reject_upload"] = False
            print("PASS: rejected artifact upload prevents successful completion")
            marker = base / "executions.txt"
            script = f"Add-Content -LiteralPath '{marker}' -Value started; Write-Output running; Start-Sleep -Seconds 15; Add-Content -LiteralPath '{marker}' -Value survived"
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", script]})
            process = launch(wait=False)
            deadline = time.monotonic() + 40
            while "running" not in shared["logs"] and time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(process.communicate()[0])
                time.sleep(.1)
            assert "running" in shared["logs"], "long command did not start"
            process.terminate()
            process.communicate(timeout=10)
            rc, output = launch()
            assert rc == 0, output
            result = shared["completions"][-1]["result"]
            assert result["status"] == "error" and "not re-executed" in result["message"]
            time.sleep(16)
            assert marker.read_text().splitlines() == ["started"], "orphaned or re-executed process modified the marker"
            print("PASS: crash kills the process tree and restart reports interruption without re-execution")
            uploads_before = len(shared["uploads"])
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", "[IO.File]::WriteAllBytes('oversized.bin',(New-Object byte[] (21*1024*1024)))"]})
            shared["assignment"]["envelope"]["spec"]["artifacts"]["globs"] = ["oversized.bin"]
            rc, output = launch()
            assert rc != 0 and shared["completions"][-1]["result"]["status"] == "error", output
            assert len(shared["uploads"]) == uploads_before
            print("PASS: oversized artifacts fail before uploading bytes")
            shared["upload_delay"], shared["upload_active"] = 22, False
            renewals_before = shared.get("renewals", 0)
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", "[IO.File]::WriteAllText('slow.bin','slow')"]})
            shared["assignment"]["envelope"]["spec"]["artifacts"]["globs"] = ["slow.bin"]
            rc, output = launch()
            assert rc == 0 and shared["renewals"] >= renewals_before + 2, output
            print("PASS: independent lease renewal continues through a slow artifact upload")
            shared["upload_delay"], shared["upload_active"], shared["cancel_during_upload"] = 30, False, True
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", "[IO.File]::WriteAllText('cancelled.bin','cancel')"]})
            shared["assignment"]["envelope"]["spec"]["artifacts"]["globs"] = ["cancelled.bin"]
            rc, output = launch()
            assert rc != 0 and shared.get("cancel_seen") and shared["completions"][-1]["result"]["status"] == "error", output
            shared["upload_delay"], shared["upload_active"], shared["cancel_during_upload"] = 0, False, False
            print("PASS: cancellation during upload stops transport and cannot report success")
            assignment({"interpreter": "exe", "script": "cmd.exe", "args": ["/d", "/c", "echo unused"]})
            repo_url = origin + "/unavailable-repository.git"
            commit = "1234567890abcdef1234567890abcdef12345678"
            shared["assignment"]["envelope"]["spec"]["repos"] = [{"name": "main", "url": repo_url, "branch": "feature/explicit-branch", "commit": commit, "checkoutDir": "source", "authToken": ""}]
            rc, output = launch()
            assert rc != 0, output
            assert "Repository URL: " + repo_url in shared["logs"]
            assert "Requested branch: feature/explicit-branch" in shared["logs"]
            assert "Pinned commit: " + commit in shared["logs"]
            print("PASS: checkout logs identify the requested repository, branch and pinned commit")
            drain = base / "drain-marker"
            shared["drain_path"], shared["drop_completion"] = drain, True
            claims_before = shared["claims"]
            assignment({"interpreter": "exe", "script": "powershell.exe", "args": ["-NoProfile", "-Command", "Write-Output drain-test; Start-Sleep -Seconds 2; [IO.File]::WriteAllText('drained.bin','completed')"]})
            shared["assignment"]["envelope"]["spec"]["artifacts"]["globs"] = ["drained.bin"]
            argv.remove("--once")
            argv.extend(["--drain-file", str(drain)])
            rc, output = launch()
            assert rc == 0 and drain.exists(), output
            assert shared["completions"][-1]["result"]["status"] == "success"
            assert shared["uploads"][-1] == ("drained.bin", b"completed")
            assert shared["claims"] == claims_before + 1, "draining claimed another job"
            assert "Drain requested" in output
            print("PASS: drain waits for upload and retried completion ACK, leaves marker, and claims no further job")
            del argv[-2:]
            argv.append("--once")
            sidecar = release / "release-info.json"
            identity = {"schemaVersion": 1, "protocolVersion": 2, "commit": "1234567890abcdef1234567890abcdef12345678", "sha256": hashlib.sha256(executable.read_bytes()).hexdigest()}
            sidecar.write_text(json.dumps(identity))
            rc, output = launch()
            assert rc == 0 and shared["agentVersion"] == "hosted-1234567890ab", output
            identity["sha256"] = "0" * 64
            sidecar.write_text(json.dumps(identity))
            rc, output = launch()
            assert rc != 0 and "hash does not match" in output, output
            print("PASS: release identity reports a binary-verified commit and rejects a mismatched sidecar")
            sidecar.unlink()
            crew_cases()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
