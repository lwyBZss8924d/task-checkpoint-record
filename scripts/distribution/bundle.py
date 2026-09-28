#!/usr/bin/env python3
"""Assemble the single-install recorder bundle from two exact public Git commits."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

from package import PUBLIC, MAX_BYTES, DENIED, REQUIRED_DISTRIBUTION, RUNTIME_SUFFIXES, validate_manifests


def git(repo: Path, *args: str) -> bytes:
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          capture_output=True, timeout=30).stdout


def committed_files(repo: Path, commit: str) -> dict[str, tuple[bytes, int]]:
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('full_commit_required')
    if git(repo, 'cat-file', '-t', commit).strip() != b'commit':
        raise ValueError('source_object_not_commit')
    files = {}
    total = 0
    for entry in git(repo, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        mode, kind, object_id = metadata.decode('ascii').split()
        path = raw_path.decode('utf-8')
        if not any(path == allowed or path.startswith(allowed + '/') for allowed in PUBLIC):
            continue
        parts = PurePosixPath(path)
        if parts.is_absolute() or '..' in parts.parts or mode not in ('100644', '100755') or kind != 'blob':
            raise ValueError('unsafe_committed_public_entry')
        if any(p in DENIED or p.startswith('.env.') for p in parts.parts):
            raise ValueError('private_committed_public_entry')
        if parts.suffix in RUNTIME_SUFFIXES:
            raise ValueError('runtime_committed_public_entry')
        size = int(git(repo, 'cat-file', '-s', object_id))
        total += size
        if size > 4 * 1024 * 1024 or total > MAX_BYTES or len(files) >= 2048:
            raise ValueError('committed_public_budget_exceeded')
        data = git(repo, 'cat-file', 'blob', object_id)
        if len(data) != size:
            raise ValueError('source_blob_length_mismatch')
        if any(re.search(pattern, data) for pattern in (
            rb'/(?:Users|home)/[A-Za-z][^\s/]+/', rb'sk-or-v1-[a-f0-9]{32,}',
            rb'-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----\r?\n',
        )):
            raise ValueError('private_marker_in_committed_source')
        files[path] = (data, 0o755 if mode == '100755' else 0o644)
    return files


def component(name: str, commit: str, root: str, files: dict[str, tuple[bytes, int]]) -> dict:
    package = json.loads(files['package.json'][0])
    if package['name'] != name:
        raise ValueError('package_identity_mismatch')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', package['version']):
        raise ValueError('stable_package_version_required')
    validate_manifests(package, json.loads(files['.codex-plugin/plugin.json'][0]), json.loads(files['plugin.json'][0]))
    for required in REQUIRED_DISTRIBUTION:
        if required not in files:
            raise ValueError('required_distribution_file_missing:' + required)
    if not any(path.startswith('skills/') and path.endswith('/SKILL.md') for path in files):
        raise ValueError('bundled_skills_required')
    if any(path in files for path in ('hooks/hooks.json', '.claude-plugin/plugin.json', '.mcp.json', 'mcp.json', '.app.json')):
        raise ValueError('unexpected_plugin_activation')
    license_data = files['LICENSE'][0]
    if b'MIT License' not in license_data or b'Permission is hereby granted' not in license_data:
        raise ValueError('MIT_license_required')
    prefix = '' if root == '.' else root + '/'
    return {
        'name': name, 'version': package['version'], 'root': root,
        'source': {'repository': 'https://github.com/lwyBZss8924d/' + name, 'commit': commit},
        'license': {'spdx': 'MIT', 'path': prefix + 'LICENSE', 'sha256': hashlib.sha256(license_data).hexdigest()},
        'files': [{'path': prefix + path, 'sha256': hashlib.sha256(data).hexdigest(),
                   'size': len(data), 'mode': mode} for path, (data, mode) in sorted(files.items())],
    }


def suite_files(manifest: dict, record: dict, helper: dict) -> tuple[dict, dict]:
    """Derive a two-Skill plugin and self-hosted catalog from the committed bundle."""
    name = 'task-checkpoint-tools'
    version = manifest['recorder']['version']
    description = 'Record task checkpoints and retrieve source-qualified agent trajectory windows.'
    portable = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
                'name': name, 'version': version, 'description': description, 'license': 'MIT'}
    compat = {'name': name, 'version': version, 'description': description, 'license': 'MIT',
              'author': {'name': 'Task Checkpoint contributors'}, 'skills': './skills/',
              'repository': 'https://github.com/lwyBZss8924d/task-checkpoint-record',
              'interface': {'displayName': 'Task Checkpoint Tools', 'shortDescription': description,
                            'longDescription': description + ' Both package Skills are included. CLI installation and runtime effects remain explicit.',
                            'developerName': 'Task Checkpoint contributors', 'category': 'Developer Tools',
                            'capabilities': [], 'defaultPrompt': ['Recall one task window from its selected local checkpoint store.']}}
    validate_manifests({'name': name, 'version': version}, compat, portable)
    encode = lambda value: (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    files = {'plugin.json': (encode(portable), 0o644), '.codex-plugin/plugin.json': (encode(compat), 0o644)}
    resources = []
    origins = []
    for key, payload in [('recorder', record), ('helper', helper)]:
        source = manifest[key]
        prefix = 'skills/' + source['name'] + '/'
        if prefix + 'SKILL.md' not in payload:
            raise ValueError('suite_component_skill_missing')
        for path, content in payload.items():
            if path.startswith(prefix):
                files[path] = content
        license_path = 'licenses/' + source['name'] + '-LICENSE'
        files[license_path] = payload['LICENSE']
        origins.append({'name': source['name'], 'version': source['version'], 'source': source['source'],
                        'license': {**source['license'], 'path': license_path}})
        resources.append({'id': key, 'kind': 'skill', 'path': prefix + 'SKILL.md',
                          'when': 'Use the bundled ' + source['name'] + ' workflow with its installed CLI.'})
    files['resources.json'] = (encode({'schema_version': 'aicatlog.resources.v1', 'resources': resources}), 0o644)
    plugin_registry = {'schema_version': 'aicatlog.registry.v1',
                       'scopes': [{'id': name, 'root': '.', 'kind': 'repo', 'manifests': ['resources.json'],
                                   'excludes': [], 'content_index': False, 'discovery': 'manifest'}],
                       'skills': [], 'resources': [], 'settings': {}}
    files['aicatlog-manifest.json'] = (encode(plugin_registry), 0o644)
    navigation = '# Task Checkpoint Tools\n\n> Select the installed CLI and one task before following a bundled workflow.\n\n'
    navigation += '- [Record and recall](skills/task-checkpoint-record/SKILL.md): bind, enqueue, query and resolve one task.\n'
    navigation += '- [ATIF helper](skills/ultrafast-atif-helper/SKILL.md): ingest, filter and verify selected source records.\n'
    navigation += '- [Source provenance](suite-manifest.json): both exact source commits and delivered file digests.\n'
    files['llms.txt'] = (navigation.encode(), 0o644)
    router = '---\nname: task-checkpoint-tools\ndescription: Route to the bundled task checkpoint recorder or ATIF helper for explicit local record, recall, filtering and retrieval workflows.\nmetadata:\n  aicatlog_manifest: resources.json\n---\n\n'
    router += '# Task Checkpoint Tools\n\nChoose one workflow and read its bundled references only as needed:\n\n'
    router += '- [Recorder](skills/task-checkpoint-record/SKILL.md): configure and bind a task, inspect jobs/windows, and recall source-qualified metadata.\n'
    router += '- [ATIF helper](skills/ultrafast-atif-helper/SKILL.md): ingest one selected source, filter, verify and build bounded context views.\n\n'
    router += 'Use the installed CLI help before running commands. CLI installation, explicit configuration, device authentication, scoring, hook activation and worker startup are separate operations. '
    router += 'Keep real RAW and account state local. Repository-relative examples require the selected source/release package. Both nested Skills and their references travel with this root Skill package.\n'
    files['SKILL.md'] = (router.encode(), 0o644)
    files['AGENTS.md'] = (b'# Task Checkpoint Tools\n\nRead llms.txt and select one bundled Skill. Use the installed command discovery\ninterface before acting. CLI installation, configuration, authentication, task\nbinding, hooks and workers are explicit operations. Keep private RAW and account\nstate local; a plugin installation grants no upload or task-resume authority.\n', 0o644)
    readme = '# Task Checkpoint Tools\n\nThis self-hosted plugin bundles both independently usable Skills.\n\n'
    readme += '[Choose a workflow](llms.txt). Each Skill includes its own documentation and public configuration references.\n\n'
    readme += 'Install the combined task-checkpoint-record CLI release when the commands are unavailable. '
    readme += 'Plugin installation itself starts no daemon, authentication flow, model request or native Hook.\n\n'
    readme += 'Both MIT notices are preserved under `licenses/`; exact component commits and file hashes are in `suite-manifest.json`.\n'
    files['README.md'] = (readme.encode(), 0o644)
    inventory = [{'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mode': mode}
                 for path, (data, mode) in sorted(files.items())]
    suite = {'schema_version': 'task-checkpoint-tools.suite.v1', 'name': name, 'version': version,
             'source_bundle_manifest_sha256': hashlib.sha256(encode(manifest)).hexdigest(),
             'components': origins, 'files': inventory,
             'global_skill_router': 'SKILL.md', 'plugin_skill_directory': 'skills/',
             'activation': 'skills_only_no_hooks_mcp_apps_or_services'}
    files['suite-manifest.json'] = (encode(suite), 0o644)
    marketplace = {'name': name, 'interface': {'displayName': 'Task Checkpoint Tools'},
                   'plugins': [{'name': name, 'source': {'source': 'local', 'path': './plugins/' + name},
                                'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'},
                                'category': 'Productivity'}]}
    registry = {'schema_version': 'aicatlog.registry.v1',
                'scopes': [{'id': name, 'root': 'plugins/' + name, 'kind': 'repo',
                            'manifests': ['resources.json'], 'excludes': [], 'content_index': False,
                            'discovery': 'manifest'}], 'skills': [], 'resources': [], 'settings': {}}
    catalog = {'plugins/' + name + '/' + path: content for path, content in files.items()}
    catalog['.agents/plugins/marketplace.json'] = (encode(marketplace), 0o644)
    catalog['aicatlog-manifest.json'] = (encode(registry), 0o644)
    catalog['README.md'] = (b'# Task Checkpoint Tools marketplace\n\nThis extracted directory is the marketplace root. Register it explicitly with\n`codex plugin marketplace add /absolute/extracted/marketplace-root --json`, then\n`codex plugin add task-checkpoint-tools@task-checkpoint-tools --json`.\nThe native commands change only the explicitly selected Codex profile. Inspect\nits plugin list after installation. CLI help is the authority for other versions.\nThis source catalog is separate from official public-directory admission.\n', 0o644)
    return files, catalog


def write_zip(path: Path, root: str, files: dict) -> None:
    with zipfile.ZipFile(path, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (data, mode) in sorted(files.items()):
            item = zipfile.ZipInfo(root + '/' + name, (1980, 1, 1, 0, 0, 0))
            item.external_attr = (0o100000 | mode) << 16
            archive.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED)


def build(recorder_repo: Path, recorder_commit: str, helper_repo: Path, helper_commit: str, output: Path) -> dict:
    record = committed_files(recorder_repo, recorder_commit)
    helper = committed_files(helper_repo, helper_commit)
    manifest = {
        'schema_version': 'task-checkpoint-record.release-bundle.v1',
        'recorder': component('task-checkpoint-record', recorder_commit, '.', record),
        'helper': component('ultrafast-atif-helper', helper_commit, 'vendor/ultrafast-atif-helper', helper),
        'compatibility': {'helper_page_schema': 'ultrafast-atif.page.v1',
                          'recorder_help_schema': 'task-checkpoint-record.help.v1'},
    }
    data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    files = {**record, **{'vendor/ultrafast-atif-helper/' + p: v for p, v in helper.items()},
             'release-bundle.json': (data, 0o644)}
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    stem = 'task-checkpoint-record-' + manifest['recorder']['version'] + '-bundle'
    path = output / (stem + '.tar.gz')
    with path.open('xb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for name, (content, mode) in sorted(files.items()):
                    item = tarfile.TarInfo(stem + '/' + name)
                    item.size = len(content); item.mode = mode
                    archive.addfile(item, io.BytesIO(content))
    metadata_path = output / (stem + '.manifest.json')
    metadata_path.write_bytes(data)
    suite, marketplace = suite_files(manifest, record, helper)
    suite_stem = 'task-checkpoint-tools-' + manifest['recorder']['version']
    suite_path = output / (suite_stem + '-plugin.zip')
    marketplace_path = output / (suite_stem + '-marketplace.zip')
    suite_manifest_path = output / (suite_stem + '.manifest.json')
    suite_manifest_path.write_bytes(suite['suite-manifest.json'][0])
    write_zip(suite_path, 'task-checkpoint-tools', suite)
    write_zip(marketplace_path, suite_stem + '-marketplace', marketplace)
    checksum_path = output / (stem + '.SHA256SUMS')
    checksum_path.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n'
                                   for p in (path, metadata_path, suite_path, marketplace_path, suite_manifest_path)))
    return {'schema_version': 'release-bundle-build.v1', 'recorder_commit': recorder_commit,
            'helper_commit': helper_commit, 'files': len(files), 'bundle_root': stem,
            'manifest_sha256': hashlib.sha256(data).hexdigest(),
            'artifacts': [path.name, metadata_path.name, suite_path.name, marketplace_path.name, suite_manifest_path.name, checksum_path.name]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recorder-repo', required=True, type=Path)
    parser.add_argument('--recorder-commit', required=True)
    parser.add_argument('--helper-repo', required=True, type=Path)
    parser.add_argument('--helper-commit', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.recorder_repo, args.recorder_commit, args.helper_repo, args.helper_commit, args.output), sort_keys=True))
