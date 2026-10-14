"""Exercise hosted-agent self-update end to end: the real Smith binary run by the real Start-Smith.bat.

A disposable TLS fixture plays the coordinator. The agent is installed from package A; the fixture
offers package B, which the agent downloads, installs and restarts into, and confirms. Then it
offers C, whose agent the fixture refuses: the launcher must put B back and C is never retried.

Requires Python, Git for Windows (curl/OpenSSL) and a built Smith (Build/Smith/Release).
Touches no production identity or services. Run: python Tests/SmithHostedAgentTest/hosted-update-test.py
"""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
GIT = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git"
WORKSPACE_ID = "b" * 64
TOKEN = "smn.fixture-node.fixture-token-for-update-test"
COMMITS = {name: (letter * 40) for name, letter in (("A", "a"), ("B", "b"), ("C", "c"))}
VERSIONS = {name: "hosted-" + commit[:12] for name, commit in COMMITS.items()}

spec = importlib.util.spec_from_file_location("package_experiment", ROOT / "tools/package-experiment.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def make_package(base: Path, name: str) -> Path:
    output = base / f"package-{name}"
    packager.package(ROOT / "Build/Smith/Release", output, commit=COMMITS[name])
    (output / "README.md").write_text(f"package {name}\n")
    return output


def main():
    if os.name != "nt":
        raise SystemExit("This fixture drives the Windows launcher")
    with tempfile.TemporaryDirectory(prefix="smith-hosted-update-") as directory:
        base = Path(directory)
        acl = "$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl('" + str(base).replace("'", "''") + "',$acl)"
        subprocess.run(["powershell.exe", "-NoProfile", "-Command", acl], check=True)
        install = base / "install"
        shutil.copytree(make_package(base, "A"), install)
        # The agent runs curl; CreateProcess looks in the executable's folder first, so Git's
        # OpenSSL curl placed there honours the fixture CA (System32's Schannel curl would not).
        for item in (GIT / "mingw64/bin").iterdir():
            if item.name == "curl.exe" or item.suffix.lower() == ".dll":
                if not (install / item.name).exists():
                    shutil.copy2(item, install / item.name)
        zips = {}
        for name in ("B", "C"):
            zips[name] = base / f"smith-experiment-{name}.zip"
            packager.zip_package(make_package(base, name), zips[name])
        cert, key = base / "cert.pem", base / "key.pem"
        subprocess.run([str(GIT / "usr/bin/openssl.exe"), "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        state = {"published": "B", "versions": [], "downloads": 0}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body, content_type="application/json"):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                assert self.headers.get("Authorization") == f"Bearer {TOKEN}"
                assert self.path == f"/api/v2/workspaces/{WORKSPACE_ID}/agent-package", self.path
                state["downloads"] += 1
                self.reply(200, zips[state["published"]].read_bytes(), "application/zip")

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
                route = self.path.removeprefix(f"/api/v2/workspaces/{WORKSPACE_ID}")
                if route == "/nodes/enroll":
                    return self.reply(201, json.dumps({"nodeId": "fixture-node", "token": TOKEN, "protocolVersion": 2}).encode())
                assert self.headers.get("Authorization") == f"Bearer {TOKEN}"
                if route == "/heartbeat":
                    version = payload["agentVersion"]
                    state["versions"].append(version)
                    if version == VERSIONS["C"]:   # the broken release: its agent is never accepted
                        return self.reply(401, b'{"error":"revoked"}')
                    response = {"accepted": True}
                    published = state["published"]
                    if version != VERSIONS[published]:
                        data = zips[published].read_bytes()
                        response["update"] = {"version": VERSIONS[published], "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
                    return self.reply(200, json.dumps(response).encode())
                if route == "/claims":
                    return self.reply(200, b'{"hasJob":false}')
                if route.startswith("/ai/"):
                    return self.reply(404, b'{}')
                raise AssertionError(route)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"https://localhost:{server.server_port}"
        env = {k: v for k, v in os.environ.items() if k.upper() not in ("NODEFAULTCURRENTDIRECTORYINEXEPATH", "SMITH_AGENT_AUTO_UPDATE")}
        env.update({"CURL_CA_BUNDLE": str(cert), "CURL_SSL_BACKEND": "openssl", "SMITH_AUTO_UPDATE_TOOLS": "0"})
        enrollment = base / "enrollment"
        enrollment.write_text("fixture-enrollment-code")
        # The launcher's own --coordinator/--workspace come first; these later ones take precedence.
        argv = ["cmd.exe", "/d", "/c", str(install / "Start-Smith.bat"), "agent", "--coordinator", origin,
                "--workspace-id", WORKSPACE_ID, "--workspace", str(base / "workspace"), "--enrollment-file", str(enrollment)]
        log = base / "launcher.log"
        sink = open(log, "w")
        launcher = subprocess.Popen(argv, cwd=base, env=env, stdout=sink, stderr=subprocess.STDOUT)

        def wait_for(condition, what, seconds=150):
            deadline = time.time() + seconds
            while time.time() < deadline:
                if condition():
                    return
                if launcher.poll() is not None:
                    raise AssertionError(f"launcher exited ({launcher.returncode}) while waiting for {what}:\n{log.read_text()}")
                time.sleep(0.5)
            raise AssertionError(f"timed out waiting for {what}:\n{log.read_text()}")

        def identity():
            return json.loads((install / "release-info.json").read_text())["commit"]

        try:
            wait_for(lambda: VERSIONS["B"] in state["versions"] and not (install / "update-pending.json").exists(), "the update to B")
            assert identity() == COMMITS["B"] and (install / "README.md").read_text() == "package B\n"
            assert not (install / ".update-previous").exists() and not (install / ".update-staging").exists()
            print("PASS: the agent installed the published package between jobs, restarted into it and confirmed it")

            state["published"] = "C"
            wait_for(lambda: (install / "update-rejected.json").exists() and state["versions"][-1] == VERSIONS["B"]
                     and "skipped, because it failed to start" in log.read_text(), "the rollback from C")
            assert identity() == COMMITS["B"] and (install / "README.md").read_text() == "package B\n"
            assert json.loads((install / "update-rejected.json").read_text())["to"] == VERSIONS["C"]
            downloads = state["downloads"]
            time.sleep(25)   # another heartbeat offers C again; it must not be downloaded
            assert state["downloads"] == downloads, "a rejected version was downloaded again"
            print("PASS: a release that never comes online is rolled back to the previous files and not retried")

            (install / "stop-agent").write_text("stop")
            launcher.wait(timeout=60)
            assert launcher.returncode == 0, log.read_text()
            print("PASS: the launcher stops cleanly on a drain after updates")
        finally:
            if launcher.poll() is None:
                (install / "stop-agent").write_text("stop")
                try:
                    launcher.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(launcher.pid)], capture_output=True)
            sink.close()
            server.shutdown()
            print("--- launcher output ---")
            print(log.read_text())


if __name__ == "__main__":
    main()
