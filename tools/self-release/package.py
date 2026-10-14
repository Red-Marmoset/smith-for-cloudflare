"""Create an immutable, deterministic Smith release candidate. Never deploys it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit
import zipfile

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024
MAX_ZIP_BYTES = 20 * 1024 * 1024
MAX_FILES = 2000


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode('utf-8')


def parse_jsonc(text):
    """Remove JSONC comments/trailing commas without changing quoted strings."""
    output = []
    index = 0
    quoted = False
    while index < len(text):
        char = text[index]
        if quoted:
            output.append(char)
            if char == '\\':
                index += 1
                if index < len(text): output.append(text[index])
            elif char == '"': quoted = False
        elif char == '"':
            quoted = True
            output.append(char)
        elif text.startswith('//', index):
            end = text.find('\n', index + 2)
            index = len(text) if end == -1 else end
            output.append('\n')
            continue
        elif text.startswith('/*', index):
            end = text.find('*/', index + 2)
            if end == -1: raise ValueError('Unterminated JSONC comment')
            output.append(' ')
            index = end + 2
            continue
        else: output.append(char)
        index += 1
    text = ''.join(output)
    output = []
    quoted = False
    index = 0
    while index < len(text):
        char = text[index]
        if quoted:
            output.append(char)
            if char == '\\':
                index += 1
                if index < len(text): output.append(text[index])
            elif char == '"': quoted = False
        elif char == '"':
            quoted = True
            output.append(char)
        elif char == ',' and text[index + 1:].lstrip().startswith(('}', ']')):
            pass
        else: output.append(char)
        index += 1
    value = json.loads(''.join(output))
    if not isinstance(value, dict): raise ValueError('Wrangler configuration must be a JSON object')
    return value


def validate_metadata(repository, branch, commit, coordinator_origin):
    if not re.fullmatch(r'[0-9a-f]{40}', commit): raise ValueError('Release commit must be a full lowercase 40-character Git SHA')
    if (not branch or len(branch) > 255 or re.search(r'[\s\x00-\x1f\x7f~^:?*\[\\]', branch)
            or '..' in branch or '@{' in branch or '//' in branch or branch.startswith(('-', '/'))
            or branch.endswith(('/', '.')) or any(part.startswith('.') or part.endswith('.lock') for part in branch.split('/'))):
        raise ValueError('Release branch must be a valid named Git branch')
    origin = urlsplit(coordinator_origin)
    if (origin.scheme != 'https' or not origin.hostname or origin.username or origin.password
            or origin.path or origin.query or origin.fragment or any(c.isspace() for c in coordinator_origin)
            or '\\' in coordinator_origin or origin.port == 0):
        raise ValueError('Coordinator URL must be an HTTPS origin without credentials, path, query or fragment')
    if repository.startswith('git@') and re.fullmatch(r'git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+', repository): return
    source = urlsplit(repository)
    if (source.scheme not in ('https', 'ssh') or not source.hostname or not source.path or source.query or source.fragment
            or source.password or (source.username and (source.scheme != 'ssh' or source.username != 'git'))
            or any(c.isspace() for c in repository) or '\\' in repository):
        raise ValueError('Repository must be an HTTPS or SSH Git remote without embedded credentials')


def safe_archive_path(name):
    if not isinstance(name, str) or not name or len(name) > 240 or '\\' in name or ':' in name:
        raise ValueError(f'Unsafe archive path: {name!r}')
    for part in name.split('/'):
        if (part in ('', '.', '..') or part.endswith(('.', ' ')) or re.search(r'[\x00-\x1f<>"|?*]', part)
                or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part, re.IGNORECASE)):
            raise ValueError(f'Unsafe archive path: {name!r}')
    return name


def check_payload(payload):
    if len(payload) > MAX_FILES: raise ValueError('Too many candidate files')
    names = set()
    total = 0
    for name, data in payload.items():
        safe_archive_path(name)
        key = name.casefold()
        if key in names: raise ValueError('Case-insensitive archive path collision')
        names.add(key)
        if len(data) > MAX_FILE_BYTES: raise ValueError(f'Candidate file exceeds size limit: {name}')
        total += len(data)
    if total > MAX_TOTAL_BYTES: raise ValueError('Candidate payload exceeds size limit')


def read_file(path):
    if path.is_symlink() or not path.is_file(): raise ValueError(f'Expected a regular input file: {path}')
    if path.stat().st_size > MAX_FILE_BYTES: raise ValueError(f'Candidate file exceeds size limit: {path.name}')
    with path.open('rb') as stream: data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES: raise ValueError(f'Candidate file exceeds size limit: {path.name}')
    return data


def tree_files(directory):
    if directory.is_symlink() or not directory.is_dir(): raise ValueError(f'Expected input directory: {directory}')
    for path in sorted(directory.rglob('*')):
        if path.is_symlink(): raise ValueError(f'Symlinks are not release inputs: {path}')
        if path.is_file(): yield path


LAUNCHER = '''# Start the packaged Smith agent using this release's coordinator origin.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('agent', 'version')][string]$Mode,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$SmithArgs
)
$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot 'Smith.exe'
$release = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-info.json') -Raw | ConvertFrom-Json
if ($Mode -eq 'version') { & $binary version }
else { & $binary hosted-agent --coordinator $release.coordinatorOrigin --workspace (Join-Path $PSScriptRoot 'hosted-workspace') @SmithArgs }
exit $LASTEXITCODE
'''


def cmd_launcher(coordinator_origin):
    # The same launcher for people who use Command Prompt. Batch cannot read release-info.json, so the
    # release's coordinator origin is written in; it must contain only characters inert in cmd.exe.
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?', coordinator_origin):
        raise ValueError('Coordinator origin cannot be written into the batch launcher')
    lines = [
        '@echo off',
        "rem Start the packaged Smith agent using this release's coordinator origin.",
        'rem   Start-Smith.cmd agent --workspace-id <workspace-id>    or    Start-Smith.cmd version',
        'setlocal EnableExtensions DisableDelayedExpansion',
        'set "SMITH_DIR=%~dp0"',
        'if /i "%~1"=="version" ("%SMITH_DIR%Smith.exe" version & exit /b)',
        'if /i not "%~1"=="agent" (echo Usage: %~nx0 agent --workspace-id ^<workspace-id^> ^| version & exit /b 2)',
        'set "SMITH_ARGS="',
        'for /f "tokens=1,* delims= " %%A in ("%*") do set "SMITH_ARGS=%%B"',
        f'"%SMITH_DIR%Smith.exe" hosted-agent --coordinator {coordinator_origin} --workspace "%SMITH_DIR%hosted-workspace" %SMITH_ARGS%',
        'exit /b %errorlevel%',
    ]
    return ('\r\n'.join(lines) + '\r\n').encode('ascii')


def package_release(*, repo_root, binary_dir, bundle_dir, output, repository, branch, commit, coordinator_origin):
    validate_metadata(repository, branch, commit, coordinator_origin)
    repo_root, binary_dir, bundle_dir, output = map(Path, (repo_root, binary_dir, bundle_dir, output))
    for directory in (repo_root, binary_dir, bundle_dir):
        if directory.is_symlink() or not directory.is_dir(): raise ValueError(f'Expected regular source directory: {directory}')
    digest_file = output.with_suffix(output.suffix + '.sha256')
    if output.suffix != '.zip': raise ValueError('Candidate output must have a .zip extension')
    if output.is_symlink() or digest_file.is_symlink(): raise ValueError('Candidate outputs must not be symlinks')
    for parent in output.parents:
        if parent.is_symlink(): raise ValueError('Candidate output directory must not contain symlinks')
    executable = binary_dir / 'Smith.exe'
    if not executable.is_file(): raise FileNotFoundError('Build the Windows Smith.exe before packaging')
    payload = {'agent/Smith.exe': read_file(executable)}
    if not payload['agent/Smith.exe'].startswith(b'MZ'): raise ValueError('Smith.exe is not a Windows executable')
    for path in sorted(binary_dir.iterdir()):
        if path.suffix.lower() == '.dll': payload['agent/' + path.name] = read_file(path)
    identity = dict(schemaVersion=1, repository=repository, branch=branch, commit=commit,
                    protocolVersion=2, coordinatorOrigin=coordinator_origin)
    payload['agent/release-info.json'] = canonical_json(identity | {'sha256': hashlib.sha256(payload['agent/Smith.exe']).hexdigest()})
    payload['agent/Start-Smith.ps1'] = LAUNCHER.encode('utf-8')
    payload['agent/Start-Smith.cmd'] = cmd_launcher(coordinator_origin)
    bundle_files = list(tree_files(bundle_dir))
    runtime_files = [path for path in bundle_files if path.suffix != '.map' and path.name != 'README.md']
    if len(runtime_files) != 1 or runtime_files[0].suffix not in ('.js', '.mjs'):
        raise ValueError('Expected one self-contained Wrangler JavaScript bundle; additional runtime modules require release schema support')
    payload['coordinator/index.js'] = read_file(runtime_files[0])
    if not payload['coordinator/index.js']: raise ValueError('Worker bundle is empty')
    coordinator = repo_root / 'cloudflare' / 'coordinator'
    for path in tree_files(coordinator / 'public'):
        payload['coordinator/public/' + path.relative_to(coordinator / 'public').as_posix()] = read_file(path)
    if 'coordinator/public/index.html' not in payload: raise ValueError('Coordinator dashboard index.html is missing')
    migrations = list(tree_files(coordinator / 'migrations'))
    if not migrations: raise ValueError('Coordinator migrations are missing')
    for path in migrations:
        if path.parent != coordinator / 'migrations' or path.suffix != '.sql': raise ValueError('Expected only top-level SQL migration files')
        payload['coordinator/migrations/' + path.name] = read_file(path)
    config = parse_jsonc(read_file(coordinator / 'wrangler.jsonc').decode('utf-8-sig'))
    # This is comparison material only. Promotion must take deployment authority from operator configuration.
    payload['coordinator/wrangler.json'] = canonical_json(config)
    check_payload(payload)
    manifest = identity | {
        'components': {'agent': {'executable': 'agent/Smith.exe'}, 'coordinator': {'main': 'coordinator/index.js', 'assets': 'coordinator/public'}},
        'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)} for name, data in sorted(payload.items())],
    }
    payload['manifest.json'] = canonical_json(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.smith-release-', suffix='.zip', dir=output.parent, delete=False) as temporary:
            temp_name = Path(temporary.name)
        with zipfile.ZipFile(temp_name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
            for name, data in sorted(payload.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        if temp_name.stat().st_size > MAX_ZIP_BYTES: raise ValueError('Candidate ZIP exceeds the 20 MiB artifact limit')
        digest = hashlib.sha256(temp_name.read_bytes()).hexdigest()
        os.replace(temp_name, output)
        temp_name = None
        digest_file.write_text(f'{digest}  {output.name}\n', encoding='utf-8', newline='\n')
        return digest
    finally:
        if temp_name is not None: temp_name.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--binary-dir', type=Path, required=True)
    parser.add_argument('--bundle-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--branch', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--coordinator-origin', required=True)
    arguments = parser.parse_args()
    try:
        checksum = package_release(**vars(arguments))
        print(f'Candidate: {arguments.output}\nSHA-256: {checksum}\nBuilding does not activate this release.')
    except (OSError, ValueError) as error:
        parser.exit(1, f'ERROR: {error}\n')
