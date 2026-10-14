import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release_package', Path(__file__).with_name('package.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'native'
        self.bundle = self.root / 'bundle'
        self.coordinator = self.root / 'cloudflare' / 'coordinator'
        for directory in (self.binary, self.bundle, self.coordinator / 'public', self.coordinator / 'migrations'):
            directory.mkdir(parents=True)
        (self.binary / 'Smith.exe').write_bytes(b'MZ fixture executable')
        (self.binary / 'runtime.dll').write_bytes(b'fixture DLL')
        (self.binary / 'operator-secret.json').write_text('never package runtime identity')
        (self.bundle / 'index.js').write_text('export default {fetch(){ return new Response("ok") }};')
        (self.bundle / 'index.js.map').write_text('ignored sourcemap')
        (self.coordinator / 'public' / 'index.html').write_text('<h1>Smith</h1>')
        (self.coordinator / 'migrations' / '0001_identity.sql').write_text('CREATE TABLE users(id TEXT);')
        (self.coordinator / 'wrangler.jsonc').write_text('{ // comment\n"name":"customer-worker", "main":"src/index.ts", "vars":{"ORIGIN":"https://customer.example"}, }')
        self.output = self.root / 'output' / 'smith-release.zip'
        self.arguments = dict(repo_root=self.root, binary_dir=self.binary, bundle_dir=self.bundle, output=self.output,
                              repository='https://github.com/customer/smith.git', branch='release/candidate',
                              commit='a' * 40, coordinator_origin='https://customer.example')

    def build(self, **changes):
        return release.package_release(**(self.arguments | changes))

    def test_inventory_identity_and_no_runtime_secrets(self):
        digest = self.build()
        self.assertEqual(digest, hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(self.output.with_suffix('.zip.sha256').read_text(), f'{digest}  smith-release.zip\n')
        with zipfile.ZipFile(self.output) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['commit'], 'a' * 40)
            self.assertEqual(manifest['repository'], self.arguments['repository'])
            self.assertEqual(manifest['branch'], 'release/candidate')
            self.assertEqual(manifest['coordinatorOrigin'], 'https://customer.example')
            self.assertEqual(manifest['components'], {'agent': {'executable': 'agent/Smith.exe'}, 'coordinator': {'main': 'coordinator/index.js', 'assets': 'coordinator/public'}})
            self.assertEqual(set(archive.namelist()), {'manifest.json'} | {item['path'] for item in manifest['files']})
            for item in manifest['files']:
                payload = archive.read(item['path'])
                self.assertEqual(item['size'], len(payload))
                self.assertEqual(item['sha256'], hashlib.sha256(payload).hexdigest())
            info = json.loads(archive.read('agent/release-info.json'))
            self.assertEqual(info['sha256'], hashlib.sha256(archive.read('agent/Smith.exe')).hexdigest())
            self.assertEqual(info['commit'], manifest['commit'])
            config = json.loads(archive.read('coordinator/wrangler.json'))
            self.assertEqual(config['name'], 'customer-worker')
            self.assertNotIn('agent/operator-secret.json', archive.namelist())
            self.assertNotIn('coordinator/index.js.map', archive.namelist())
            self.assertNotIn('redmarmoset', archive.read('agent/Start-Smith.ps1').decode().lower())
            launcher = archive.read('agent/Start-Smith.cmd').decode('ascii')
            self.assertIn('--coordinator https://customer.example ', launcher)
            self.assertNotIn('redmarmoset', launcher.lower())
            self.assertTrue(launcher.endswith('\r\n') and '\n' not in launcher.replace('\r\n', ''))

    def test_zip_reproducible_despite_mtimes_and_creation_order(self):
        first = self.build()
        import os
        for path in (self.binary / 'Smith.exe', self.coordinator / 'public' / 'index.html'):
            os.utime(path, (1800000000, 1800000000))
        second = self.build(output=self.root / 'second.zip')
        self.assertEqual(first, second)
        self.assertEqual(self.output.read_bytes(), (self.root / 'second.zip').read_bytes())

    def test_payload_change_changes_digest_and_inventory(self):
        original = self.build()
        (self.coordinator / 'public' / 'index.html').write_text('<h1>Changed</h1>')
        self.assertNotEqual(original, self.build())

    def test_rejects_invalid_source_and_origin_metadata_before_output(self):
        invalid = [dict(commit='abc123'), dict(commit='g' * 40), dict(branch=''), dict(branch='../main'),
                   dict(branch='main\nother'), dict(repository='https://token@github.com/team/smith.git'),
                   dict(repository='file:///tmp/repo'), dict(coordinator_origin='http://customer.example'),
                   dict(coordinator_origin='https://customer.example/path'), dict(coordinator_origin='https://customer.example?x=1'),
                   dict(coordinator_origin='https://user:password@customer.example'),
                   dict(coordinator_origin='https://a%26calc.example')]  # valid URL, unsafe inside cmd.exe
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.build(**changes)
        self.assertFalse(self.output.exists())

    def test_missing_inputs_and_unbundled_modules_fail_closed(self):
        (self.bundle / 'extra.wasm').write_bytes(b'unsupported module')
        with self.assertRaises(ValueError): self.build()
        (self.bundle / 'extra.wasm').unlink()
        (self.binary / 'Smith.exe').unlink()
        with self.assertRaises(FileNotFoundError): self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_symlink_payload_and_source_file_as_output(self):
        with self.assertRaises(ValueError): self.build(output=self.binary / 'Smith.exe')
        target = self.root / 'outside.txt'
        target.write_text('not a release input')
        link = self.coordinator / 'public' / 'linked.txt'
        try: link.symlink_to(target)
        except OSError: self.skipTest('Symlink creation is not available on this host')
        with self.assertRaises(ValueError): self.build()
        self.assertFalse(self.output.exists())

    def test_rejects_case_collisions_and_unsafe_archive_paths(self):
        for name in ('../escape', '/absolute', 'a\\b', 'a:b', 'a/CON.txt', 'a/name.', 'a//b'):
            with self.subTest(name=name), self.assertRaises(ValueError): release.safe_archive_path(name)
        self.assertEqual(release.safe_archive_path('coordinator/public/index.html'), 'coordinator/public/index.html')
        payload = {'agent/Smith.exe': b'a', 'agent/smith.exe': b'b'}
        with self.assertRaises(ValueError): release.check_payload(payload)

    def test_rejects_oversize_without_replacing_existing_candidate(self):
        self.build()
        before = self.output.read_bytes()
        old_limit = release.MAX_FILE_BYTES
        release.MAX_FILE_BYTES = 4
        try:
            with self.assertRaises(ValueError): self.build()
        finally: release.MAX_FILE_BYTES = old_limit
        self.assertEqual(self.output.read_bytes(), before)

    def test_jsonc_preserves_comments_and_commas_inside_strings(self):
        parsed = release.parse_jsonc('{/*comment*/"url":"https://a/b//c", "text":"quote\\\" , }", "a":[1,2,],}')
        self.assertEqual(parsed, {'url': 'https://a/b//c', 'text': 'quote" , }', 'a': [1, 2]})


if __name__ == '__main__':
    unittest.main()
