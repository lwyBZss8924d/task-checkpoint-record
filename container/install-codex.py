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


def install(lock: dict, arch: str, prefix: Path) -> dict:
    version = lock['codex_version']
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('invalid_release_version')
    asset = lock['codex_assets'][arch]
    expected = 'codex-package-' + asset['target'] + '.tar.gz'
    if asset['name'] != expected or not re.fullmatch(r'[a-f0-9]{64}', asset['sha256']):
        raise ValueError('invalid_release_asset')
    url = 'https://github.com/openai/codex/releases/download/rust-v' + version + '/' + expected
    if prefix.exists():
        raise ValueError('installation_prefix_exists')
    with tempfile.TemporaryDirectory(prefix='codex-package-') as temporary:
        archive = Path(temporary) / 'package.tar.gz'
        digest = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('xb') as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 256 * 1024 * 1024:
                    raise ValueError('download_size_exceeded')
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != asset['sha256']:
            raise ValueError('codex_archive_sha256_mismatch')
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            size = 0
            names = set()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
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
                        output.write(bundle.extractfile(member).read())
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
        metadata = json.loads((prefix / 'codex-package.json').read_text())
        if metadata.get('version') != version or metadata.get('target') != asset['target'] or metadata.get('entrypoint') != 'bin/codex':
            raise ValueError('codex_package_identity_mismatch')
        if not (prefix / 'bin/codex-code-mode-host').is_file():
            raise ValueError('paired_code_mode_host_missing')
    return {'version': version, 'target': asset['target'], 'sha256': digest.hexdigest(),
            'source': url, 'verification': 'archive_digest_and_package_layout'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--arch', choices=('amd64', 'arm64'), required=True)
    parser.add_argument('--prefix', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(install(json.loads(args.lock.read_text()), args.arch, args.prefix), sort_keys=True))
