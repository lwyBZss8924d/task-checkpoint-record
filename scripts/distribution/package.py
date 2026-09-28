#!/usr/bin/env python3
"""Build bounded public source/plugin artifacts; never archive a working tree wholesale."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = (
    'package.json', 'package-lock.json', 'bun.lock', 'tsconfig.json', 'tsconfig.hooks.json',
    'plugin.json', '.codex-plugin', '.github/workflows', '.github/CODEOWNERS',
    'README.md', 'LICENSE', 'AGENTS.md', 'SPEC.md', 'llms.txt', 'SECURITY.md',
    'Dockerfile', '.dockerignore', '.gitignore', 'aicatlog-manifest.json', 'src', 'bin', 'tests',
    'types', 'config', 'docs', 'skills', 'scripts', 'integrations', 'container',
    'hooks/fast-jev.ts', 'hooks/README.md', 'upstream-reference',
)
PLUGIN = ('plugin.json', '.codex-plugin', 'skills', 'docs', 'README.md', 'LICENSE', 'llms.txt',
          'AGENTS.md', 'SPEC.md', 'src', 'config', 'aicatlog-manifest.json')
HELPER = ('package.json', 'package-lock.json', 'tsconfig.json', 'src', 'bin', 'LICENSE')
MAX_BYTES = 32 * 1024 * 1024
DENIED = {'.git', '.env', 'auth.json', 'node_modules', 'workspace', 'dist', 'coverage', '__pycache__', '.cache', '.local'}
REQUIRED_DISTRIBUTION = ('README.md', 'AGENTS.md', 'SPEC.md', 'llms.txt', 'LICENSE', 'Dockerfile', '.dockerignore')
RUNTIME_SUFFIXES = {'.sqlite', '.sqlite-shm', '.sqlite-wal', '.db', '.db-shm', '.db-wal', '.jsonl', '.pem', '.key'}

def safe_files(root: Path, paths: tuple[str, ...]) -> list[Path]:
    found: list[Path] = []
    total = 0
    def visit(path: Path) -> None:
        nonlocal total
        if path.is_symlink():
            raise ValueError('symlink_in_public_inputs')
        if not path.exists():
            return
        relative = path.relative_to(root)
        # Inactive upstream manifests are intentionally preserved only in source archives.
        if any(p in DENIED or p.startswith('.env.') for p in relative.parts):
            raise ValueError('private_path_in_public_inputs')
        if path.is_dir():
            for child in sorted(path.iterdir()):
                if child.name == '__pycache__':
                    continue
                visit(child)
            return
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('non_regular_public_input')
        if path.suffix in RUNTIME_SUFFIXES:
            raise ValueError('runtime_or_secret_file_in_public_inputs')
        total += info.st_size
        if info.st_size > 4 * 1024 * 1024 or total > MAX_BYTES or len(found) >= 2048:
            raise ValueError('public_input_budget_exceeded')
        found.append(path)
    for relative in paths:
        visit(root / relative)
    return sorted(set(found))

def validate_manifests(package: dict, compat: dict, portable: dict) -> None:
    for manifest in (compat, portable):
        if manifest['name'] != package['name'] or manifest['version'] != package['version']:
            raise ValueError('plugin_package_identity_mismatch')
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', manifest['name']):
            raise ValueError('invalid_plugin_name')
        if any(k in manifest for k in ('hooks', 'apps', 'mcpServers')):
            raise ValueError('unexpected_auto_activation_manifest')
    if portable.get('extensions') not in (None, {}):
        # Any executable extension requires a new reviewed distribution contract.
        raise ValueError('unexpected_portable_extension')
    if portable.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json':
        raise ValueError('portable_schema_missing')
    if compat.get('skills') != './skills/':
        raise ValueError('skills_directory_mismatch')

def check(root: Path = ROOT) -> dict:
    # Reject forbidden paths and links before reading even the package manifests.
    files = safe_files(root, PUBLIC)
    package = json.loads((root / 'package.json').read_text())
    compat = json.loads((root / '.codex-plugin/plugin.json').read_text())
    portable = json.loads((root / 'plugin.json').read_text())
    validate_manifests(package, compat, portable)
    skills = sorted((root / 'skills').glob('*/SKILL.md'))
    if not skills:
        raise ValueError('no_bundled_skills')
    for path in ('hooks/hooks.json', '.claude-plugin/plugin.json', '.mcp.json', 'mcp.json', '.app.json'):
        if (root / path).exists():
            raise ValueError('unexpected_auto_discovery_file')
    for required in REQUIRED_DISTRIBUTION:
        if not (root / required).is_file():
            raise ValueError('required_distribution_file_missing:' + required)
    for path in files:
        data = path.read_bytes()
        if any(re.search(pattern, data) for pattern in (
            rb'/(?:Users|home)/[A-Za-z][^\s/]+/', rb'sk-or-v1-[a-f0-9]{32,}',
            rb'-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----\r?\n',
        )):
            raise ValueError('local_or_secret_marker_in_public_input:' + str(path.relative_to(root)))
    preservation = root / 'upstream-reference/preservation.json'
    if preservation.exists():
        for item in json.loads(preservation.read_text())['moves']:
            if (root / item['original_path']).exists():
                raise ValueError('legacy_activation_restored')
            if hashlib.sha256((root / item['inactive_path']).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('upstream_reference_changed')
    return {'schema_version': 'distribution-check.v1', 'package': package['name'],
            'version': package['version'], 'public_files': len(files), 'skills': len(skills),
            'native_plugin_installed': False, 'models_called': False}

def artifacts(destination: Path) -> dict:
    if destination.resolve().is_relative_to(ROOT):
        raise ValueError('artifact_output_inside_source')
    report = check()
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    name = report['package']
    version = report['version']
    stem = name + '-' + version
    tar_path = destination / (stem + '-source.tar.gz')
    with tar_path.open('xb') as stream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w') as tar:
                for path in safe_files(ROOT, PUBLIC):
                    data = path.read_bytes()
                    item = tarfile.TarInfo(stem + '/' + path.relative_to(ROOT).as_posix())
                    item.size = len(data)
                    item.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                    tar.addfile(item, io.BytesIO(data))
    zip_path = destination / (stem + '-plugin.zip')
    with zipfile.ZipFile(zip_path, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in safe_files(ROOT, PLUGIN):
            item = zipfile.ZipInfo(name + '/' + path.relative_to(ROOT).as_posix(), (1980, 1, 1, 0, 0, 0))
            item.external_attr = 0o100644 << 16
            archive.writestr(item, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    sums = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n'
                   for path in (tar_path, zip_path))
    (destination / 'SHA256SUMS').write_text(sums)
    return {**report, 'artifacts': [tar_path.name, zip_path.name, 'SHA256SUMS'],
            'scope': 'allowlisted_public_source_and_skills_only_no_git_notes_or_private_evidence'}

def helper_context(source: Path, destination: Path) -> dict:
    source = source.resolve(strict=True)
    if destination.resolve().is_relative_to(source):
        raise ValueError('helper_context_output_inside_source')
    files = safe_files(source, HELPER)
    package = json.loads((source / 'package.json').read_text())
    if package['name'] != 'ultrafast-atif-helper':
        raise ValueError('wrong_helper_source')
    destination.mkdir(parents=True, mode=0o700, exist_ok=False)
    inventory = []
    for path in files:
        relative = path.relative_to(source)
        data = path.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        inventory.append({'path': relative.as_posix(), 'sha256': hashlib.sha256(data).hexdigest()})
    (destination / 'context-manifest.json').write_text(json.dumps({'files': inventory}, indent=2) + '\n')
    return {'schema_version': 'helper-build-context.v1', 'files': len(files), 'package': package['name'], 'version': package['version']}

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check')
    build = sub.add_parser('archive'); build.add_argument('--output', required=True, type=Path)
    stage = sub.add_parser('helper-context'); stage.add_argument('--source', required=True, type=Path); stage.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = check() if args.command == 'check' else artifacts(args.output) if args.command == 'archive' else helper_context(args.source, args.output)
    print(json.dumps(result, sort_keys=True))

if __name__ == '__main__':
    main()
