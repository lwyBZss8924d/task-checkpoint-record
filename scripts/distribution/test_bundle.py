import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from bundle import committed_files, component, suite_files


def fixture_files():
    name = 'task-checkpoint-record'
    identity = json.dumps({'name': name, 'version': '0.1.0'}).encode()
    portable = json.dumps({'$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name, 'version': '0.1.0'}).encode()
    compat = json.dumps({'name': name, 'version': '0.1.0', 'skills': './skills/'}).encode()
    return {'package.json': (identity, 0o644), 'plugin.json': (portable, 0o644),
            '.codex-plugin/plugin.json': (compat, 0o644),
            'skills/task-checkpoint-record/SKILL.md': (b'---\nname: task-checkpoint-record\n---\nSynthetic fixture', 0o644),
            'LICENSE': (b'MIT License\nPermission is hereby granted', 0o644),
            **{p: (b'Synthetic fixture', 0o644) for p in ('README.md', 'AGENTS.md', 'SPEC.md', 'llms.txt', 'Dockerfile', '.dockerignore')}}


class BundleBoundaryTests(unittest.TestCase):
    def test_release_manifest_binds_all_bytes_and_permissions(self):
        files = fixture_files()
        result = component('task-checkpoint-record', 'a' * 40, '.', files)
        self.assertEqual(len(result['files']), 11)
        self.assertEqual(result['source']['commit'], 'a' * 40)
        self.assertEqual(result['license']['path'], 'LICENSE')
        self.assertTrue(all(x['mode'] == 420 and len(x['sha256']) == 64 for x in result['files']))

    def test_legacy_auto_hook_is_not_a_releasable_plugin(self):
        files = fixture_files(); files['hooks/hooks.json'] = (b'{}', 0o644)
        with self.assertRaisesRegex(ValueError, 'unexpected_plugin_activation'):
            component('task-checkpoint-record', 'a' * 40, '.', files)

    def test_branch_or_short_hash_is_not_a_release_source(self):
        with self.assertRaisesRegex(ValueError, 'full_commit_required'):
            committed_files(Path('.'), 'main')

    def test_committed_symlink_is_rejected_before_blob_read(self):
        outputs = [b'commit\n', b'120000 blob ' + b'b' * 40 + b'\tsrc/escape.ts\0']
        with patch('bundle.git', side_effect=outputs) as call:
            with self.assertRaisesRegex(ValueError, 'unsafe_committed_public_entry'):
                committed_files(Path('.'), 'a' * 40)
            self.assertEqual(call.call_count, 2)

    def test_committed_nested_private_directory_rejected_before_read(self):
        outputs = [b'commit\n', b'100644 blob ' + b'b' * 40 + b'\tdocs/.local/checkpoint.md\0']
        with patch('bundle.git', side_effect=outputs) as call:
            with self.assertRaisesRegex(ValueError, 'private_committed_public_entry'):
                committed_files(Path('.'), 'a' * 40)
            self.assertEqual(call.call_count, 2)

    def test_active_compatibility_hook_is_rejected(self):
        files = fixture_files()
        compat = json.loads(files['.codex-plugin/plugin.json'][0]); compat['hooks'] = './external-hooks.json'
        files['.codex-plugin/plugin.json'] = (json.dumps(compat).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, 'unexpected_auto_activation_manifest'):
            component('task-checkpoint-record', 'a' * 40, '.', files)

    def test_portable_extension_cannot_activate_a_hook(self):
        files = fixture_files()
        portable = json.loads(files['plugin.json'][0]); portable['extensions'] = {'com.openai': {'hooks': './external-hooks.json'}}
        files['plugin.json'] = (json.dumps(portable).encode(), 0o644)
        with self.assertRaisesRegex(ValueError, 'unexpected_portable_extension'):
            component('task-checkpoint-record', 'a' * 40, '.', files)

    def test_missing_required_document_is_rejected(self):
        files = fixture_files(); del files['SPEC.md']
        with self.assertRaisesRegex(ValueError, 'required_distribution_file_missing'):
            component('task-checkpoint-record', 'a' * 40, '.', files)

    def test_suite_contains_two_committed_skills_and_a_local_catalog(self):
        record = fixture_files()
        helper = {path.replace('task-checkpoint-record', 'ultrafast-atif-helper'): (data, mode)
                  for path, (data, mode) in record.items()}
        for path in ('package.json', 'plugin.json', '.codex-plugin/plugin.json'):
            doc = json.loads(helper[path][0]); doc['name'] = 'ultrafast-atif-helper'; doc['version'] = '0.2.0'
            helper[path] = (json.dumps(doc).encode(), 0o644)
        manifest = {'recorder': component('task-checkpoint-record', 'a' * 40, '.', record),
                    'helper': component('ultrafast-atif-helper', 'b' * 40, 'vendor/ultrafast-atif-helper', helper)}
        plugin, catalog = suite_files(manifest, record, helper)
        self.assertIn('skills/task-checkpoint-record/SKILL.md', plugin)
        self.assertIn('skills/ultrafast-atif-helper/SKILL.md', plugin)
        self.assertIn('SKILL.md', plugin)
        self.assertIn(b'name: task-checkpoint-tools', plugin['SKILL.md'][0])
        self.assertEqual(json.loads(plugin['.codex-plugin/plugin.json'][0])['skills'], './skills/')
        self.assertFalse(any(path.endswith('hooks/hooks.json') for path in plugin))
        evidence = json.loads(plugin['suite-manifest.json'][0])
        self.assertEqual([item['source']['commit'] for item in evidence['components']], ['a' * 40, 'b' * 40])
        market = json.loads(catalog['.agents/plugins/marketplace.json'][0])
        self.assertEqual(market['plugins'][0]['source']['path'], './plugins/task-checkpoint-tools')
        self.assertIn('plugins/task-checkpoint-tools/plugin.json', catalog)


if __name__ == '__main__':
    unittest.main()
