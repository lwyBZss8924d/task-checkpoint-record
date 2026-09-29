#!/usr/bin/env python3
"""Offline image-release boundary tests; Docker/native/network are never launched."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('image_ci', Path(__file__).with_name('image-ci.py'))
image = importlib.util.module_from_spec(spec); spec.loader.exec_module(image)


def fixture():
    native = {'codex_version': '0.159.0', 'codex_release': 'https://github.com/openai/codex/releases/tag/rust-v0.159.0',
              'discovery': {'url': 'https://api.github.com/repos/openai/codex/releases/latest', 'draft': False, 'prerelease': False}, 'codex_assets': {}}
    for arch, target in [('amd64', 'x86_64-unknown-linux-musl'), ('arm64', 'aarch64-unknown-linux-musl')]:
        native['codex_assets'][arch] = {'target': target, 'name': 'codex-package-' + target + '.tar.gz', 'sha256': 'a' * 64}
    base = {'digest': 'sha256:' + 'b' * 64, 'manifests': [{'platform': {'os': 'linux', 'architecture': x}} for x in ['amd64', 'arm64']]}
    helper = {'schema_version': 'task-checkpoint.helper-source.v1', 'repository': image.HELPER, 'commit': 'c' * 40, 'version': '0.3.0'}
    options = {'recorder_commit': 'd' * 40, 'recorder_version': '0.2.0', 'repository': 'example/task-checkpoint-record',
               'protocol_sha': 'e' * 64, 'native_lock_sha': 'f' * 64, 'run_id': '123', 'run_attempt': '1'}
    return native, base, helper, options


class ImagePolicyTests(unittest.TestCase):
    def plan(self):
        native, base, helper, options = fixture()
        return image.make_plan(native, base, helper, **options)

    def test_plan_preserves_all_identity_domains(self):
        plan = self.plan()
        self.assertEqual(plan['base']['reference'], image.BASE + '@sha256:' + 'b' * 64)
        labels = image.image_labels(plan, 'arm64', 'f' * 64)
        self.assertEqual(labels['io.task-checkpoint.native.version'], '0.159.0')
        self.assertEqual(labels['io.task-checkpoint.helper.revision'], 'c' * 40)
        self.assertEqual(plan['effects'], 'resolved_not_built_or_published')

    def test_github_owner_case_is_preserved_and_ghcr_namespace_is_lowercase(self):
        native, base, helper, options = fixture()
        options['repository'] = 'lwyBZss8924d/task-checkpoint-record'
        plan = image.make_plan(native, base, helper, **options)
        self.assertEqual(plan['recorder']['repository'], 'https://github.com/lwyBZss8924d/task-checkpoint-record')
        self.assertEqual(plan['image_repository'], 'ghcr.io/lwybzss8924d/task-checkpoint-record')

    def test_prerelease_and_missing_package_digest_are_rejected(self):
        for change in ('prerelease', 'digest', 'old_version'):
            native, base, helper, options = fixture()
            if change == 'prerelease': native['discovery']['prerelease'] = True
            elif change == 'digest': native['codex_assets']['arm64']['sha256'] = None
            else: native['codex_version'] = '0.158.0'
            with self.subTest(change=change), self.assertRaises(ValueError): image.make_plan(native, base, helper, **options)

    def test_helper_needs_reviewed_full_public_commit_and_compatible_version(self):
        for change in ('short', 'branch', 'old_helper', 'foreign_repository'):
            native, base, helper, options = fixture()
            if change == 'short': helper['commit'] = 'ccccccc'
            elif change == 'branch': helper['commit'] = 'main'
            elif change == 'old_helper': helper['version'] = '0.2.0'
            else: helper['repository'] = 'https://example.invalid/other'
            with self.subTest(change=change), self.assertRaises(ValueError): image.make_plan(native, base, helper, **options)

    def test_both_native_base_platforms_and_digest_are_required(self):
        for change in ('single_arch', 'floating'):
            native, base, helper, options = fixture()
            if change == 'single_arch': base['manifests'].pop()
            else: base['digest'] = 'latest'
            with self.subTest(change=change), self.assertRaises(ValueError): image.make_plan(native, base, helper, **options)

    def test_interpreter_controls_are_removed_without_changing_proxy_route(self):
        with patch.dict(os.environ, {'BUN_OPTIONS':'canary', 'NODE_OPTIONS':'canary', 'PYTHONPATH':'canary', 'PYTHONINSPECT':'1', 'HTTPS_PROXY':'http://synthetic-route'}, clear=True):
            self.assertEqual(image.clean_environment(), {'HTTPS_PROXY':'http://synthetic-route'})

    def test_index_requires_distinct_successful_platforms_from_exact_plan(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); plan = self.plan(); image.write(root/'plan.json', plan); plan_sha = image.digest((root/'plan.json').read_bytes())
            receipts = []
            for arch, char in [('amd64','1'),('arm64','2')]:
                path = root/(arch+'.json'); image.write(path, {'schema_version':'task-checkpoint.image-publication.v1','platform':'linux/'+arch,
                    'plan_sha256':plan_sha,'source_metadata':plan,'reference':plan['image_repository']+'@sha256:'+char*64}); receipts.append(path)
            image.index_plan(root/'plan.json', receipts, root/'index.json')
            self.assertEqual(image.read(root/'index.json')['tested_platforms'], ['linux/amd64','linux/arm64'])
            with self.assertRaisesRegex(ValueError,'missing'): image.index_plan(root/'plan.json', receipts[:1], root/'missing.json')
            with self.assertRaisesRegex(ValueError,'duplicate'): image.index_plan(root/'plan.json', [receipts[0],receipts[0]], root/'duplicate.json')
            value=image.read(receipts[1]);value['plan_sha256']='0'*64;receipts[1].write_bytes(image.encoded(value))
            with self.assertRaisesRegex(ValueError,'binding'): image.index_plan(root/'plan.json', receipts, root/'changed.json')

    def test_push_receipt_cannot_substitute_a_different_image(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);plan=self.plan();image.write(root/'plan.json',plan)
            image.write(root/'smoke.json',{'status':'pass','plan_sha256':image.digest((root/'plan.json').read_bytes()),'platform':'linux/amd64','image_id':'sha256:'+'1'*64})
            with patch.object(image,'image_inspect',return_value={'Id':'sha256:'+'2'*64}), self.assertRaisesRegex(ValueError,'not_tested'):
                image.published(root/'plan.json',root/'smoke.json','amd64','synthetic:tag',root/'publish.json')
            self.assertFalse((root/'publish.json').exists())

    def test_failed_container_smoke_retains_failure_and_scoped_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);plan=self.plan();image.write(root/'plan.json',plan);plan_sha=image.digest((root/'plan.json').read_bytes())
            info={'Id':'sha256:'+'1'*64,'Os':'linux','Architecture':'amd64','Config':{'Labels':image.image_labels(plan,'amd64',plan_sha)}}
            calls=[]
            def fake(argv,**kwargs):
                calls.append(argv)
                return subprocess.CompletedProcess(argv,1,b'',b'{"error":"synthetic-image-failure"}')
            with patch.object(image,'image_inspect',return_value=info),patch.object(image,'command',side_effect=fake),self.assertRaisesRegex(ValueError,'image_smoke_failed'):
                image.smoke_image(root/'plan.json','amd64','synthetic:tag',root/'smoke.json')
            receipt=image.read(root/'smoke.json');self.assertEqual(receipt['status'],'failed');self.assertEqual(receipt['exit_code'],1)
            self.assertEqual(calls[0][:3],['docker','run','--rm']);self.assertIn('none',calls[0]);self.assertEqual(calls[-1][:2],['docker','inspect'])
            self.assertFalse(any('prune' in call for call in calls))

    def test_workflow_action_pins_and_publication_order(self):
        workflow=(image.REPO/'.github/workflows/newcodex-runtime-update.yml').read_text()
        refs=re.findall(r'uses:\s*([^\s#]+)',workflow)
        self.assertTrue(refs);self.assertTrue(all(re.fullmatch(r'[^@]+@[a-f0-9]{40}',r) for r in refs))
        jobs=re.split(r'^  ([a-z-]+):\n',workflow.split('jobs:\n',1)[1],flags=re.M)
        for name,body in zip(jobs[1::2],jobs[2::2]):
            if 'packages: write' in body:self.assertTrue(name.startswith('publish-'))
        self.assertLess(workflow.index('Test actual image offline'),workflow.index('docker login'))
        self.assertIn('needs: [resolve, publish-platform]',workflow)
        self.assertIn("cron: '23 */6 * * *'",workflow)
        self.assertNotIn('secrets.OPENROUTER',workflow)

    def test_published_current_and_immutable_index_must_resolve_identically(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);plan=self.plan();repository=plan['image_repository']
            index={'schema_version':'task-checkpoint.image-index-plan.v1','tested_platforms':['linux/amd64','linux/arm64'],
                   'source_metadata':plan,'references':[repository+'@sha256:'+c*64 for c in ('1','2')],
                   'tags':[repository+':codex-0.159.0-tcr-0.2.0-synthetic',repository+':current']}
            image.write(root/'index.json',index)
            def fake(argv,**kwargs):
                if 'create' in argv:return subprocess.CompletedProcess(argv,0,b'',b'')
                value={'digest':'sha256:'+('a' if argv[4].endswith(':current') else 'b')*64,
                       'manifests':[{'digest':r.split('@')[1]} for r in index['references']]}
                return subprocess.CompletedProcess(argv,0,json.dumps(value).encode(),b'')
            with patch.object(image,'command',side_effect=fake),self.assertRaisesRegex(ValueError,'current_tag'):
                image.publish_index(root/'index.json',root/'accepted.json')
            self.assertFalse((root/'accepted.json').exists())


if __name__ == '__main__':
    unittest.main()
