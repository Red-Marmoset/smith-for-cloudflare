"""Package the existing native Smith build for the Cloudflare experiment."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import zipfile


REPO = Path(__file__).resolve().parents[1]
PROFILE = REPO / "config" / "experiment"
# Written into every package: the agent reports "hosted-<commit[:12]>" as its version only when
# the binary next to it has this hash, and updates itself when the coordinator publishes another.
RELEASE_INFO = "release-info.json"


def source_commit() -> str:
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], check=True,
                            capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", commit):
        raise ValueError(f"Unexpected git commit id: {commit!r}")
    return commit


def host_arch() -> str:
    """The architecture name the agent reports for this machine (SmithCore DetectArch)."""
    machine = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)


def package_os(executable_name: str) -> str:
    if executable_name == "Smith.exe":
        return "windows"
    return "mac" if platform.system() == "Darwin" else "linux"


def package(binary_dir: Path, output: Path, commit: str | None = None) -> None:
    binary_dir = binary_dir.resolve()
    output = output.resolve()
    if output == binary_dir or binary_dir in output.parents or output in binary_dir.parents:
        raise ValueError("Package and native build directories must be separate")
    executable = next((binary_dir / name for name in ("Smith.exe", "Smith")
                       if (binary_dir / name).is_file()), None)
    if executable is None:
        raise FileNotFoundError(f"Build Smith first: no Smith executable in {binary_dir}")
    runtime = [p for p in binary_dir.iterdir() if p.is_file() and (
        p == executable or p.suffix.lower() in (".dll", ".so", ".dylib") or ".so." in p.name)]
    assets = list(PROFILE.iterdir())
    files = runtime + assets
    if any(p.is_symlink() or not p.is_file() for p in files):
        raise ValueError("Package inputs must be regular files, not symlinks or directories")
    expected = {p.name for p in files} | {RELEASE_INFO}
    if output.exists():
        if not output.is_dir():
            raise ValueError("Package output must be a directory")
        if any(p.name not in expected or p.is_symlink() or not p.is_file()
               for p in output.iterdir()):
            raise ValueError("Output contains runtime or unexpected files; use a fresh package directory")
    output.mkdir(parents=True, exist_ok=True)
    for source in files:
        shutil.copy2(source, output / source.name)
    (output / "start-smith.sh").chmod(0o755)
    identity = {"schemaVersion": 1, "protocolVersion": 2, "commit": commit or source_commit(),
                "sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                "os": package_os(executable.name), "arch": host_arch()}
    (output / RELEASE_INFO).write_text(json.dumps(identity, indent=2) + "\n")
    print(f"Release: hosted-{identity['commit'][:12]} ({identity['os']} {identity['arch']})")
    print(f"Packaged Smith experiment: {output}")
    print("Coordinator and agent target: https://exp.redmarmosetstudios.com")


# Entries that macOS/Linux must be able to execute straight after unzipping.
EXECUTABLE = ("Smith", "start-smith.sh")


def zip_package(package: Path, archive: Path) -> None:
    """Zip a packaged directory with POSIX execute bits on the binary and launcher.

    shutil.make_archive / Compress-Archive on Windows store no permissions, so a
    macOS package built here would unzip with a non-executable Smith; writing the
    entries ourselves keeps 0755 on them regardless of the packaging host.
    """
    package = package.resolve()
    archive = archive.resolve()
    if archive.suffix.lower() != ".zip":
        raise ValueError("Archive must have a .zip extension")
    if archive.parent == package or package in archive.parents:
        raise ValueError("Archive must not be written inside the package directory")
    files = sorted(p for p in package.iterdir() if p.is_file() and not p.is_symlink())
    if not any(p.name in ("Smith", "Smith.exe") for p in files):
        raise FileNotFoundError(f"No Smith executable in {package}")
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as out:
        for source in files:
            info = zipfile.ZipInfo.from_file(source, arcname=source.name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3   # Unix: external_attr carries the mode
            mode = 0o755 if source.name in EXECUTABLE else 0o644
            info.external_attr = (0o100000 | mode) << 16
            with open(source, "rb") as data:
                out.writestr(info, data.read())
    print(f"Zipped: {archive}")


def write_manifest(archive: Path) -> Path:
    """Describe a package zip for the coordinator, which offers it to agents as an update.

    Written next to the zip as <name>.json (smith-experiment-windows.json); upload it after the zip.
    """
    archive = archive.resolve()
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if any("/" in n or "\\" in n for n in names):
            raise ValueError("Package zip must hold plain files only, not folders")
        if RELEASE_INFO not in names:
            raise ValueError(f"{archive.name} has no {RELEASE_INFO}; package it with this script")
        identity = json.loads(z.read(RELEASE_INFO))
        executable = "Smith.exe" if "Smith.exe" in names else "Smith"
        if hashlib.sha256(z.read(executable)).hexdigest() != identity["sha256"]:
            raise ValueError(f"{RELEASE_INFO} does not match the {executable} in {archive.name}")
    data = archive.read_bytes()
    manifest = {"schemaVersion": 1, "version": "hosted-" + identity["commit"][:12], "commit": identity["commit"],
                "os": identity.get("os", "windows" if executable == "Smith.exe" else ""),
                "arch": identity.get("arch", ""), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    if manifest["os"] not in ("windows", "mac", "linux"):
        raise ValueError(f"{RELEASE_INFO} does not say which OS the package is for")
    path = archive.with_suffix(".json")
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Manifest: {path} ({manifest['version']}, {manifest['os']} {manifest['arch']})")
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary-dir", type=Path, default=Path("Build/Smith/Release"))
    parser.add_argument("--output", type=Path, default=Path("Build/SmithExperiment/Release"))
    parser.add_argument("--zip", type=Path, default=None,
                        help="also write the package as this zip, with execute bits for macOS/Linux, "
                             "and its update manifest next to it")
    parser.add_argument("--manifest-only", type=Path, default=None, metavar="ZIP",
                        help="only write the update manifest for an existing package zip")
    args = parser.parse_args()
    try:
        if args.manifest_only is not None:
            write_manifest(args.manifest_only)
            raise SystemExit(0)
        package(args.binary_dir, args.output)
        if args.zip is not None:
            zip_package(args.output, args.zip)
            write_manifest(args.zip)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"ERROR: {error}\n")
