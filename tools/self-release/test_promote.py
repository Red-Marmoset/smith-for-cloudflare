"""Promotion safety tests. External Cloudflare/process effects use a fake adapter."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import warnings
from unittest.mock import patch
import zipfile
import urllib.error

MODULE = Path(__file__).with_name('promote.py')
spec = importlib.util.spec_from_file_location('smith_promote', MODULE)
p = importlib.util.module_from_spec(spec) if MODULE.exists() else None
if p:
    spec.loader.exec_module(p)

SHA = 'a' * 40
OLD_SHA = 'b' * 40
ORIGIN = 'https://smith.example.test'

def digest(data):
    return hashlib.sha256(data).hexdigest()

class FakeAdapter:
    def __init__(self):
        self.actions = []
        self.commit = OLD_SHA
        self.version = '11111111-1111-4111-8111-111111111111'
        self.fail_deploy = False
        self.fail_worker = False
        self.fail_agent = False
        self.paused = False
        self.process = {'pid': 101, 'created': 'original-process', 'executable': ''}

    def current_deployment(self):
        return {'id': 'deployment-' + self.version, 'versions': [{'version_id': self.version, 'percentage': 100}]}

    def worker_health(self):
        return {'sourceCommit': self.commit, 'protocolVersion': 2, 'deployment': self.version}

    def current_agent(self):
        return dict(self.process)

    def node_status(self):
        return {'agentVersion': 'hosted-' + OLD_SHA[:12], 'lastSeenAt': 100, 'active': True}

    def deploy(self, config):
        self.actions.append('deploy')
        self.commit = SHA
        self.version = '22222222-2222-4222-8222-222222222222'
        if self.fail_deploy:
            raise TimeoutError('response lost after remote acceptance')

    def verify_worker(self, commit):
        return self.commit == commit and not (self.fail_worker and commit == SHA)

    def verify_previous(self, previous):
        return self.current_deployment()['versions'] == previous['deployment']['versions']

    def resume_node(self, allow_legacy=False):
        self.actions.append('resume')
        self.paused = False

    def drain(self, process):
        self.actions.append('drain')
        self.paused = True
        self.process = None

    def start_agent(self, executable):
        self.actions.append('start')
        self.process = {'pid': 202, 'created': 'replacement-process', 'executable': str(executable)}
        return dict(self.process)

    def verify_agent(self, process, version, since, require_ready=True):
        return not (self.fail_agent and version == 'hosted-' + SHA[:12]) and (not require_ready or not self.paused)

    def restore_worker(self, previous):
        self.actions.append('restore-worker')
        self.version = previous['versions'][0]['version_id']
        self.commit = OLD_SHA

    def process_alive(self, process):
        return self.process == process

    def discover_agent(self, executable):
        return self.process if self.process and self.process['executable'] == str(executable) else None

class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(p, 'Standalone promotion module has not been implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['state', 'install', 'workspace', 'old', 'trusted']:
            (self.root / name).mkdir(mode=0o700)
        self.old = self.root / 'old' / 'Smith.exe'
        self.old.write_bytes(b'old agent')
        (self.root / 'old' / 'runtime.dll').write_bytes(b'old dependency')
        for name in ['node.exe', 'wrangler.js']:
            (self.root / 'trusted' / name).write_bytes(b'trusted tool')
        self.config = {'name': 'smith-target', 'account_id': '1' * 32, 'main': 'src/index.ts',
                       'compatibility_date': '2026-10-04', 'compatibility_flags': ['nodejs_compat'],
                       'vars': {'ORIGIN': ORIGIN}, 'routes': [{'pattern': 'smith.example.test', 'custom_domain': True}],
                       'assets': {'directory': 'public', 'binding': 'ASSETS', 'run_worker_first': True},
                       'durable_objects': {'bindings': [{'name': 'WORKSPACES', 'class_name': 'WorkspaceCoordinator'}]},
                       'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['WorkspaceCoordinator']}],
                       'd1_databases': [{'binding': 'DB', 'database_name': 'identity', 'database_id': 'real-database', 'migrations_dir': 'migrations'}]}
        (self.root / 'trusted' / 'wrangler.json').write_text(json.dumps(self.config))
        (self.root / 'state' / 'tester.json').write_text(json.dumps({'sessionToken': 'test-only', 'origin': ORIGIN}))
        (self.root / 'state' / 'agent.pid').write_text('101')
        self.target = {'schemaVersion': 1, 'origin': ORIGIN, 'workerName': 'smith-target', 'accountId': '1' * 32,
                       'nodePath': str(self.root / 'trusted' / 'node.exe'), 'wranglerPath': str(self.root / 'trusted' / 'wrangler.js'),
                       'wranglerConfig': str(self.root / 'trusted' / 'wrangler.json'), 'stateDirectory': str(self.root / 'state'),
                       'migrationHashes': {'0001.sql': digest(b'CREATE TABLE test (id TEXT);')}, 'userSessionFile': str(self.root / 'state' / 'tester.json'),
                       'agent': {'executable': str(self.old), 'workspace': str(self.root / 'workspace'), 'workspaceId': 'f' * 64,
                                 'labels': ['una-engine'], 'pidFile': str(self.root / 'state' / 'agent.pid'),
                                 'drainFile': str(self.root / 'workspace' / 'drain'), 'installRoot': str(self.root / 'install')}}
        self.target_path = self.root / 'state' / 'target.json'
        self.target_path.write_text(json.dumps(self.target))
        self.files = {'agent/Smith.exe': b'new agent', 'coordinator/index.js': b'export default {};',
                      'coordinator/public/index.html': b'hello', 'coordinator/migrations/0001.sql': b'CREATE TABLE test (id TEXT);',
                      'coordinator/wrangler.json': json.dumps(self.config).encode()}
        self.manifest = {'schemaVersion': 1, 'repository': 'git@github.com:owner/fork.git', 'branch': 'feature/release', 'commit': SHA,
                         'protocolVersion': 2, 'coordinatorOrigin': ORIGIN,
                         'components': {'agent': {'executable': 'agent/Smith.exe'}, 'coordinator': {'main': 'coordinator/index.js', 'assets': 'coordinator/public'}}}
        self.files['agent/release-info.json'] = json.dumps({**{k: self.manifest[k] for k in ['schemaVersion','repository','branch','commit','protocolVersion','coordinatorOrigin']}, 'sha256': digest(self.files['agent/Smith.exe'])}).encode()
        self.archive = self.root / 'candidate.zip'
        self.write_archive()
        self.adapter = FakeAdapter()
        self.adapter.process['executable'] = str(self.old)
        # ACL inspection is an OS boundary; state machine and filesystem operations remain real.
        self.security = patch.object(p, 'assert_private', return_value=None)
        self.security.start()
        self.addCleanup(self.security.stop)

    def write_archive(self, additions=None, manifest=None):
        payload = dict(self.files)
        if additions:
            payload.update(additions)
        meta = copy.deepcopy(manifest or self.manifest)
        meta['files'] = [{'path': name, 'sha256': digest(data), 'size': len(data)} for name, data in sorted(payload.items())]
        with zipfile.ZipFile(self.archive, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('manifest.json', json.dumps(meta))
            for name, data in payload.items():
                z.writestr(name, data)

    def promote(self, approved=None):
        return p.promote(self.archive, self.target_path, approved or digest(self.archive.read_bytes()), self.adapter)

    def test_plan_is_read_only_and_names_exact_identity(self):
        before = sorted(str(f) for f in self.root.rglob('*'))
        result = p.make_plan(self.archive, self.target_path)
        self.assertEqual(result['archiveSha256'], digest(self.archive.read_bytes()))
        self.assertEqual(result['commit'], SHA)
        self.assertEqual(result['workerName'], 'smith-target')
        self.assertEqual(before, sorted(str(f) for f in self.root.rglob('*')))

    def test_unapproved_digest_causes_no_execution_or_filesystem_mutation(self):
        before = sorted(str(f) for f in self.root.rglob('*'))
        with self.assertRaises(p.PromotionError):
            self.promote('0' * 64)
        self.assertEqual(self.adapter.actions, [])
        self.assertEqual(before, sorted(str(f) for f in self.root.rglob('*')))

    def test_archive_rejects_traversal_case_alias_extra_and_hash_tampering(self):
        for name in ['../outside', 'agent/../outside', 'agent/SMITH.exe', 'agent/con.dll', 'unapproved.exe', 'coordinator/public/a:stream']:
            with self.subTest(name=name):
                self.write_archive({name: b'bad'})
                with self.assertRaises(p.PromotionError):
                    p.make_plan(self.archive, self.target_path)
        self.write_archive()
        with warnings.catch_warnings(), zipfile.ZipFile(self.archive, 'a') as z:
            warnings.simplefilter('ignore', UserWarning)
            z.writestr('agent/Smith.exe', b'changed')
        with self.assertRaises(p.PromotionError):
            p.make_plan(self.archive, self.target_path)

    def test_resource_shape_and_migrations_cannot_change(self):
        self.files['coordinator/migrations/0001.sql'] = b'DROP TABLE test;'
        self.write_archive()
        with self.assertRaises(p.PromotionError):
            p.make_plan(self.archive, self.target_path)
        self.files['coordinator/migrations/0001.sql'] = b'CREATE TABLE test (id TEXT);'
        changed = copy.deepcopy(self.config)
        changed['durable_objects']['bindings'][0]['class_name'] = 'DifferentClass'
        self.files['coordinator/wrangler.json'] = json.dumps(changed).encode()
        self.write_archive()
        with self.assertRaises(p.PromotionError):
            p.make_plan(self.archive, self.target_path)

    def test_approved_success_preserves_previous_and_duplicate_never_redeploys(self):
        result = self.promote()
        self.assertEqual(result['stage'], 'complete')
        self.assertEqual(self.old.read_bytes(), b'old agent')
        self.assertEqual(Path(result['previous']['agentExecutable']).read_bytes(), b'old agent')
        generated = json.loads(Path(result['generatedConfig']).read_text())
        self.assertEqual(generated['d1_databases'][0]['database_id'], 'real-database')
        self.assertEqual(generated['vars']['RELEASE_SHA'], SHA)
        before = list(self.adapter.actions)
        self.assertEqual(self.promote()['stage'], 'complete')
        self.assertEqual(self.adapter.actions, before)

    def test_lost_deployment_response_requires_reconciliation_not_blind_retry(self):
        self.adapter.fail_deploy = True
        with self.assertRaises(p.RecoveryRequired):
            self.promote()
        self.assertEqual(self.adapter.actions, ['deploy'])
        with self.assertRaises(p.RecoveryRequired):
            self.promote()
        self.assertEqual(self.adapter.actions, ['deploy'])
        result = p.reconcile(self.target_path, self.adapter)
        self.assertEqual(result['stage'], 'recovery_required')
        self.assertEqual(result['observed']['workerCommit'], SHA)
        self.assertEqual(self.adapter.actions, ['deploy'])

    def test_failed_worker_health_restores_previous_before_touching_agent(self):
        self.adapter.fail_worker = True
        with self.assertRaises(p.PromotionError):
            self.promote()
        journal = json.loads((self.root / 'state' / 'promotion.json').read_text())
        self.assertEqual(journal['stage'], 'rolled_back')
        self.assertEqual(self.adapter.actions, ['deploy', 'restore-worker'])

    def test_failed_new_agent_health_restores_previous_worker_and_agent(self):
        self.adapter.fail_agent = True
        with self.assertRaises(p.PromotionError):
            self.promote()
        journal = json.loads((self.root / 'state' / 'promotion.json').read_text())
        self.assertEqual(journal['stage'], 'rolled_back')
        self.assertEqual(self.adapter.commit, OLD_SHA)
        self.assertEqual(self.adapter.process['executable'], journal['previous']['agentExecutable'])

    def test_interruption_after_durable_deploy_intent_does_not_repeat(self):
        def interrupt(config):
            raise KeyboardInterrupt()
        self.adapter.deploy = interrupt
        with self.assertRaises(KeyboardInterrupt):
            self.promote()
        journal = json.loads((self.root / 'state' / 'promotion.json').read_text())
        self.assertEqual(journal['stage'], 'deploying')
        with self.assertRaises(p.RecoveryRequired):
            self.promote()

    def test_bootstrap_can_restore_old_worker_that_did_not_report_source_commit(self):
        original_health = self.adapter.worker_health
        def legacy_health():
            result = original_health()
            if self.adapter.commit == OLD_SHA:
                result.pop('sourceCommit')
            return result
        self.adapter.worker_health = legacy_health
        self.adapter.fail_agent = True
        with self.assertRaises(p.PromotionError):
            self.promote()
        self.assertIn('deploy', self.adapter.actions)
        journal = json.loads((self.root / 'state' / 'promotion.json').read_text())
        self.assertEqual(journal['stage'], 'rolled_back')
        self.assertIsNone(journal['previous']['workerCommit'])

    def test_new_agent_claims_resume_only_after_start_and_before_health_gate(self):
        self.promote()
        self.assertEqual(self.adapter.actions, ['deploy', 'drain', 'start', 'resume'])

    def test_agent_environment_drops_operator_cloud_credentials(self):
        with patch.dict('os.environ', {'CLOUDFLARE_API_TOKEN': 'secret', 'CF_API_KEY': 'secret', 'AWS_SECRET_ACCESS_KEY': 'secret', 'UNA_ENGINE_PATH': 'C:/engine', 'SMITH_RELEASE_BRANCH': 'feature/customer-build', 'SMITH_COORDINATOR_URL': ORIGIN}):
            environment = p.safe_environment()
        self.assertNotIn('CLOUDFLARE_API_TOKEN', environment)
        self.assertNotIn('CF_API_KEY', environment)
        self.assertNotIn('AWS_SECRET_ACCESS_KEY', environment)
        self.assertEqual(environment['UNA_ENGINE_PATH'], 'C:/engine')
        self.assertEqual(environment.get('SMITH_RELEASE_BRANCH'), 'feature/customer-build')
        self.assertEqual(environment.get('SMITH_COORDINATOR_URL'), ORIGIN)

    def test_legacy_restart_omits_unsupported_drain_flag(self):
        self.assertNotIn('--drain-file', p.agent_command(self.target, self.old))
        (self.old.parent / 'release-info.json').write_text('{}')
        command = p.agent_command(self.target, self.old)
        self.assertIn('--drain-file', command)
        self.assertEqual(command[1], 'hosted-agent')

    def test_symlink_zip_and_size_limits_fail_before_staging(self):
        self.write_archive()
        with zipfile.ZipFile(self.archive, 'a') as archive:
            entry = zipfile.ZipInfo('coordinator/public/link')
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, '../outside')
        with self.assertRaises(p.PromotionError):
            self.promote()
        self.assertFalse((self.root / 'state' / 'promotion.json').exists())
        self.write_archive()
        with patch.object(p, 'MAX_FILE', 1):
            with self.assertRaises(p.PromotionError):
                self.promote()

    def test_lock_prevents_concurrent_promotions(self):
        with p.Lock(self.root / 'state' / 'promotion.lock'):
            with self.assertRaises(p.RecoveryRequired):
                self.promote()
        self.assertEqual(self.adapter.actions, [])

    def test_lost_resume_does_not_reconcile_a_paused_agent_as_complete(self):
        def lost_resume(allow_legacy=False):
            raise TimeoutError('resume did not arrive')
        self.adapter.resume_node = lost_resume
        with self.assertRaises(p.RecoveryRequired):
            self.promote()
        result = p.reconcile(self.target_path, self.adapter)
        self.assertEqual(result['stage'], 'recovery_required')

    def test_unhealthy_candidate_is_not_given_claims_before_health_gate(self):
        original = self.adapter.verify_agent
        def health(process, version, since, require_ready=True):
            if version == 'hosted-' + SHA[:12]:
                self.assertNotIn('resume', self.adapter.actions)
                return False
            return original(process, version, since, require_ready)
        self.adapter.verify_agent = health
        with self.assertRaises(p.PromotionError):
            self.promote()

    def test_reconcile_adopts_backup_started_before_journal_write(self):
        self.promote()
        journal_path = self.root / 'state' / 'promotion.json'
        journal = json.loads(journal_path.read_text())
        self.adapter.restore_worker(journal['previous']['deployment'])
        self.adapter.process = {'pid': 303, 'created': 'restored-process', 'executable': journal['previous']['agentExecutable']}
        journal['stage'] = 'rollback_agent_starting'
        journal_path.write_text(json.dumps(journal))
        result = p.reconcile(self.target_path, self.adapter)
        self.assertEqual(result['stage'], 'rolled_back')
        self.assertEqual(result['restoredProcess']['pid'], 303)

    def test_reconcile_never_calls_a_live_but_unhealthy_old_agent_recovered(self):
        self.promote()
        journal = json.loads((self.root / 'state' / 'promotion.json').read_text())
        self.adapter.restore_worker(journal['previous']['deployment'])
        self.adapter.process = journal['previous']['agentProcess']
        self.adapter.verify_agent = lambda *args, **kwargs: False
        self.assertEqual(p.reconcile(self.target_path, self.adapter)['stage'], 'recovery_required')

    def test_repeated_reconcile_cannot_adopt_external_deployment_with_same_commit(self):
        approved = self.promote()
        versions = copy.deepcopy(approved['newDeployment']['versions'])
        self.adapter.version = '33333333-3333-4333-8333-333333333333'
        for _ in range(2):
            observed = p.reconcile(self.target_path, self.adapter)
            self.assertEqual(observed['stage'], 'recovery_required')
            self.assertEqual(observed['newDeployment']['versions'], versions)
        actions = list(self.adapter.actions)
        with self.assertRaises(p.PromotionError):
            p.rollback(self.target_path, approved['archiveSha256'], self.adapter)
        self.assertEqual(self.adapter.actions, actions)

    def test_http_requests_identify_the_promoter_instead_of_blocked_python_default(self):
        class Edge:
            def open(self, request, timeout):
                if request.get_header('User-agent') != 'Smith-Promoter/1.0':
                    raise urllib.error.HTTPError(request.full_url, 403, 'blocked client', {}, None)
                return io.BytesIO(b'{"healthy":true}')
        with patch.object(p.urllib.request, 'build_opener', return_value=Edge()):
            self.assertEqual(p.http_json(ORIGIN + '/health'), {'healthy': True})

if __name__ == '__main__':
    unittest.main()
