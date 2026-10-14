#!/usr/bin/env python3
"""Explicit, standalone Smith release promotion (Python 3.11+, Windows operator).

No candidate scripts, installers, npm hooks or migration SQL are executed. `plan`
is read-only. Keep the target, journal, toolchain and credentials under operator
control, outside the agent workspace. Recovery never rolls back database data.
"""
import argparse
import copy
import ctypes
from ctypes import wintypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

MAX_ARCHIVE = 128 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILES = 4096
HEX40 = re.compile(r'[a-f0-9]{40}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
IDENTITY = ('schemaVersion', 'repository', 'branch', 'commit', 'protocolVersion', 'coordinatorOrigin')
COMPONENTS = {'agent': {'executable': 'agent/Smith.exe'}, 'coordinator': {'main': 'coordinator/index.js', 'assets': 'coordinator/public'}}


class PromotionError(Exception):
    pass


class RecoveryRequired(PromotionError):
    pass


class HttpStatusError(PromotionError):
    def __init__(self, status):
        self.status = status
        super().__init__('Remote request returned HTTP ' + str(status))


def require(condition, message):
    if not condition:
        raise PromotionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def read_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError) as error:
        raise PromotionError('Invalid JSON; trusted Wrangler config must be JSON without comments') from error


def no_links(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.exists() or item.is_symlink():
            info = item.lstat()
            require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & 0x400), 'Symlinks/reparse points are not permitted: ' + str(item))


def assert_private(path):
    """Require owner-only files/directories (also allow Windows SYSTEM/Admins)."""
    path = Path(path)
    no_links(path)
    require(path.exists(), 'Required protected path does not exist: ' + str(path))
    if os.name != 'nt':
        info = path.stat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'Path must be owned by this account with no group/world access: ' + str(path))
        return
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    adv.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    adv.GetNamedSecurityInfoW.restype = wintypes.DWORD
    adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    adv.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    def sid_text(pointer):
        text = wintypes.LPWSTR()
        require(bool(adv.ConvertSidToStringSidW(pointer, ctypes.byref(text))), 'Cannot inspect Windows SID')
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    token = wintypes.HANDLE()
    require(bool(adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token))), 'Cannot inspect current Windows account')
    try:
        size = wintypes.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        require(bool(adv.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size))), 'Cannot inspect current Windows account')
        current = sid_text(ctypes.c_void_p.from_buffer(buffer).value)
    finally:
        kernel.CloseHandle(token)
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    result = adv.GetNamedSecurityInfoW(str(path), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
    require(result == 0, 'Cannot inspect path ACL: ' + str(path))
    try:
        allowed = {current, 'S-1-5-18', 'S-1-5-32-544'}
        require(sid_text(owner) in allowed and dacl.value, 'Path must have an owner-controlled ACL: ' + str(path))
        # ACL header: revision byte, padding byte, size WORD, ACE count WORD.
        count = ctypes.c_ushort.from_address(dacl.value + 4).value
        for index in range(count):
            ace = ctypes.c_void_p()
            require(bool(adv.GetAce(dacl, index, ctypes.byref(ace))), 'Cannot inspect ACL entry')
            kind = ctypes.c_ubyte.from_address(ace.value).value
            flags = ctypes.c_ubyte.from_address(ace.value + 1).value
            if flags & 8 or kind == 1:  # inherit-only or denied access
                continue
            require(kind == 0, 'Unsupported ACL entry on protected path: ' + str(path))
            require(sid_text(ace.value + 8) in allowed, 'Restrict path access to this account, SYSTEM and Administrators: ' + str(path))
    finally:
        kernel.LocalFree(descriptor)
    return current


def windows_user_only(path):
    """Native drain markers deliberately accept only the current user's ACE."""
    sid = assert_private(path)
    require(sid and sid.startswith('S-1-'), 'Cannot determine owner for native drain marker')
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    adv.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    require(adv.ConvertStringSecurityDescriptorToSecurityDescriptorW('D:P(A;;FA;;;' + sid + ')', 1, ctypes.byref(descriptor), None), 'Cannot create owner-only marker ACL')
    try:
        require(adv.SetFileSecurityW(str(path), 4 | 0x80000000, descriptor), 'Cannot secure native drain marker')
    finally:
        kernel.LocalFree(descriptor)


def absolute(value, label, exists=True):
    require(isinstance(value, str) and Path(value).is_absolute(), label + ' must be an absolute path')
    result = Path(value)
    no_links(result)
    if exists:
        require(result.exists(), label + ' does not exist')
    return result


def inside(path, root):
    return Path(path).resolve().is_relative_to(Path(root).resolve())


def load_target(path):
    path = absolute(str(path), 'target')
    assert_private(path)
    assert_private(path.parent)
    target = read_json(path.read_bytes())
    require(isinstance(target, dict) and target.get('schemaVersion') == 1, 'Unsupported target schema')
    allowed = {'schemaVersion','origin','workerName','accountId','nodePath','wranglerPath','wranglerConfig','stateDirectory','migrationHashes','userSessionFile','agent','timeouts'}
    require(set(target) <= allowed and allowed - {'timeouts'} <= set(target), 'Missing or unsupported target fields')
    origin = urllib.parse.urlsplit(target['origin'])
    require(origin.scheme == 'https' and origin.hostname and not origin.username and not origin.password and not origin.path and not origin.query and not origin.fragment and target['origin'] == target['origin'].rstrip('/'), 'origin must be an HTTPS origin without path or credentials')
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', target['workerName'] or ''), 'Invalid Worker name')
    require(re.fullmatch(r'[a-f0-9]{32}', target['accountId'] or ''), 'Invalid Cloudflare account ID')
    for key in ['nodePath','wranglerPath','wranglerConfig','userSessionFile','stateDirectory']:
        absolute(target[key], key)
    require(Path(target['stateDirectory']).is_dir(), 'stateDirectory must exist')
    for key in ['stateDirectory','wranglerConfig','userSessionFile']:
        assert_private(target[key])
        assert_private(Path(target[key]).parent)
    agent = target['agent']
    require(isinstance(agent, dict) and set(agent) == {'executable','workspace','workspaceId','labels','pidFile','drainFile','installRoot'}, 'Invalid agent target fields')
    for key in ['executable','workspace','pidFile','drainFile','installRoot']:
        absolute(agent[key], 'agent.' + key, exists=key != 'drainFile')
    for key in ['workspace','installRoot']:
        require(Path(agent[key]).is_dir(), key + ' must be an existing directory')
        assert_private(agent[key])
    assert_private(agent['pidFile'])
    assert_private(Path(agent['pidFile']).parent)
    assert_private(Path(agent['drainFile']).parent)
    require(not inside(agent['installRoot'], agent['workspace']) and not inside(agent['workspace'], agent['installRoot']), 'Install root and job workspace must be separate')
    require(not inside(target['stateDirectory'], agent['workspace']) and not inside(path, agent['workspace']) and not inside(target['userSessionFile'], agent['workspace']), 'Operator state and credentials must be outside the job workspace')
    require(HEX64.fullmatch(agent['workspaceId'] or ''), 'Invalid workspace ID')
    require(isinstance(agent['labels'], list) and all(isinstance(label, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', label) for label in agent['labels']), 'Invalid agent labels')
    migrations = target['migrationHashes']
    require(isinstance(migrations, dict) and all(re.fullmatch(r'[A-Za-z0-9_.-]+\.sql', name) and HEX64.fullmatch(value) for name, value in migrations.items()), 'Invalid migration baseline')
    timeouts = target.get('timeouts', {})
    require(isinstance(timeouts, dict) and set(timeouts) <= {'drainSeconds','healthSeconds'}, 'Invalid timeouts')
    require(all(type(value) is int and 1 <= value <= 7200 for value in timeouts.values()), 'Timeouts must be 1–7200 seconds')
    config = read_json(Path(target['wranglerConfig']).read_bytes())
    require(isinstance(config, dict), 'Trusted Wrangler configuration must be an object')
    require(config.get('name') == target['workerName'] and config.get('account_id') == target['accountId'] and config.get('vars', {}).get('ORIGIN') == target['origin'], 'Trusted Wrangler config must match the explicit target identity')
    return target, config


def archive_path(name):
    require(isinstance(name, str) and name and len(name) <= 240 and not name.startswith('/') and '\\' not in name and ':' not in name, 'Unsafe archive path')
    parts = name.split('/')
    for part in parts:
        require(part not in ('', '.', '..') and not part.endswith((' ', '.')) and not re.search(r'[\x00-\x1f\x7f<>"|?*]', part), 'Unsafe archive path')
        require(not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part), 'Reserved Windows archive path')
    return name


def permitted_payload(name):
    if name in {'agent/Smith.exe','agent/release-info.json','agent/Start-Smith.ps1','agent/Start-Smith.cmd','coordinator/index.js','coordinator/wrangler.json'}:
        return True
    if re.fullmatch(r'agent/[A-Za-z0-9_.-]+\.dll', name, re.IGNORECASE):
        return True
    if name.startswith('coordinator/public/'):
        return True
    return bool(re.fullmatch(r'coordinator/migrations/[A-Za-z0-9_.-]+\.sql', name))


def config_shape(config):
    config = copy.deepcopy(config)
    allowed = {'$schema','name','account_id','main','compatibility_date','compatibility_flags','workers_dev','preview_urls','routes','vars','version_metadata','assets','r2_buckets','durable_objects','migrations','d1_databases','observability','limits','placement','keep_vars','upload_source_maps','logpush'}
    require(set(config) <= allowed, 'Unsupported Wrangler configuration; build hooks, environments and new resource types require separate review')
    for key in ('$schema','name','account_id','main','routes'):
        config.pop(key, None)
    for key in ('ORIGIN','RELEASE_SHA'):
        config.get('vars', {}).pop(key, None)
    config.get('assets', {}).pop('directory', None)
    for binding in config.get('d1_databases', []):
        for key in ('database_id','database_name','preview_database_id','migrations_dir'):
            binding.pop(key, None)
    for binding in config.get('r2_buckets', []):
        for key in ('bucket_name','preview_bucket_name'):
            binding.pop(key, None)
    return config


def inspect_candidate(path, target, trusted, approved=None):
    require(Path(path).stat().st_size <= MAX_ARCHIVE, 'Candidate archive is too large')
    data = Path(path).read_bytes()
    digest = sha(data)
    if approved is not None:
        require(isinstance(approved, str) and HEX64.fullmatch(approved) and approved == digest, 'Approval digest does not exactly match the candidate archive')
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        entries = archive.infolist()
        require(0 < len(entries) <= MAX_FILES, 'Too many archive entries')
        names, total, payload = set(), 0, {}
        for entry in entries:
            name = archive_path(entry.filename)
            folded = name.casefold()
            require(folded not in names, 'Duplicate or case-colliding archive entries')
            require(not any(folded.startswith(previous + '/') or previous.startswith(folded + '/') for previous in names), 'Archive file/directory collision')
            names.add(folded)
            mode = entry.external_attr >> 16
            require(not entry.is_dir() and (not stat.S_IFMT(mode) or stat.S_ISREG(mode)), 'Archive must contain only regular files')
            require(not entry.flag_bits & 1 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsupported archive compression/encryption')
            require(entry.file_size <= MAX_FILE and (name != 'manifest.json' or entry.file_size <= 1024 * 1024), 'Archive file is too large')
            total += entry.file_size
            require(total <= MAX_TOTAL, 'Unpacked archive exceeds limit')
            require(name == 'manifest.json' or permitted_payload(name), 'Unexpected archive payload: ' + name)
            payload[name] = archive.read(entry)
            require(len(payload[name]) == entry.file_size, 'Incorrect archive file size')
    except (zipfile.BadZipFile, RuntimeError, OSError) as error:
        raise PromotionError('Invalid candidate ZIP') from error
    require('manifest.json' in payload, 'Missing manifest.json')
    manifest = read_json(payload.pop('manifest.json'))
    require(isinstance(manifest, dict) and set(manifest) == set(IDENTITY) | {'files','components'}, 'Invalid release manifest fields')
    require(manifest['schemaVersion'] == 1 and manifest['protocolVersion'] == 2, 'Unsupported release schema/protocol')
    require(isinstance(manifest['commit'], str) and HEX40.fullmatch(manifest['commit']), 'Release must pin a full lowercase commit SHA')
    require(isinstance(manifest['repository'], str) and re.fullmatch(r'(?:https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?', manifest['repository']), 'Invalid release repository')
    require(isinstance(manifest['branch'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}', manifest['branch']) and '..' not in manifest['branch'], 'Invalid release branch')
    require(manifest['coordinatorOrigin'] == target['origin'], 'Candidate origin differs from operator target')
    require(manifest['components'] == COMPONENTS, 'Unsupported component paths')
    require(isinstance(manifest['files'], list), 'Manifest files must be a list')
    inventory = {}
    for item in manifest['files']:
        require(isinstance(item, dict) and set(item) == {'path','sha256','size'}, 'Invalid inventory item')
        name = archive_path(item['path'])
        require(name not in inventory and name in payload and type(item['size']) is int and item['size'] >= 0, 'Invalid or duplicate manifest path/size')
        require(item['size'] == len(payload[name]) and item['sha256'] == sha(payload[name]), 'Payload hash/size mismatch: ' + name)
        inventory[name] = item
    require(set(inventory) == set(payload), 'Manifest does not cover every payload file')
    required = {'agent/Smith.exe','agent/release-info.json','coordinator/index.js','coordinator/public/index.html','coordinator/wrangler.json'}
    require(required <= set(payload), 'Missing required release payload')
    release = read_json(payload['agent/release-info.json'])
    require(isinstance(release, dict) and all(release.get(k) == manifest[k] for k in IDENTITY) and release.get('sha256') == sha(payload['agent/Smith.exe']), 'Agent release identity/hash differs from manifest')
    candidate_config = read_json(payload['coordinator/wrangler.json'])
    require(isinstance(candidate_config, dict) and config_shape(candidate_config) == config_shape(trusted), 'Candidate changes resource, runtime or migration configuration; separate review required')
    migrations = {name.removeprefix('coordinator/migrations/'): sha(value) for name, value in payload.items() if name.startswith('coordinator/migrations/')}
    require(migrations == target['migrationHashes'], 'Candidate changes migration SQL; separately review/apply migrations and update the baseline')
    return {'digest': digest, 'manifest': manifest, 'payload': payload}


def make_plan(candidate, target_path):
    target, trusted = load_target(target_path)
    release = inspect_candidate(candidate, target, trusted)
    return {'archiveSha256': release['digest'], **{key: release['manifest'][key] for key in IDENTITY},
            'workerName': target['workerName'], 'accountId': target['accountId'], 'agentWorkspace': target['agent']['workspace'],
            'agentInstallRoot': target['agent']['installRoot'], 'files': len(release['payload']),
            'checks': ['All payload hashes and sizes verified', 'Resource/runtime configuration matches trusted baseline', 'Migration SQL unchanged', 'No candidate code executed'],
            'approval': 'promote requires --approve-sha256 ' + release['digest']}


def atomic_json(path, value):
    atomic_bytes(path, canonical(value) + b'\n')


def atomic_bytes(path, data, owner_only=False):
    path = Path(path)
    no_links(path)
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if owner_only and os.name == 'nt':
            windows_user_only(temporary)
        os.replace(temporary, path)
        if os.name != 'nt':
            fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if temporary.exists():
            temporary.unlink()


class Lock:
    def __init__(self, path):
        self.path = Path(path)

    def __enter__(self):
        no_links(self.path)
        self.stream = open(self.path, 'a+b')
        try:
            self.stream.seek(0)
            if not self.stream.read(1):
                self.stream.write(b'0')
                self.stream.flush()
            self.stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.stream.close()
            raise RecoveryRequired('Another promotion/recovery operation holds the lock') from error
        return self

    def __exit__(self, *_):
        self.stream.close()


def fingerprint(target, trusted):
    return sha(canonical({'target': target, 'trustedConfig': trusted}))


def journal_path(target):
    return Path(target['stateDirectory']) / 'promotion.json'


def save(target, journal, stage):
    journal['stage'] = stage
    journal['updatedAt'] = int(time.time() * 1000)
    atomic_json(journal_path(target), journal)


def read_journal(target, trusted):
    path = journal_path(target)
    assert_private(path)
    journal = read_json(path.read_bytes())
    require(journal.get('schemaVersion') == 1 and journal.get('targetFingerprint') == fingerprint(target, trusted), 'Recovery target/config differs from the recorded operation')
    return journal


def stage_release(release, target, trusted, old_process):
    destination = Path(target['agent']['installRoot']) / release['digest']
    require(not destination.exists(), 'Release directory already exists; reconcile its journal instead of overwriting it')
    destination.mkdir(mode=0o700)
    for name, data in release['payload'].items():
        path = destination.joinpath(*PurePosixPath(name).parts)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_bytes(path, data)
    atomic_json(destination / 'manifest.json', release['manifest'])
    previous_dir = destination / 'previous-agent'
    previous_dir.mkdir(mode=0o700)
    old_exe = Path(old_process['executable'])
    require(old_exe.is_file(), 'Previous executable missing')
    old_files = [old_exe] + sorted(old_exe.parent.glob('*.dll'))
    if (old_exe.parent / 'release-info.json').exists():
        old_files.append(old_exe.parent / 'release-info.json')
    previous_hashes = {}
    for file in old_files:
        no_links(file)
        data = file.read_bytes()
        atomic_bytes(previous_dir / file.name, data)
        previous_hashes[file.name] = sha(data)
    generated = copy.deepcopy(trusted)
    generated.pop('$schema', None)
    generated['main'] = str(destination / 'coordinator' / 'index.js')
    generated['assets']['directory'] = str(destination / 'coordinator' / 'public')
    generated.setdefault('vars', {})['RELEASE_SHA'] = release['manifest']['commit']
    generated['no_bundle'] = True
    for database in generated.get('d1_databases', []):
        if 'migrations_dir' in database:
            database['migrations_dir'] = str(destination / 'coordinator' / 'migrations')
    config_path = destination / 'deploy-target.json'
    atomic_json(config_path, generated)
    return destination, config_path, previous_dir / old_exe.name, previous_hashes


def promote(candidate, target_path, approval, adapter=None):
    # Check approval before ACL helpers, creating locks/directories, network or subprocesses.
    require(isinstance(approval, str) and HEX64.fullmatch(approval), 'An exact --approve-sha256 is required')
    require(Path(candidate).stat().st_size <= MAX_ARCHIVE and sha(Path(candidate).read_bytes()) == approval, 'Approval digest does not exactly match the candidate archive')
    target, trusted = load_target(target_path)
    release = inspect_candidate(candidate, target, trusted, approval)
    adapter = adapter or LiveAdapter(target)
    with Lock(Path(target['stateDirectory']) / 'promotion.lock'):
        if journal_path(target).exists():
            existing = read_journal(target, trusted)
            if existing['stage'] == 'complete' and existing['archiveSha256'] == approval:
                return existing
            if existing['stage'] not in ('complete', 'rolled_back') or existing['archiveSha256'] == approval:
                raise RecoveryRequired('An operation already exists; use reconcile or rollback, never blindly retry')
            atomic_json(Path(target['stateDirectory']) / ('history-' + existing['operationId'] + '.json'), existing)
        previous_deployment = adapter.current_deployment()
        previous_health = adapter.worker_health()
        require(previous_health.get('protocolVersion') == 2 and previous_health.get('deployment') == previous_deployment['versions'][0]['version_id'], 'Current Worker health must match the exact serving deployment and protocol')
        require(previous_health.get('sourceCommit') is None or HEX40.fullmatch(previous_health['sourceCommit']), 'Invalid current Worker sourceCommit')
        previous_process = adapter.current_agent()
        previous_node = adapter.node_status()
        require(previous_node.get('active') and isinstance(previous_node.get('agentVersion'), str), 'Current node is not active/verifiable')
        journal = {'schemaVersion': 1, 'operationId': uuid.uuid4().hex, 'archiveSha256': approval, 'commit': release['manifest']['commit'],
                   'targetFingerprint': fingerprint(target, trusted), 'startedAt': int(time.time() * 1000),
                   'previous': {'deployment': previous_deployment, 'workerCommit': previous_health.get('sourceCommit'), 'agentProcess': previous_process, 'agentVersion': previous_node['agentVersion']}}
        save(target, journal, 'staging')
        destination, config_path, old_executable, old_hashes = stage_release(release, target, trusted, previous_process)
        journal.update({'releaseDirectory': str(destination), 'generatedConfig': str(config_path), 'newExecutable': str(destination / 'agent' / 'Smith.exe')})
        journal['previous'].update({'agentExecutable': str(old_executable), 'agentFiles': old_hashes})
        save(target, journal, 'deploying')  # Durable intent precedes the external side effect.
        try:
            adapter.deploy(config_path)
        except Exception as error:
            save(target, journal, 'deploy_uncertain')
            raise RecoveryRequired('Worker deployment outcome is uncertain; run reconcile before any further mutation') from error
        journal['newDeployment'] = adapter.current_deployment()
        save(target, journal, 'worker_deployed')
        if not adapter.verify_worker(journal['commit']):
            rollback_operation(target, journal, adapter)
            raise PromotionError('New Worker health failed; previous release restored')
        journal['agentHandoffStarted'] = True
        save(target, journal, 'draining')
        try:
            adapter.drain(previous_process)
        except Exception as error:
            save(target, journal, 'drain_uncertain')
            raise RecoveryRequired('Agent drain did not complete safely; reconcile or explicitly rollback') from error
        save(target, journal, 'agent_stopped')
        save(target, journal, 'agent_starting')
        try:
            journal['newProcess'] = adapter.start_agent(journal['newExecutable'])
        except Exception as error:
            save(target, journal, 'agent_start_uncertain')
            raise RecoveryRequired('New agent start outcome is uncertain; reconcile before restarting any agent') from error
        journal['agentStartedAt'] = int(time.time() * 1000)
        save(target, journal, 'agent_started')
        if not adapter.verify_agent(journal['newProcess'], 'hosted-' + journal['commit'][:12], journal['agentStartedAt'], require_ready=False):
            rollback_operation(target, journal, adapter)
            raise PromotionError('New agent health failed while claims were paused; previous release restored')
        save(target, journal, 'resume_intent')
        try:
            adapter.resume_node()
        except Exception as error:
            save(target, journal, 'resume_uncertain')
            raise RecoveryRequired('Claims resume outcome is uncertain; reconcile before proceeding') from error
        if not adapter.verify_agent(journal['newProcess'], 'hosted-' + journal['commit'][:12], journal['agentStartedAt']):
            rollback_operation(target, journal, adapter)
            raise PromotionError('New agent health failed; previous release restored')
        save(target, journal, 'complete')
        return journal


def rollback_operation(target, journal, adapter):
    previous = journal['previous']
    require('agentExecutable' in previous, 'Staging did not complete; no rollback payload is recorded')
    for name, digest in previous['agentFiles'].items():
        file = Path(previous['agentExecutable']).parent / archive_path(name)
        no_links(file)
        require(file.is_file() and sha(file.read_bytes()) == digest, 'Previous agent backup changed; manual recovery required')
    current = adapter.current_deployment()
    allowed = [previous['deployment']['versions']]
    if 'newDeployment' in journal:
        allowed.append(journal['newDeployment']['versions'])
    else:
        health = adapter.worker_health()
        require(health.get('sourceCommit') in (previous['workerCommit'], journal['commit']), 'Worker changed outside this promotion; refusing rollback')
        allowed.append(current['versions'])
    require(current['versions'] in allowed, 'Worker changed outside this promotion; refusing rollback')
    new_process = journal.get('newProcess') or adapter.discover_agent(journal['newExecutable'])
    if new_process and adapter.process_alive(new_process):
        save(target, journal, 'rollback_draining')
        adapter.drain(new_process)
    if journal.get('agentHandoffStarted'):
        # Do this while the new Worker still serves the drain API. Legacy Workers
        # ignore the additive draining column; no old process is started yet.
        adapter.resume_node(allow_legacy=current['versions'] == previous['deployment']['versions'] and previous['workerCommit'] is None)
    save(target, journal, 'rollback_worker_intent')
    if current['versions'] != previous['deployment']['versions']:
        try:
            adapter.restore_worker(previous['deployment'])
        except Exception as error:
            save(target, journal, 'rollback_uncertain')
            raise RecoveryRequired('Rollback response uncertain; run reconcile') from error
    require(adapter.verify_previous(previous), 'Previous Worker health could not be verified; recovery required')
    if not adapter.process_alive(previous['agentProcess']):
        restored = adapter.discover_agent(previous['agentExecutable'])
        if not restored:
            save(target, journal, 'rollback_agent_starting')
            restored = adapter.start_agent(previous['agentExecutable'])
        journal['restoredProcess'] = restored
        journal['restoredAt'] = int(time.time() * 1000)
        save(target, journal, 'rollback_agent_started')
        require(adapter.verify_agent(restored, previous['agentVersion'], journal['restoredAt']), 'Previous agent health could not be verified; recovery required')
    else:
        require(adapter.verify_agent(previous['agentProcess'], previous['agentVersion'], journal['startedAt']), 'Previous agent health could not be verified; recovery required')
    save(target, journal, 'rolled_back')
    return journal


def rollback(target_path, approval, adapter=None):
    target, trusted = load_target(target_path)
    journal = read_journal(target, trusted)
    require(approval == journal['archiveSha256'], 'Rollback requires the exact recorded --approve-sha256')
    adapter = adapter or LiveAdapter(target)
    with Lock(Path(target['stateDirectory']) / 'promotion.lock'):
        journal = read_journal(target, trusted)
        require(approval == journal['archiveSha256'], 'Journal changed before lock acquisition')
        if journal['stage'] == 'rolled_back':
            return journal
        require(not journal['stage'].startswith('rollback_'), 'Interrupted rollback requires reconcile before another rollback')
        return rollback_operation(target, journal, adapter)


def reconcile(target_path, adapter=None):
    target, trusted = load_target(target_path)
    adapter = adapter or LiveAdapter(target)
    with Lock(Path(target['stateDirectory']) / 'promotion.lock'):
        journal = read_journal(target, trusted)
        health = adapter.worker_health()
        deployment = adapter.current_deployment()
        process = adapter.discover_agent(journal.get('newExecutable', ''))
        journal['observed'] = {'workerCommit': health.get('sourceCommit'), 'deployment': deployment, 'newProcess': process}
        known_deployment = journal.get('newDeployment', deployment)['versions'] == deployment['versions']
        if process and known_deployment and health.get('sourceCommit') == journal['commit'] and health.get('deployment') == deployment['versions'][0]['version_id'] and adapter.verify_agent(process, 'hosted-' + journal['commit'][:12], journal['startedAt']):
            journal['newProcess'] = process
            save(target, journal, 'complete')
        elif deployment['versions'] == journal['previous']['deployment']['versions'] and health.get('deployment') == deployment['versions'][0]['version_id']:
            old = journal['previous']['agentProcess']
            restored = adapter.discover_agent(journal['previous'].get('agentExecutable', ''))
            active = old if adapter.process_alive(old) else restored
            if active and adapter.verify_agent(active, journal['previous']['agentVersion'], journal['startedAt']):
                if active == restored:
                    journal['restoredProcess'] = restored
                save(target, journal, 'rolled_back')
            else:
                save(target, journal, 'recovery_required')
        else:
            if 'newDeployment' not in journal and health.get('sourceCommit') == journal['commit']:
                journal['newDeployment'] = deployment
            save(target, journal, 'recovery_required')
        return journal


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def http_json(url, token=None, body=None):
    headers = {'Accept': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'Smith-Promoter/1.0'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, headers=headers, data=canonical(body) if body is not None else None)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            data = response.read(2 * 1024 * 1024 + 1)
            require(len(data) <= 2 * 1024 * 1024, 'HTTP response exceeds limit')
            return read_json(data)
    except urllib.error.HTTPError as error:
        error.close()
        raise HttpStatusError(error.code) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise PromotionError('Remote request failed; no credential-bearing response is printed') from error


def process_snapshot(pid):
    require(os.name == 'nt', 'Live promotion currently supports Windows native agents only')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000 | 0x100000, False, int(pid))
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        require(kernel.GetExitCodeProcess(handle, ctypes.byref(code)), 'Cannot inspect process exit status')
        if code.value != 259:
            return None
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buffer))
        require(kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)), 'Cannot inspect process executable')
        times = [wintypes.FILETIME() for _ in range(4)]
        require(kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)), 'Cannot inspect process creation time')
        created = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
        return {'pid': int(pid), 'created': str(created), 'executable': str(Path(buffer.value).resolve())}
    finally:
        kernel.CloseHandle(handle)


def safe_environment():
    allowed = {'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','HOMEDRIVE','HOMEPATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','UNA_ENGINE_PATH','SSH_AUTH_SOCK','SMITH_RELEASE_BRANCH','SMITH_COORDINATOR_URL'}
    return {key: value for key, value in os.environ.items() if key.upper() in allowed}


def agent_command(target, executable):
    agent = target['agent']
    command = [str(executable), 'hosted-agent', '--coordinator', target['origin'], '--workspace', agent['workspace'], '--workspace-id', agent['workspaceId']]
    if (Path(executable).parent / 'release-info.json').is_file():
        command += ['--drain-file', agent['drainFile']]
    if agent['labels']:
        command += ['--labels', ','.join(agent['labels'])]
    return command


class LiveAdapter:
    def __init__(self, target):
        require(os.name == 'nt', 'Live promotion currently supports Windows only')
        self.target = target
        self.token = os.environ.get('CLOUDFLARE_API_TOKEN')
        require(self.token, 'CLOUDFLARE_API_TOKEN must be supplied by the operator environment')
        self.endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + target['accountId'] + '/workers/scripts/' + target['workerName'] + '/deployments'

    def current_deployment(self):
        result = http_json(self.endpoint, self.token)
        require(result.get('success') and result.get('result', {}).get('deployments'), 'Cannot discover current Worker deployment')
        deployment = result['result']['deployments'][0]
        versions = deployment.get('versions', [])
        require(len(versions) == 1 and versions[0].get('percentage') == 100 and re.fullmatch(r'[a-f0-9-]{36}', versions[0].get('version_id', '')), 'Only a single 100% Worker version can be promoted/rolled back')
        return {'id': deployment['id'], 'versions': versions}

    def worker_health(self):
        return http_json(self.target['origin'] + '/health')

    def current_agent(self):
        file = Path(self.target['agent']['pidFile'])
        assert_private(file)
        value = read_json(file.read_bytes())
        snapshot = process_snapshot(value['pid'] if isinstance(value, dict) else value)
        require(snapshot, 'Configured agent PID is not running')
        if isinstance(value, dict):
            require(snapshot == value, 'PID file no longer identifies the same process')
        else:
            require(Path(snapshot['executable']).resolve() == Path(self.target['agent']['executable']).resolve(), 'PID belongs to a different executable')
        require(Path(snapshot['executable']).resolve() == Path(self.target['agent']['executable']).resolve() or inside(snapshot['executable'], self.target['agent']['installRoot']), 'Running agent is outside the configured installation')
        return snapshot

    def node_status(self):
        node_id, session_token = self.node_identity()
        result = http_json(self.target['origin'] + '/api/v2/workspaces/' + self.target['agent']['workspaceId'] + '/nodes', session_token)
        nodes = [node for node in result.get('nodes', []) if node.get('id') == node_id]
        require(len(nodes) == 1, 'Coordinator does not report the saved node identity')
        return nodes[0]

    def node_identity(self):
        state_path = Path(self.target['agent']['workspace']) / 'hosted-state.json'
        assert_private(state_path)
        state = read_json(state_path.read_bytes())
        require(state.get('origin') == self.target['origin'] and state.get('workspaceId') == self.target['agent']['workspaceId'], 'Local node credentials identify a different coordinator/workspace')
        session_path = Path(self.target['userSessionFile'])
        assert_private(session_path)
        session = read_json(session_path.read_bytes())
        require(session.get('origin') == self.target['origin'] and isinstance(session.get('sessionToken'), str), 'Operator session belongs to a different origin')
        require(isinstance(state.get('nodeId'), str) and re.fullmatch(r'[a-f0-9-]{36}', state['nodeId']), 'Invalid saved node ID')
        return state['nodeId'], session['sessionToken']

    def pause_node(self, draining):
        node_id, token = self.node_identity()
        return http_json(self.target['origin'] + '/api/v2/workspaces/' + self.target['agent']['workspaceId'] + '/nodes/' + node_id + '/drain', token, {'draining': draining})

    def resume_node(self, allow_legacy=False):
        marker = Path(self.target['agent']['drainFile'])
        if marker.exists():
            no_links(marker)
            marker.unlink()
        try:
            self.pause_node(False)
        except HttpStatusError as error:
            if not (allow_legacy and error.status == 404):
                raise

    def deploy(self, config):
        environment = safe_environment()
        environment.update({'CLOUDFLARE_API_TOKEN': self.token, 'CLOUDFLARE_ACCOUNT_ID': self.target['accountId'], 'CI': 'true', 'WRANGLER_SEND_METRICS': 'false'})
        with open(Path(self.target['stateDirectory']) / 'wrangler-deploy.log', 'ab') as log:
            result = subprocess.run([self.target['nodePath'], self.target['wranglerPath'], 'deploy', '--config', str(config), '--no-bundle'],
                                    cwd=self.target['stateDirectory'], env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                    creationflags=subprocess.CREATE_NO_WINDOW, timeout=600)
        require(result.returncode == 0, 'Wrangler did not confirm deployment; inspect protected log and reconcile')

    def verify_worker(self, commit):
        deadline = time.monotonic() + self.target.get('timeouts', {}).get('healthSeconds', 120)
        while time.monotonic() < deadline:
            try:
                health = self.worker_health()
                deployment = self.current_deployment()
                if health.get('sourceCommit') == commit and health.get('protocolVersion') == 2 and health.get('deployment') == deployment['versions'][0]['version_id']:
                    return True
            except PromotionError:
                pass
            time.sleep(2)
        return False

    def verify_previous(self, previous):
        deadline = time.monotonic() + self.target.get('timeouts', {}).get('healthSeconds', 120)
        while time.monotonic() < deadline:
            try:
                health = self.worker_health()
                deployment = self.current_deployment()
                if deployment['versions'] == previous['deployment']['versions'] and health.get('deployment') == deployment['versions'][0]['version_id'] and health.get('protocolVersion') == 2:
                    return True
            except PromotionError:
                pass
            time.sleep(2)
        return False

    def process_alive(self, snapshot):
        return bool(snapshot) and process_snapshot(snapshot['pid']) == snapshot

    def drain(self, snapshot):
        require(self.process_alive(snapshot), 'Cannot drain a process whose identity has changed')
        # Keep a real process handle open: PID reuse cannot turn this wait into another process.
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        handle = kernel.OpenProcess(0x1000 | 0x100000 | 1, False, snapshot['pid'])
        require(handle and self.process_alive(snapshot), 'Agent changed before drain')
        try:
            marker = Path(self.target['agent']['drainFile'])
            assert_private(marker.parent)
            self.pause_node(True)
            atomic_bytes(marker, b'Smith explicit promotion drain\n', owner_only=True)
            seconds = self.target.get('timeouts', {}).get('drainSeconds', 300)
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                node = self.node_status()
                require(node.get('draining') is True and 'activeJobId' in node, 'Coordinator did not confirm authoritative drain state')
                exited = kernel.WaitForSingleObject(handle, 0) == 0
                if node['activeJobId'] is None:
                    if exited:
                        code = wintypes.DWORD()
                        require(kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 0, 'Agent exited without acknowledging clean drain')
                    if not exited:
                        # New agents exit on the marker after acknowledging results.
                        # Legacy agents lack that flag: only a server-confirmed idle,
                        # paused node may be stopped through this retained handle.
                        if kernel.WaitForSingleObject(handle, 2000) != 0:
                            require(self.process_alive(snapshot), 'Agent identity changed during drain')
                            require(kernel.TerminateProcess(handle, 0), 'Could not stop the verified idle legacy agent')
                            require(kernel.WaitForSingleObject(handle, 10000) == 0, 'Agent did not exit after verified idle stop')
                        else:
                            code = wintypes.DWORD()
                            require(kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 0, 'Agent exited without acknowledging clean drain')
                    return
                require(not exited, 'Agent exited with an unacknowledged active job; recovery required')
                time.sleep(1)
            raise RecoveryRequired('Drain deadline elapsed; active agent is not killed, reconcile before continuing')
        finally:
            kernel.CloseHandle(handle)

    def start_agent(self, executable):
        no_links(executable)
        marker = Path(self.target['agent']['drainFile'])
        if marker.exists():
            no_links(marker)
            marker.unlink()
        agent = self.target['agent']
        require(self.discover_agent(executable) is None, 'This agent executable is already running; reconcile instead of starting twice')
        command = agent_command(self.target, executable)
        with open(Path(self.target['stateDirectory']) / ('agent-' + uuid.uuid4().hex + '.log'), 'ab') as log:
            process = subprocess.Popen(command, cwd=str(Path(executable).parent), env=safe_environment(), stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        snapshot = process_snapshot(process.pid)
        require(snapshot and Path(snapshot['executable']).resolve() == Path(executable).resolve(), 'Agent exited before its process identity could be recorded')
        atomic_json(Path(agent['pidFile']), snapshot)
        return snapshot

    def verify_agent(self, snapshot, version, since, require_ready=True):
        deadline = time.monotonic() + self.target.get('timeouts', {}).get('healthSeconds', 120)
        while time.monotonic() < deadline:
            if not self.process_alive(snapshot):
                return False
            try:
                node = self.node_status()
                if node.get('active') and (not require_ready or not node.get('draining', False)) and node.get('agentVersion') == version and node.get('lastSeenAt', 0) >= since:
                    return True
            except PromotionError:
                pass
            time.sleep(2)
        return False

    def restore_worker(self, previous):
        response = http_json(self.endpoint, self.token, {'strategy': 'percentage', 'versions': previous['versions'], 'annotations': {'workers/message': 'Smith explicit promotion rollback; no data/schema rollback'}})
        require(response.get('success'), 'Cloudflare did not confirm Worker rollback')

    def discover_agent(self, executable):
        if not executable:
            return None
        # A crash can occur after CreateProcess and before saving its PID. Recover
        # by exact protected version path; ambiguity is never treated as absence.
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.EnumProcesses.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        ids = (wintypes.DWORD * 32768)()
        used = wintypes.DWORD()
        require(psapi.EnumProcesses(ids, ctypes.sizeof(ids), ctypes.byref(used)) and used.value < ctypes.sizeof(ids), 'Cannot enumerate processes for safe recovery')
        matches = []
        expected = Path(executable).resolve()
        for pid in ids[:used.value // ctypes.sizeof(wintypes.DWORD)]:
            snapshot = process_snapshot(pid)
            if snapshot and Path(snapshot['executable']).resolve() == expected:
                matches.append(snapshot)
        require(len(matches) < 2, 'Multiple matching agent processes exist; manual reconciliation required')
        return matches[0] if matches else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan','promote','reconcile','rollback'])
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--candidate', type=Path)
    parser.add_argument('--approve-sha256')
    args = parser.parse_args(argv)
    try:
        target = args.target.absolute()
        if args.command in ('plan', 'promote'):
            require(args.candidate is not None, '--candidate is required')
        if args.command == 'plan':
            result = make_plan(args.candidate, target)
        elif args.command == 'promote':
            result = promote(args.candidate, target, args.approve_sha256)
        elif args.command == 'rollback':
            result = rollback(target, args.approve_sha256)
        else:
            result = reconcile(target)
        print(json.dumps(result, indent=2))
        return 0 if result.get('stage') != 'recovery_required' else 2
    except (PromotionError, OSError, ValueError, KeyError, TypeError) as error:
        print('Promotion stopped: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
