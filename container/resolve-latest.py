#!/usr/bin/env python3
"""Resolve official stable Codex release metadata; write a new lock, never install."""
import argparse
import json
from pathlib import Path
import re
import urllib.request

TARGETS = {'amd64': 'x86_64-unknown-linux-musl', 'arm64': 'aarch64-unknown-linux-musl',
           'darwin-arm64': 'aarch64-apple-darwin'}
URL = 'https://api.github.com/repos/openai/codex/releases/latest'


def release_lock(release):
    """Official metadata is evidence; draft/prerelease/missing digests fail closed."""
    tag = release.get('tag_name', '')
    if release.get('draft') is not False or release.get('prerelease') is not False or not re.fullmatch(r'rust-v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise ValueError('not_stable_codex_release')
    expected_release = 'https://github.com/openai/codex/releases/tag/' + tag
    if release.get('html_url') != expected_release:
        raise ValueError('not_official_codex_release')
    assets = {}
    for arch, target in TARGETS.items():
        name = 'codex-package-' + target + '.tar.gz'
        selected = [asset for asset in release['assets'] if asset.get('name') == name]
        if len(selected) != 1 or not re.fullmatch(r'sha256:[a-f0-9]{64}', selected[0].get('digest') or ''):
            raise ValueError('release_asset_digest_unavailable')
        expected_url = 'https://github.com/openai/codex/releases/download/' + tag + '/' + name
        if selected[0].get('browser_download_url') != expected_url:
            raise ValueError('not_official_codex_asset')
        assets[arch] = {'name': name, 'target': target, 'sha256': selected[0]['digest'][7:]}
    return {'schema_version': 'container-inputs.v1', 'codex_version': tag[6:],
            'codex_release': expected_release, 'codex_assets': assets,
            'discovery': {'url': URL, 'draft': False, 'prerelease': False,
                          'release_id': release.get('id'), 'published_at': release.get('published_at')}}


def resolve_latest():
    with urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'task-checkpoint-record-runtime'}), timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('release_metadata_budget_exceeded')
    return release_lock(json.loads(data))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    lock = resolve_latest()
    with args.output.open('x') as output:
        json.dump(lock, output, indent=2); output.write('\n')
    print(json.dumps({'version': lock['codex_version'], 'release': lock['codex_release'], 'state': 'resolved_not_tested'}))
