import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('distribution_package', Path(__file__).with_name('package.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PublicArchiveTests(unittest.TestCase):
    def test_workspace_and_credentials_are_outside_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'src').mkdir(); (root / 'src/cli.ts').write_text('export {};')
            (root / 'workspace').mkdir(); (root / 'workspace/private.jsonl').write_text('PRIVATE')
            (root / 'auth.json').write_text('PRIVATE')
            self.assertEqual([p.relative_to(root).as_posix() for p in package.safe_files(root, package.PUBLIC)], ['src/cli.ts'])

    def test_symlink_in_public_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'src').mkdir(); (root / 'auth.json').write_text('PRIVATE')
            (root / 'src/accidental.ts').symlink_to(root / 'auth.json')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                package.safe_files(root, package.PUBLIC)

    def test_secret_name_inside_allowed_tree_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'src').mkdir(); (root / 'src/.env').write_text('PRIVATE')
            with self.assertRaisesRegex(ValueError, 'private_path'):
                package.safe_files(root, package.PUBLIC)

    def test_helper_context_copies_only_explicit_build_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'; root.mkdir()
            (root / 'package.json').write_text(json.dumps({'name': 'ultrafast-atif-helper', 'version': '0.2.0'}))
            (root / 'workspace').mkdir(); (root / 'workspace/secret').write_text('PRIVATE')
            output = Path(temporary) / 'narrow'
            result = package.helper_context(root, output)
            self.assertEqual(result['files'], 1)
            self.assertFalse((output / 'workspace').exists())
            self.assertTrue((output / 'context-manifest.json').is_file())

    def test_output_cannot_reenter_its_source(self):
        with self.assertRaisesRegex(ValueError, 'artifact_output_inside_source'):
            package.artifacts(package.ROOT / 'docs/new-release-output')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'helper_context_output_inside_source'):
                package.helper_context(root, root / 'nested-context')

    def test_nested_private_local_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'docs/.local').mkdir(parents=True)
            (root / 'docs/.local/checkpoint.md').write_text('SYNTHETIC_PRIVATE')
            with self.assertRaisesRegex(ValueError, 'private_path'):
                package.safe_files(root, package.PUBLIC)

    def test_helper_context_rejects_private_nested_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'; root.mkdir()
            (root / 'src/.local').mkdir(parents=True)
            (root / 'src/.local/checkpoint.md').write_text('SYNTHETIC_PRIVATE')
            with self.assertRaisesRegex(ValueError, 'private_path'):
                package.helper_context(root, Path(temporary) / 'context')

    def test_sqlite_sidecar_is_private_even_without_local_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'docs').mkdir(); (root / 'docs/store.sqlite-wal').write_text('SYNTHETIC_PRIVATE')
            with self.assertRaisesRegex(ValueError, 'runtime_or_secret_file'):
                package.safe_files(root, package.PUBLIC)


if __name__ == '__main__':
    unittest.main()
