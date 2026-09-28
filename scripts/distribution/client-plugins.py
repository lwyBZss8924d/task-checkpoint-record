#!/usr/bin/env python3
"""Build explicitly selected native client plugins from one verified source bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile

# This entrypoint may run from the exact source bundle it validates. Local
# imports must not add bytecode files to that immutable input, even for --help.
sys.dont_write_bytecode = True

from bundle import write_zip
from package import DENIED, RUNTIME_SUFFIXES

MAX_BYTES = 64 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def read_regular(root: Path, relative: str, limit: int = 4 * 1024 * 1024) -> bytes:
    path = PurePosixPath(relative)
    if not relative or path.is_absolute() or '..' in path.parts or '\\' in relative:
        raise ValueError('invalid_bundle_path')
    if any(part in DENIED or part.startswith('.env.') for part in path.parts) or path.suffix in RUNTIME_SUFFIXES:
        raise ValueError('private_bundle_path')
    current = root
    for part in path.parts:
        current /= part
        if current.is_symlink():
            raise ValueError('bundle_symlink')
    descriptor = os.open(current, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('bundle_file_invalid')
        with os.fdopen(os.dup(descriptor), 'rb') as source:
            data = source.read(limit + 1)
        if len(data) > limit:
            raise ValueError('bundle_file_budget')
        return data
    finally:
        os.close(descriptor)


def verify_bundle(root: Path, expected_sha: str) -> tuple[dict, dict]:
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha):
        raise ValueError('reviewed_manifest_sha256_required')
    raw = read_regular(root, 'release-bundle.json')
    if hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError('release_manifest_changed')
    manifest = json.loads(raw)
    if manifest.get('schema_version') != 'task-checkpoint-record.release-bundle.v1':
        raise ValueError('release_manifest_schema')
    expected = {'release-bundle.json'}
    payload = {}
    total = 0
    for key, name, prefix in [('recorder', 'task-checkpoint-record', ''), ('helper', 'ultrafast-atif-helper', 'vendor/ultrafast-atif-helper/')]:
        component = manifest[key]
        if component['name'] != name or component['root'] != ('.' if not prefix else prefix[:-1]):
            raise ValueError('release_component_identity')
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', component['version']) or component['source']['repository'] != 'https://github.com/lwyBZss8924d/' + name:
            raise ValueError('release_component_source')
        if not re.fullmatch(r'[a-f0-9]{40}', component['source']['commit']):
            raise ValueError('committed_component_required')
        files = {}
        for item in component['files']:
            path = item['path']
            if path in expected or not path.startswith(prefix) or (not prefix and path.startswith('vendor/')):
                raise ValueError('release_inventory_overlap')
            expected.add(path)
            if type(item['mode']) is not int or item['mode'] not in (0o644, 0o755) or type(item['size']) is not int:
                raise ValueError('release_inventory_type')
            data = read_regular(root, path)
            total += len(data)
            if total > MAX_BYTES or len(expected) > 4096:
                raise ValueError('release_inventory_budget')
            if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256'] or (root / path).stat().st_mode & 0o777 != item['mode']:
                raise ValueError('release_inventory_changed')
            files[path[len(prefix):]] = (data, item['mode'])
        license_info = component['license']
        if license_info['spdx'] != 'MIT' or license_info['path'] != prefix + 'LICENSE' or hashlib.sha256(files['LICENSE'][0]).hexdigest() != license_info['sha256'] or b'MIT License' not in files['LICENSE'][0] or b'Permission is hereby granted' not in files['LICENSE'][0]:
            raise ValueError('release_license_changed')
        package = json.loads(files['package.json'][0])
        if (package['name'], package['version']) != (name, component['version']):
            raise ValueError('release_package_identity')
        payload[key] = files
    observed = set()
    count = 0
    for path in root.rglob('*'):
        count += 1
        if count > 8192 or len(path.relative_to(root).parts) > 32:
            raise ValueError('release_tree_budget')
        if path.is_symlink():
            raise ValueError('unexpected_bundle_link')
        if path.is_file():
            observed.add(path.relative_to(root).as_posix())
    if observed != expected:
        raise ValueError('release_inventory_not_exact')
    return manifest, payload


def overlay_files(client: str, recorder: dict, version: str) -> dict:
    prefix = 'integrations/plugins/' + client + '/task-checkpoint-record/'
    overlay = {path[len(prefix):]: content for path, content in recorder.items() if path.startswith(prefix)}
    manifest_path = '.codex-plugin/plugin.json' if client == 'codex' else '.claude-plugin/plugin.json'
    manifest = json.loads(overlay[manifest_path][0])
    if (manifest['name'], manifest['version']) != ('task-checkpoint-record', version):
        raise ValueError('client_overlay_identity')
    if any(path in overlay for path in ('.mcp.json', 'mcp.json', '.app.json')) or any(key in manifest for key in ('mcpServers', 'apps')):
        raise ValueError('unexpected_client_capability')
    if client == 'codex' and 'hooks' in manifest:
        raise ValueError('unsupported_codex_manifest_hooks_field')
    hook_document = json.loads(overlay['hooks/hooks.json'][0])
    if set(hook_document) != {'hooks'}:
        raise ValueError('unexpected_hook_document_field')
    hooks = hook_document['hooks']
    expected = {'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'SessionEnd', 'Stop'}
    if client == 'codex':
        expected.add('Interrupt')
    if set(hooks) != expected:
        raise ValueError('unexpected_client_event_set')
    for event, groups in hooks.items():
        if len(groups) != 1 or len(groups[0]['hooks']) != 1:
            raise ValueError('unexpected_client_handler_count')
        handler = groups[0]['hooks'][0]
        if handler['type'] != 'command' or handler.get('async') is not False or type(handler['timeout']) is not int or handler['timeout'] != (1 if event in ('SessionEnd', 'Interrupt') else 2):
            raise ValueError('client_hook_not_bounded_command')
        if client == 'codex':
            expected_command = '/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file --no-install --config="$PLUGIN_ROOT/runtime/recorder/config/runtime.bunfig.toml" "$PLUGIN_ROOT/scripts/hook.ts"'
            if set(handler) != {'type', 'timeout', 'async', 'command'} or handler['command'] != expected_command:
                raise ValueError('client_hook_command_not_reviewed')
        else:
            expected_args = ['-u', 'BUN_OPTIONS', '-u', 'NODE_OPTIONS', 'bun', '--no-env-file', '--no-install',
                             '--config=${CLAUDE_PLUGIN_ROOT}/runtime/recorder/config/runtime.bunfig.toml', '${CLAUDE_PLUGIN_ROOT}/scripts/hook.ts']
            if set(handler) != {'type', 'timeout', 'async', 'command', 'args'} or handler['command'] != '/usr/bin/env' or canonical(handler['args']) != canonical(expected_args):
                raise ValueError('client_hook_command_not_reviewed')
    for required in ('scripts/hook.ts', 'skills/task-checkpoint-client/SKILL.md'):
        if required not in overlay:
            raise ValueError('client_overlay_missing_runtime_entry')
    if client == 'claude' and not any(path.startswith('commands/') and path.endswith('.md') for path in overlay):
        raise ValueError('claude_commands_missing')
    return overlay


def build(root: Path, expected_sha: str, bun: Path, output: Path) -> dict:
    root = root.resolve(strict=True)
    if output.resolve().is_relative_to(root):
        raise ValueError('output_inside_bundle')
    manifest, payload = verify_bundle(root, expected_sha)
    bun = bun.resolve(strict=True)
    if not bun.is_file():
        raise ValueError('bun_executable_required')
    config = root / 'config/runtime.bunfig.toml'
    read_regular(root, 'config/runtime.bunfig.toml')
    environment = {key: value for key, value in os.environ.items() if key not in ('BUN_OPTIONS', 'NODE_OPTIONS')}
    version = subprocess.run([str(bun), '--no-env-file', '--no-install', '--config=' + str(config), '--version'], capture_output=True, text=True, check=True, env=environment, timeout=20).stdout.strip()
    if version != '1.3.14':
        raise ValueError('unreviewed_bun_compiler_version')
    with tempfile.TemporaryDirectory(prefix='client-plugin-helper-build-') as temporary:
        compiled = Path(temporary) / 'cli.js'
        command = [str(bun), '--no-env-file', '--no-install', '--config=' + str(config), 'build', 'src/helper/cli.ts', '--target=node', '--format=esm', '--outfile=' + str(compiled)]
        subprocess.run(command, cwd=root / 'vendor/ultrafast-atif-helper', env=environment, capture_output=True, check=True, timeout=60)
        helper_cli = compiled.read_bytes()
        if len(helper_cli) > 8 * 1024 * 1024 or re.search(rb'/(?:Users|home)/[A-Za-z][^\s/]+/', helper_cli) or str(root).encode() in helper_cli:
            raise ValueError('compiled_payload_not_portable')
    # Bind source again after compilation so a changed mutable input cannot enter a receipt.
    verify_bundle(root, expected_sha)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    artifacts = []
    encode = lambda value: (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    for client in ('codex', 'claude'):
        files = overlay_files(client, payload['recorder'], manifest['recorder']['version'])
        for key in ('recorder', 'helper'):
            files.update({'runtime/' + key + '/' + path: content for path, content in payload[key].items()})
            files['licenses/' + key + '-LICENSE'] = payload[key]['LICENSE']
        files['runtime/helper/dist/helper/cli.js'] = (helper_cli, 0o644)
        receipt = {'schema_version': 'task-checkpoint-record.client-plugin.v1', 'client': client,
                   'name': 'task-checkpoint-record', 'version': manifest['recorder']['version'],
                   'source_bundle_manifest_sha256': expected_sha,
                   'components': {key: {field: manifest[key][field] for field in ('name', 'version', 'source', 'license')} for key in ('recorder', 'helper')},
                   'helper_build': {'compiler': 'bun', 'version': version, 'compiler_sha256': hashlib.sha256(bun.read_bytes()).hexdigest(),
                                    'output_path': 'runtime/helper/dist/helper/cli.js', 'sha256': hashlib.sha256(helper_cli).hexdigest(), 'automatic_install': False},
                   'activation': 'native_hooks_present_explicit_config_digest_enable_binding_and_service_required',
                   'files': [{'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mode': mode}
                             for path, (data, mode) in sorted(files.items())]}
        files['client-package.json'] = (encode(receipt), 0o644)
        stem = 'task-checkpoint-record-' + manifest['recorder']['version'] + '-' + client + '-client'
        archive = output / (stem + '.zip'); detached = output / (stem + '.manifest.json')
        write_zip(archive, 'task-checkpoint-record', files); detached.write_bytes(files['client-package.json'][0])
        artifacts.extend((archive, detached))
        marketplace_name = 'task-checkpoint-record-' + client
        catalog = {'plugins/task-checkpoint-record/' + path: content for path, content in files.items()}
        if client == 'codex':
            declaration = {'name': marketplace_name, 'interface': {'displayName': 'Task Checkpoint Record client'},
                           'plugins': [{'name': 'task-checkpoint-record',
                                        'source': {'source': 'local', 'path': './plugins/task-checkpoint-record'},
                                        'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
                                        'category': 'Productivity'}]}
            catalog['.agents/plugins/marketplace.json'] = (encode(declaration), 0o644)
        else:
            declaration = {'name': marketplace_name, 'owner': {'name': 'Task Checkpoint contributors'},
                           'plugins': [{'name': 'task-checkpoint-record', 'source': './plugins/task-checkpoint-record',
                                        'description': 'Explicitly configured local checkpoint client hooks and commands.',
                                        'version': manifest['recorder']['version'], 'license': 'MIT'}]}
            catalog['.claude-plugin/marketplace.json'] = (encode(declaration), 0o644)
        catalog_path = output / (stem + '-marketplace.zip')
        write_zip(catalog_path, stem + '-marketplace', catalog)
        artifacts.append(catalog_path)
    checksums = output / 'client-plugins.SHA256SUMS'
    checksums.write_text(''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in artifacts))
    return {'schema_version': 'client-plugin-build.v1', 'source_bundle_manifest_sha256': expected_sha,
            'artifacts': [path.name for path in artifacts] + [checksums.name], 'native_install': False, 'models_called': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle-root', type=Path, required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--bun', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.bundle_root, args.bundle_sha256, args.bun, args.output), sort_keys=True))
