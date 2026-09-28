#!/usr/bin/env python3
"""Unpack, verify, install and query one combined public bundle using synthetic data."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile


def run(*command: str, input_value: dict | None = None) -> dict:
    result = subprocess.run(command, input=None if input_value is None else json.dumps(input_value),
                            text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError('smoke_command_failed:' + result.stderr[:2000])
    return json.loads(result.stdout)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--bun', required=True)
parser.add_argument('--node', required=True)
args = parser.parse_args()
bun = str(Path(shutil.which(args.bun) or args.bun).resolve(strict=True))
node = str(Path(shutil.which(args.node) or args.node).resolve(strict=True))
with tempfile.TemporaryDirectory(prefix='recorder-bundle-smoke-') as temporary:
    root = Path(temporary).resolve()
    with tarfile.open(args.archive, 'r:gz') as archive:
        members = archive.getmembers()
        roots = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not member.isfile():
                raise ValueError('unsafe_bundle_member')
            roots.add(path.parts[0])
        if len(roots) != 1 or len(members) > 4096 or sum(m.size for m in members) > 64 * 1024 * 1024:
            raise ValueError('bundle_bounds')
        for member in members:
            output = root.joinpath(*PurePosixPath(member.name).parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as stream:
                stream.write(archive.extractfile(member).read())
            output.chmod(member.mode & 0o777)
    bundle = root / roots.pop()
    manifest_bytes = (bundle / 'release-bundle.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    prefix = root / 'commands'; prefix.mkdir()
    plan = root / 'plan.json'; receipt = root / 'receipt.json'
    result = run(bun, "--no-env-file", str(bundle / 'scripts/install-cli.ts'), 'bundle-plan', '--bundle-root', str(bundle),
                 '--bundle-sha256', manifest_sha, '--prefix', str(prefix), '--stage', str(root / 'stage'),
                 '--bun', bun, '--node', node, '--output', str(plan))
    plan_sha = hashlib.sha256(plan.read_bytes()).hexdigest()
    run(bun, "--no-env-file", str(bundle / 'scripts/install-cli.ts'), 'apply', '--plan', str(plan), '--sha256', plan_sha, '--output', str(receipt))
    recorder = str(prefix / 'task-checkpoint-record'); helper = str(prefix / 'ultrafast-atif-helper')
    assert run(recorder, '--help')['name'] == 'task-checkpoint-record'
    run(helper, '--help')
    state = str(root / 'state'); run(recorder, 'init', '--state', state)
    sources = root / 'synthetic'; sources.mkdir()
    source = sources / 'source.jsonl'
    source.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'synthetic-bundle-session'}}) + '\n')
    binding = {'schema_version': 'task-checkpoint-record.binding.v1', 'binding_id': 'synthetic-bundle-binding',
               'task_id': 'synthetic-bundle-task', 'project_id': None, 'client': 'codex', 'profile': 'synthetic',
               'runtime_home': None, 'native_session_id': 'synthetic-bundle-session', 'role': 'master',
               'source_root': str(sources), 'sources': [{'source_id': 'synthetic-source', 'path': str(source),
                                                      'format': 'codex', 'start_at': 'beginning'}]}
    binding_file = root / 'binding.json'; binding_file.write_text(json.dumps(binding))
    run(recorder, 'bind', '--state', state, '--file', str(binding_file))
    run(recorder, 'hook', '--state', state, '--client', 'codex', '--profile', 'synthetic',
        input_value={'hook_event_name': 'PreCompact', 'session_id': 'synthetic-bundle-session'})
    drained = run(recorder, 'service', 'once', '--state', state, '--helper', helper)
    records = run(recorder, 'query', '--state', state, '--kind', 'records', '--filter', 'task_id=synthetic-bundle-task')
    if drained.get('outcomes') != {'succeeded': 1} or len(records.get('items', [])) != 1:
        raise ValueError('unified_ingestion_query_failed')
    print(json.dumps({'schema_version': 'release-bundle-smoke.v1', 'manifest_sha256': manifest_sha,
                      'recorder_commit': manifest['recorder']['source']['commit'],
                      'helper_commit': manifest['helper']['source']['commit'], 'installed_commands': 2,
                      'synthetic_jobs_succeeded': 1, 'query_records': 1, 'models_called': False,
                      'global_install': False, 'real_raw_read': False}))
