#!/usr/bin/env python3
"""Build a self-contained npm-layout Pi archive from an exact committed core bundle."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('tcr_client_packages', Path(__file__).with_name('client-plugins.py'))
clients = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clients)

PREFIX = 'integrations/plugins/pi/task-checkpoint-record/'
PI_COMMIT = 'b485fa3128c3d8dae87cb59da6e95db0f991c5bc'


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def overlay(payload, version):
    files = {path[len(PREFIX):]: content for path, content in payload.items() if path.startswith(PREFIX)}
    expected = {'package.json', 'extensions/index.ts', 'extensions/bridge.ts', 'scripts/cli.mjs',
                'skills/task-checkpoint-pi/SKILL.md', 'README.md', 'AGENTS.md', 'llms.txt'}
    if set(files) != expected:
        raise ValueError('pi_overlay_inventory_not_exact')
    package = json.loads(files['package.json'][0])
    if package.get('name') != 'task-checkpoint-record-pi' or package.get('version') != version or package.get('type') != 'module':
        raise ValueError('pi_package_identity')
    if package.get('pi') != {'extensions': ['./extensions/index.ts'], 'skills': ['./skills']} or package.get('keywords') != ['pi-package']:
        raise ValueError('pi_resource_manifest')
    if package.get('scripts') or package.get('dependencies') or package.get('optionalDependencies') or package.get('workspaces'):
        raise ValueError('pi_implicit_install_effect')
    if package.get('peerDependencies') != {'@earendil-works/pi-coding-agent': '*'}:
        raise ValueError('pi_host_sdk_must_be_peer')
    if package.get('bin') != {'task-checkpoint-record-pi': './scripts/cli.mjs'}:
        raise ValueError('pi_cli_entry')
    for path in ['extensions/index.ts', 'extensions/bridge.ts', 'scripts/cli.mjs', 'skills/task-checkpoint-pi/SKILL.md', 'README.md', 'AGENTS.md', 'llms.txt']:
        if path not in files:
            raise ValueError('pi_required_file_missing:' + path)
    return files


def build(root: Path, expected_sha: str, bun: Path, output: Path):
    root = root.resolve(strict=True)
    if output.resolve().is_relative_to(root):
        raise ValueError('output_inside_bundle')
    manifest, payload = clients.verify_bundle(root, expected_sha)
    files = overlay(payload['recorder'], manifest['recorder']['version'])
    bun = bun.resolve(strict=True)
    config = root / 'config/runtime.bunfig.toml'
    environment = {key: value for key, value in os.environ.items() if key not in ('BUN_OPTIONS', 'NODE_OPTIONS')}
    version = subprocess.run([str(bun), '--no-env-file', '--no-install', '--config=' + str(config), '--version'],
                             env=environment, capture_output=True, text=True, check=True, timeout=20).stdout.strip()
    if version != '1.3.14':
        raise ValueError('unreviewed_bun_compiler_version')
    with tempfile.TemporaryDirectory(prefix='pi-helper-build-') as td:
        compiled = Path(td) / 'cli.js'
        subprocess.run([str(bun), '--no-env-file', '--no-install', '--config=' + str(config), 'build', 'src/helper/cli.ts',
                        '--target=node', '--format=esm', '--outfile=' + str(compiled)], cwd=root / 'vendor/ultrafast-atif-helper',
                       env=environment, capture_output=True, check=True, timeout=60)
        helper_cli = compiled.read_bytes()
        if len(helper_cli) > 8 * 1024 * 1024 or re.search(rb'/(?:Users|home)/[A-Za-z][^\s/]+/', helper_cli) or str(root).encode() in helper_cli:
            raise ValueError('compiled_payload_not_portable')
    clients.verify_bundle(root, expected_sha)
    for key in ('recorder', 'helper'):
        files.update({'runtime/' + key + '/' + path: content for path, content in payload[key].items()})
        files['licenses/' + key + '-LICENSE'] = payload[key]['LICENSE']
    files['LICENSE'] = payload['recorder']['LICENSE']
    files['runtime/helper/dist/helper/cli.js'] = (helper_cli, 0o644)
    files['scripts/cli.mjs'] = (files['scripts/cli.mjs'][0], 0o755)
    receipt = {'schema_version': 'task-checkpoint-record.pi-package.v1', 'name': 'task-checkpoint-record-pi',
               'version': manifest['recorder']['version'], 'source_bundle_manifest_sha256': expected_sha,
               'components': {key: {field: manifest[key][field] for field in ('name', 'version', 'source', 'license')} for key in ('recorder', 'helper')},
               'pi_contract': {'version': '0.87.1', 'source_commit': PI_COMMIT, 'runtime_version_observation': 'separate_acceptance_receipt'},
               'helper_build': {'compiler': 'bun', 'version': version, 'compiler_sha256': hashlib.sha256(bun.read_bytes()).hexdigest(),
                                'output_path': 'runtime/helper/dist/helper/cli.js', 'sha256': hashlib.sha256(helper_cli).hexdigest()},
               'activation': 'explicit_enable_config_digest_profile_binding_and_separate_service',
               'npm_publication': 'not_performed', 'pi_catalog': 'unverified',
               'files': [{'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mode': mode}
                         for path, (data, mode) in sorted(files.items())]}
    files['pi-package.json'] = (encode(receipt), 0o644)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    stem = 'task-checkpoint-record-' + manifest['recorder']['version'] + '-pi-package'
    archive = output / (stem + '.tgz')
    with archive.open('xb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as tar:
                for path, (data, mode) in sorted(files.items()):
                    member = tarfile.TarInfo('package/' + path); member.size = len(data); member.mode = mode
                    tar.addfile(member, io.BytesIO(data))
    detached = output / (stem + '.manifest.json'); detached.write_bytes(files['pi-package.json'][0])
    sums = output / 'pi-package.SHA256SUMS'
    sums.write_text(''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in [archive, detached]))
    return {'schema_version': 'task-checkpoint.pi-package-build.v1', 'source_bundle_manifest_sha256': expected_sha,
            'artifacts': [archive.name, detached.name, sums.name], 'files': len(files), 'npm_published': False,
            'global_install': False, 'models_called': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle-root', type=Path, required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--bun', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.bundle_root, args.bundle_sha256, args.bun, args.output), sort_keys=True))
