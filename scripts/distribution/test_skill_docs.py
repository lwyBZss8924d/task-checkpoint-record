import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('skill_docs', Path(__file__).with_name('skill-docs.py'))
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)


class SkillPortabilityTests(unittest.TestCase):
    def fixture(self, root):
        (root / 'package.json').write_text(json.dumps({'name': 'synthetic-package'}))
        skill = root / 'skills/synthetic-package'; skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('# Synthetic\n[Guide](references/docs/guide.md)\n')
        (root / 'docs').mkdir()
        (root / 'docs/guide.md').write_text('[Spec](../SPEC.md)\n[API](../src/api.ts)\n')
        (root / 'SPEC.md').write_text('# Spec\n[Guide](docs/guide.md)\n')
        (root / 'src').mkdir(); (root / 'src/api.ts').write_text('export {};')
        return skill

    def test_projected_folder_works_away_from_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'repo'; root.mkdir()
            skill = self.fixture(root)
            with patch.object(docs, 'ROOT', root):
                _, files = docs.project()
            for relative, data in files.items():
                target = skill / relative; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
            isolated = Path(temporary) / 'installed-skill'; shutil.copytree(skill, isolated)
            self.assertEqual(docs.verify_links(isolated), 3)
            body = (isolated / 'references/docs/guide.md').read_text()
            self.assertIn('../repository/SPEC.md', body)
            self.assertIn('https://github.com/lwyBZss8924d/synthetic-package/blob/main/src/api.ts', body)
            self.assertFalse((isolated / 'references/src/api.ts').exists())

    def test_original_escaping_skill_link_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'SKILL.md').write_text('[Guide](../../docs/guide.md)')
            with self.assertRaisesRegex(ValueError, 'skill_link_missing_or_escaping'):
                docs.verify_links(root)

    def test_private_reference_is_rejected_before_projection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            (root / '.local').mkdir(); (root / '.local/secret.md').write_text('SYNTHETIC_PRIVATE')
            (root / 'docs/guide.md').write_text('[Secret](../.local/secret.md)')
            with patch.object(docs, 'ROOT', root), self.assertRaisesRegex(ValueError, 'private_reference_path'):
                docs.project()

    def test_source_map_changes_when_canonical_doc_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            with patch.object(docs, 'ROOT', root):
                _, first = docs.project()
                (root / 'SPEC.md').write_text('# Changed specification')
                _, second = docs.project()
            self.assertNotEqual(first['references/source-map.json'], second['references/source-map.json'])


if __name__ == '__main__':
    unittest.main()
