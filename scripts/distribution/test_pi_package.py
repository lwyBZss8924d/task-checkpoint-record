import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pi_package', Path(__file__).with_name('pi-package.py'))
pi = importlib.util.module_from_spec(spec); spec.loader.exec_module(pi)
REPO = Path(__file__).resolve().parents[2]
VERSION = json.loads((REPO/'package.json').read_bytes())['version']


def fixture(root):
    payload = {}
    for key, name, version, prefix, commit in [('recorder','task-checkpoint-record',VERSION,'','a'*40),
                                              ('helper','ultrafast-atif-helper','0.3.0','vendor/ultrafast-atif-helper/','b'*40)]:
        files = {'package.json': json.dumps({'name':name,'version':version}).encode(), 'LICENSE':b'MIT License\nPermission is hereby granted'}
        if key == 'recorder':
            for path in (REPO/pi.PREFIX).rglob('*'):
                if path.is_file(): files[path.relative_to(REPO).as_posix()] = path.read_bytes()
            files['config/runtime.bunfig.toml'] = (REPO/'config/runtime.bunfig.toml').read_bytes()
        else:
            files['src/helper/cli.ts'] = b'export function main() { console.log("synthetic helper"); }\n'
        inventory=[]
        for relative,data in files.items():
            destination=root/(prefix+relative);destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(data);destination.chmod(0o644)
            inventory.append({'path':prefix+relative,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data),'mode':0o644})
        payload[key]={'name':name,'version':version,'root':prefix[:-1] if prefix else '.',
                      'source':{'repository':'https://github.com/lwyBZss8924d/'+name,'commit':commit},
                      'license':{'spdx':'MIT','path':prefix+'LICENSE','sha256':hashlib.sha256(files['LICENSE']).hexdigest()},'files':inventory}
    value={'schema_version':'task-checkpoint-record.release-bundle.v1',**payload}
    data=pi.encode(value);(root/'release-bundle.json').write_bytes(data)
    return hashlib.sha256(data).hexdigest()


class PiPackageTests(unittest.TestCase):
    def payload(self):
        return {p.relative_to(REPO).as_posix():(p.read_bytes(),0o644) for p in (REPO/pi.PREFIX).rglob('*') if p.is_file()}

    def test_manifest_is_explicit_and_host_sdk_is_not_bundled(self):
        files=pi.overlay(self.payload(),VERSION);package=json.loads(files['package.json'][0])
        self.assertEqual(package['pi']['extensions'],['./extensions/index.ts'])
        self.assertNotIn('scripts',package);self.assertNotIn('dependencies',package)

    def test_install_scripts_dependencies_resource_drift_and_hidden_overlay_reject(self):
        for change in ('script','dependency','resource','hidden','version'):
            with self.subTest(change=change):
                files=self.payload();path=pi.PREFIX+'package.json';package=json.loads(files[path][0])
                if change=='script':package['scripts']={'postinstall':'unreviewed command'}
                elif change=='dependency':package['dependencies']={'@earendil-works/pi-coding-agent':'0.87.1'}
                elif change=='resource':package['pi']['extensions']=['./runtime/recorder/src/cli.ts']
                elif change=='hidden':files[pi.PREFIX+'.npmrc']=(b'SYNTHETIC_CONFIG_NOT_A_CREDENTIAL',0o644)
                else:package['version']='999.0.0'
                files[path]=(pi.encode(package),0o644)
                with self.assertRaises(ValueError):pi.overlay(files,VERSION)

    def test_npm_layout_inventory_binds_both_components_and_compiled_helper(self):
        bun=shutil.which('bun');self.assertIsNotNone(bun)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)/'source';root.mkdir();sha=fixture(root);output=Path(td)/'output'
            result=pi.build(root,sha,Path(bun),output)
            self.assertFalse(result['npm_published']);self.assertFalse(result['models_called'])
            detached=next(output.glob('*.manifest.json'));receipt=json.loads(detached.read_bytes())
            with tarfile.open(next(output.glob('*.tgz')),'r:gz') as archive:
                members=archive.getmembers();self.assertTrue(all(m.isfile() and m.name.startswith('package/') for m in members))
                actual={m.name[len('package/'):]:archive.extractfile(m).read() for m in members}
                expected={item['path']:item for item in receipt['files']}
                self.assertEqual(set(actual),set(expected)|{'pi-package.json'})
                for name,item in expected.items():self.assertEqual(hashlib.sha256(actual[name]).hexdigest(),item['sha256'])
                self.assertEqual(actual['pi-package.json'],detached.read_bytes())
                self.assertIn('runtime/helper/dist/helper/cli.js',actual)
                self.assertIn('licenses/recorder-LICENSE',actual);self.assertIn('licenses/helper-LICENSE',actual)
                self.assertFalse(any('/node_modules/' in name or '/workspace/' in name for name in actual))
            self.assertEqual(receipt['components']['recorder']['source']['commit'],'a'*40)
            self.assertEqual(receipt['components']['helper']['source']['commit'],'b'*40)
            pi.clients.verify_bundle(root,sha)

    def test_compiler_time_source_drift_is_refused_before_artifact_creation(self):
        bun=shutil.which('bun');self.assertIsNotNone(bun)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)/'source';root.mkdir();sha=fixture(root);output=Path(td)/'output';original=subprocess.run
            def mutate(argv,**kwargs):
                result=original(argv,**kwargs)
                if 'build' in argv:(root/'LICENSE').write_text('synthetic changed source')
                return result
            with patch.object(pi.subprocess,'run',side_effect=mutate),self.assertRaisesRegex(ValueError,'release_inventory_changed'):
                pi.build(root,sha,Path(bun),output)
            self.assertFalse(output.exists())

    def test_builder_help_cannot_add_bytecode_to_immutable_bundle(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);sha=fixture(root)
            for name in ('pi-package.py','client-plugins.py','bundle.py','package.py'):
                target=root/'scripts/distribution'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(Path(__file__).with_name(name),target)
            before={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
            result=subprocess.run([sys.executable,'scripts/distribution/pi-package.py','--help'],cwd=root,capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            after={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
            self.assertEqual(before,after);self.assertFalse(list(root.rglob('__pycache__')))


if __name__=='__main__':unittest.main()
