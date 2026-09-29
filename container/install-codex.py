#!/usr/bin/env python3
"""Install one checksum-pinned official full Codex package into a new directory."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import urllib.request
import os
import stat

TARGETS = {'amd64': 'x86_64-unknown-linux-musl', 'arm64': 'aarch64-unknown-linux-musl',
           'darwin-arm64': 'aarch64-apple-darwin'}


def file_digest(path):
    value = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('unsafe_hash_input')
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def package_inventory(prefix):
    rows = []
    total = 0
    for path in sorted(prefix.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('unsafe_package_file')
        total += info.st_size
        if len(rows) >= 2048 or total > 1024 * 1024 * 1024:
            raise ValueError('package_inventory_budget')
        rows.append({'path': str(path.relative_to(prefix)), 'size': info.st_size,
                     'mode': stat.S_IMODE(info.st_mode), 'sha256': file_digest(path)})
    return rows


def install(lock: dict, arch: str, prefix: Path, *, archive_path=None) -> dict:
    version = lock['codex_version']
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('invalid_release_version')
    asset = lock['codex_assets'][arch]
    if asset['target'] != TARGETS.get(arch):
        raise ValueError('unsupported_package_target')
    expected = 'codex-package-' + asset['target'] + '.tar.gz'
    if asset['name'] != expected or not re.fullmatch(r'[a-f0-9]{64}', asset['sha256']):
        raise ValueError('invalid_release_asset')
    url = 'https://github.com/openai/codex/releases/download/rust-v' + version + '/' + expected
    if os.path.lexists(prefix):
        raise ValueError('installation_prefix_exists')
    with tempfile.TemporaryDirectory(prefix='codex-package-') as temporary:
        archive = Path(archive_path) if archive_path else Path(temporary) / 'package.tar.gz'
        digest = hashlib.sha256()
        total = 0
        if archive_path is None:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'task-checkpoint-record-runtime'}), timeout=60) as response, archive.open('xb') as output:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 512 * 1024 * 1024:
                        raise ValueError('download_size_exceeded')
                    digest.update(chunk)
                    output.write(chunk)
        else:
            if archive.stat().st_size > 512 * 1024 * 1024:
                raise ValueError('download_size_exceeded')
            with archive.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
        if digest.hexdigest() != asset['sha256']:
            raise ValueError('codex_archive_sha256_mismatch')
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            size = 0
            names = set()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not path.parts or str(path) != member.name or not (member.isfile() or member.isdir()):
                    raise ValueError('unsafe_archive_member')
                if member.name in names:
                    raise ValueError('duplicate_archive_member')
                names.add(member.name)
                size += member.size
                if size > 1024 * 1024 * 1024 or len(names) > 2048:
                    raise ValueError('archive_size_exceeded')
            prefix.mkdir(parents=True)
            for member in members:
                target = prefix.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open('xb') as output:
                        source = bundle.extractfile(member)
                        while chunk := source.read(1024 * 1024):
                            output.write(chunk)
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
        metadata = json.loads((prefix / 'codex-package.json').read_text())
        if metadata.get('layoutVersion') != 1 or metadata.get('variant') != 'codex' or metadata.get('version') != version or metadata.get('target') != asset['target'] or metadata.get('entrypoint') != 'bin/codex' or metadata.get('resourcesDir') != 'codex-resources' or metadata.get('pathDir') != 'codex-path':
            raise ValueError('codex_package_identity_mismatch')
        if not (prefix / 'bin/codex-code-mode-host').is_file() or not os.access(prefix / 'bin/codex', os.X_OK) or not os.access(prefix / 'bin/codex-code-mode-host', os.X_OK):
            raise ValueError('paired_code_mode_host_missing')
        if not (prefix / 'codex-resources').is_dir() or not (prefix / 'codex-path').is_dir():
            raise ValueError('package_resources_missing')
    return {'version': version, 'target': asset['target'], 'sha256': digest.hexdigest(),
            'source': url, 'verification': 'archive_digest_and_package_layout', 'files': package_inventory(prefix)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--arch', choices=tuple(TARGETS), required=True)
    parser.add_argument('--prefix', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(install(json.loads(args.lock.read_text()), args.arch, args.prefix), sort_keys=True))
