#!/usr/bin/env python3
"""Resolve official stable Codex release metadata; write a new lock, never install."""
import argparse
import json
from pathlib import Path
import re
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
url = 'https://api.github.com/repos/openai/codex/releases/latest'
with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'task-checkpoint-record-compat'}), timeout=30) as response:
    data = response.read(2 * 1024 * 1024 + 1)
if len(data) > 2 * 1024 * 1024:
    raise ValueError('release_metadata_budget_exceeded')
release = json.loads(data)
tag = release['tag_name']
if release['draft'] or release['prerelease'] or not re.fullmatch(r'rust-v[0-9]+\.[0-9]+\.[0-9]+', tag):
    raise ValueError('not_stable_codex_release')
assets = {}
for arch, target in [('amd64', 'x86_64-unknown-linux-musl'), ('arm64', 'aarch64-unknown-linux-musl')]:
    name = 'codex-package-' + target + '.tar.gz'
    selected = [asset for asset in release['assets'] if asset['name'] == name]
    if len(selected) != 1 or not re.fullmatch(r'sha256:[a-f0-9]{64}', selected[0].get('digest') or ''):
        raise ValueError('release_asset_digest_unavailable')
    assets[arch] = {'name': name, 'target': target, 'sha256': selected[0]['digest'][7:]}
lock = {'schema_version': 'container-inputs.v1', 'codex_version': tag[6:],
        'codex_release': release['html_url'], 'codex_assets': assets}
with args.output.open('x') as output:
    json.dump(lock, output, indent=2); output.write('\n')
print(json.dumps({'version': lock['codex_version'], 'release': lock['codex_release'], 'state': 'resolved_not_tested'}))
