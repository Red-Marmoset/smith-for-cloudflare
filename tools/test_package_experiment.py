import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).with_name("package-experiment.py")


class ExperimentPackageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("package_experiment", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "native"
        self.binary.mkdir()
        self.output = self.root / "package"

    def test_missing_executable_does_not_create_package(self):
        with self.assertRaises(FileNotFoundError):
            self.module.package(self.binary, self.output)
        self.assertFalse(self.output.exists())

    def test_packages_dependencies_and_cloud_hosted_target(self):
        (self.binary / "Smith.exe").write_bytes(b"fixture executable")
        (self.binary / "runtime.dll").write_bytes(b"fixture dependency")
        self.module.package(self.binary, self.output)
        self.assertEqual((self.output / "runtime.dll").read_bytes(), b"fixture dependency")
        target = json.loads((self.output / "target.json").read_text())
        self.assertEqual(target["coordinatorUrl"], "https://exp.redmarmosetstudios.com")
        self.assertEqual(target["coordinatorHosting"], "cloudflare-workers")
        self.assertFalse((self.output / "smith-coordinator.json").exists())
        for name in ("Start-Smith.bat", "Start-Smith.ps1", "start-smith.sh"):
            self.assertIn("exp.redmarmosetstudios.com", (self.output / name).read_text())
        self.assertFalse((self.output / "cloudflared.example.yml").exists())

    def test_rebuild_refuses_runtime_directory_without_touching_it(self):
        (self.binary / "Smith").write_bytes(b"fixture executable")
        self.output.mkdir()
        config = self.output / "smith-coordinator.json"
        config.write_text('{"token":"operator-secret"}')
        with self.assertRaises(ValueError):
            self.module.package(self.binary, self.output)
        self.assertEqual(config.read_text(), '{"token":"operator-secret"}')

    def test_zip_keeps_execute_bits_for_posix_packages(self):
        (self.binary / "Smith").write_bytes(b"fixture mac executable")
        self.module.package(self.binary, self.output)
        archive = self.root / "smith-experiment-mac.zip"
        self.module.zip_package(self.output, archive)
        with zipfile.ZipFile(archive) as z:
            names = set(z.namelist())
            self.assertIn("Smith", names)
            self.assertIn("start-smith.sh", names)
            self.assertNotIn("Smith.exe", names)
            modes = {i.filename: (i.external_attr >> 16) & 0o777 for i in z.infolist()}
            self.assertEqual(modes["Smith"], 0o755)
            self.assertEqual(modes["start-smith.sh"], 0o755)
            self.assertEqual(modes["target.json"], 0o644)
            self.assertEqual(z.read("Smith"), b"fixture mac executable")
        with self.assertRaises(ValueError):
            self.module.zip_package(self.output, self.output / "inside.zip")

    def test_release_identity_and_update_manifest(self):
        import hashlib
        (self.binary / "Smith.exe").write_bytes(b"fixture executable")
        commit = "1234567890abcdef1234567890abcdef12345678"
        self.module.package(self.binary, self.output, commit=commit)
        identity = json.loads((self.output / "release-info.json").read_text())
        self.assertEqual(identity["commit"], commit)
        self.assertEqual(identity["sha256"], hashlib.sha256(b"fixture executable").hexdigest())
        self.assertEqual(identity["os"], "windows")
        archive = self.root / "smith-experiment-windows.zip"
        self.module.zip_package(self.output, archive)
        manifest = json.loads(self.module.write_manifest(archive).read_text())
        self.assertEqual(manifest["version"], "hosted-1234567890ab")
        self.assertEqual(manifest["os"], "windows")
        self.assertEqual(manifest["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(manifest["size"], archive.stat().st_size)
        # A zip whose identity does not describe its binary is refused.
        tampered = self.root / "tampered.zip"
        with zipfile.ZipFile(archive) as source, zipfile.ZipFile(tampered, "w") as out:
            for name in source.namelist():
                out.writestr(name, b"other bytes" if name == "Smith.exe" else source.read(name))
        with self.assertRaises(ValueError):
            self.module.write_manifest(tampered)

    def test_same_output_as_binary_directory_is_rejected(self):
        (self.binary / "Smith").write_bytes(b"fixture executable")
        with self.assertRaises(ValueError):
            self.module.package(self.binary, self.binary)


if __name__ == "__main__":
    unittest.main()
