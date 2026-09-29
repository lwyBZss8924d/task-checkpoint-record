import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('client_plugins', Path(__file__).with_name('client-plugins.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


def fixture(root):
    result = {'schema_version': 'task-checkpoint-record.release-bundle.v1'}
    for key, name, prefix, commit in [('recorder', 'task-checkpoint-record', '', 'a' * 40), ('helper', 'ultrafast-atif-helper', 'vendor/ultrafast-atif-helper/', 'b' * 40)]:
        version = '0.1.0' if key == 'recorder' else '0.2.0'
        values = {'package.json': json.dumps({'name': name, 'version': version}).encode(),
                  'LICENSE': b'MIT License\nPermission is hereby granted'}
        rows = []
        for path, data in values.items():
            p = root / (prefix + path); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data); p.chmod(0o644)
            rows.append({'path': prefix + path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mode': 0o644})
        result[key] = {'name': name, 'version': version, 'root': prefix[:-1] if prefix else '.',
                       'source': {'repository': 'https://github.com/lwyBZss8924d/' + name, 'commit': commit},
                       'license': {'spdx': 'MIT', 'path': prefix + 'LICENSE', 'sha256': hashlib.sha256(values['LICENSE']).hexdigest()}, 'files': rows}
    return write_manifest(root, result), result


def write_manifest(root, value):
    data = json.dumps(value).encode(); (root / 'release-bundle.json').write_bytes(data)
    return hashlib.sha256(data).hexdigest()


class ClientPluginBoundaries(unittest.TestCase):
    def test_plain_python_help_preserves_exact_source_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, manifest = fixture(root)
            for name in ('client-plugins.py', 'bundle.py', 'package.py'):
                relative = 'scripts/distribution/' + name
                data = Path(__file__).with_name(name).read_bytes()
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data); target.chmod(0o644)
                manifest['recorder']['files'].append({'path': relative, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mode': 0o644})
            digest = write_manifest(root, manifest)
            client.verify_bundle(root, digest)
            before = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in root.rglob('*') if p.is_file()}
            environment = dict(os.environ)
            environment.pop('PYTHONDONTWRITEBYTECODE', None)
            environment.pop('PYTHONPYCACHEPREFIX', None)
            result = subprocess.run([sys.executable, 'scripts/distribution/client-plugins.py', '--help'],
                                    cwd=root, env=environment, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            after = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in root.rglob('*') if p.is_file()}
            self.assertEqual(after, before)
            self.assertFalse(list(root.rglob('__pycache__')))
            client.verify_bundle(root, digest)

    def test_verified_inventory_accepts_and_unlisted_private_file_rejects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); digest, _ = fixture(root)
            manifest, payload = client.verify_bundle(root, digest)
            self.assertEqual(set(payload), {'recorder', 'helper'})
            (root / 'auth.json').write_text('SYNTHETIC_PRIVATE_NOT_READ')
            with self.assertRaisesRegex(ValueError, 'release_inventory_not_exact'):
                client.verify_bundle(root, digest)

    def test_changed_source_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); digest, _ = fixture(root)
            (root / 'LICENSE').write_text('different bytes')
            with self.assertRaisesRegex(ValueError, 'release_inventory_changed'):
                client.verify_bundle(root, digest)

    def test_source_link_is_rejected_before_following(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); digest, _ = fixture(root)
            (root / 'package.json').unlink(); (root / 'package.json').symlink_to(root / 'LICENSE')
            with self.assertRaisesRegex(ValueError, 'bundle_symlink'):
                client.verify_bundle(root, digest)

    def test_version_cannot_escape_artifact_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, manifest = fixture(root)
            manifest['recorder']['version'] = '../../outside'
            digest = write_manifest(root, manifest)
            with self.assertRaisesRegex(ValueError, 'release_component_source'):
                client.verify_bundle(root, digest)

    def test_inventory_rejects_boolean_file_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, manifest = fixture(root)
            manifest['recorder']['files'][0]['mode'] = True
            digest = write_manifest(root, manifest)
            with self.assertRaisesRegex(ValueError, 'release_inventory_type'):
                client.verify_bundle(root, digest)

    def test_current_native_overlay_contracts_and_no_timeout_boolean(self):
        repo = Path(__file__).resolve().parents[2]
        version = json.loads((repo / 'package.json').read_text())['version']
        paths = [p for p in (repo / 'integrations/plugins').rglob('*') if p.is_file()]
        payload = {p.relative_to(repo).as_posix(): (p.read_bytes(), 0o644) for p in paths}
        for name in ('codex', 'claude'):
            overlay = client.overlay_files(name, payload, version)
            self.assertIn('hooks/hooks.json', overlay)
        path = 'integrations/plugins/codex/task-checkpoint-record/hooks/hooks.json'
        hooks = json.loads(payload[path][0]); hooks['hooks']['Stop'][0]['hooks'][0]['timeout'] = True
        payload[path] = (json.dumps(hooks).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, 'client_hook_not_bounded_command'):
            client.overlay_files('codex', payload, version)

    def test_expected_markers_do_not_authorize_an_extra_shell_action(self):
        repo = Path(__file__).resolve().parents[2]
        version = json.loads((repo / 'package.json').read_text())['version']
        payload = {p.relative_to(repo).as_posix(): (p.read_bytes(), 0o644)
                   for p in (repo / 'integrations/plugins').rglob('*') if p.is_file()}
        path = 'integrations/plugins/codex/task-checkpoint-record/hooks/hooks.json'
        hooks = json.loads(payload[path][0]); hooks['hooks']['Stop'][0]['hooks'][0]['command'] += '; echo unexpected'
        payload[path] = (json.dumps(hooks).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, 'client_hook_command_not_reviewed'):
            client.overlay_files('codex', payload, version)


if __name__ == '__main__':
    unittest.main()
