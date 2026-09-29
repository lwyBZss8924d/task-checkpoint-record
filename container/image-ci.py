#!/usr/bin/env python3
"""Resolve image metadata, build and check the same image, and bind publication evidence."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

BASE = 'ghcr.io/openai/codex-universal'
HELPER = 'https://github.com/lwyBZss8924d/ultrafast-atif-helper'
REPO = Path(__file__).resolve().parents[1]
# Only committed public build inputs are exported. Untracked paths, including the
# workflow's nested helper checkout, can never enter either Docker context.
BUILD_INPUTS = ('Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
                'tsconfig.json', 'LICENSE', 'src', 'bin', 'config', 'container',
                'scripts/runtime', 'scripts/distribution/package.py')


def require(ok, code):
    if not ok:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def read(path):
    data = Path(path).read_bytes()
    require(len(data) <= 4 * 1024 * 1024, 'metadata_budget')
    return json.loads(data)


def write(path, value):
    with Path(path).open('xb') as output:
        output.write(encoded(value))


def clean_environment():
    return {key: value for key, value in os.environ.items()
            if not key.startswith('PYTHON') and key not in ('BUN_OPTIONS', 'NODE_OPTIONS')}


def command(argv, *, cwd=None, timeout=60, check=True):
    result = subprocess.run([str(x) for x in argv], cwd=cwd, env=clean_environment(),
                            capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise ValueError('command_failed:' + str(argv[0]) + ':' + str(result.returncode))
    return result


def hex_value(value, length):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{' + str(length) + '}', value) is not None


def make_plan(native, base, helper, *, recorder_commit, recorder_version, repository,
              protocol_sha, native_lock_sha, run_id, run_attempt):
    require(hex_value(recorder_commit, 40) and hex_value(helper.get('commit'), 40), 'source_commit_required')
    require(helper.get('schema_version') == 'task-checkpoint.helper-source.v1' and helper.get('repository') == HELPER, 'helper_source_lock')
    helper_version = helper.get('version', '')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', helper_version) is not None
            and tuple(map(int, helper_version.split('.'))) >= (0, 3, 0), 'reviewed_helper_0_3_or_newer_required')
    version = native.get('codex_version', '')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) is not None and tuple(map(int, version.split('.'))) >= (0, 159, 0), 'stable_native_version_required')
    require(native.get('codex_release') == 'https://github.com/openai/codex/releases/tag/rust-v' + version, 'official_native_release_required')
    discovery = native.get('discovery', {})
    require(discovery.get('url') == 'https://api.github.com/repos/openai/codex/releases/latest'
            and discovery.get('draft') is False and discovery.get('prerelease') is False, 'latest_stable_discovery_required')
    assets = native.get('codex_assets', {})
    for arch, target in [('amd64', 'x86_64-unknown-linux-musl'), ('arm64', 'aarch64-unknown-linux-musl')]:
        asset = assets.get(arch, {})
        require(asset.get('target') == target and asset.get('name') == 'codex-package-' + target + '.tar.gz'
                and hex_value(asset.get('sha256'), 64), 'full_native_package_digest_required')
    base_digest = base.get('digest', '')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', base_digest) is not None, 'base_digest_required')
    platforms = {m.get('platform', {}).get('os', '') + '/' + m.get('platform', {}).get('architecture', '')
                 for m in base.get('manifests', [])}
    require({'linux/amd64', 'linux/arm64'} <= platforms, 'native_base_platforms_required')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository) is not None, 'repository_identity')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', recorder_version) is not None, 'recorder_version')
    require(hex_value(protocol_sha, 64) and hex_value(native_lock_sha, 64), 'input_digest_required')
    require(str(run_id).isdigit() and str(run_attempt).isdigit(), 'workflow_run_identity')
    return {'schema_version': 'task-checkpoint.image-plan.v1', 'observed_at': datetime.now(timezone.utc).isoformat(),
            'recorder': {'repository': 'https://github.com/' + repository, 'commit': recorder_commit, 'version': recorder_version},
            'helper': helper, 'native': {'version': version, 'release': native['codex_release'], 'assets': assets},
            'base': {'repository': BASE, 'digest': base_digest, 'reference': BASE + '@' + base_digest},
            'protocol_contract_sha256': protocol_sha, 'native_lock_sha256': native_lock_sha,
            'image_repository': 'ghcr.io/' + repository.lower(), 'target_platforms': ['linux/amd64', 'linux/arm64'],
            'workflow': {'run_id': str(run_id), 'run_attempt': str(run_attempt)},
            'effects': 'resolved_not_built_or_published'}


def plan_outputs(plan, raw):
    stamp = digest(raw)
    return {'plan_sha256': stamp, 'helper_commit': plan['helper']['commit'],
            'native_version': plan['native']['version'], 'base_reference': plan['base']['reference'],
            'image_repository': plan['image_repository'],
            'immutable_tag': 'codex-' + plan['native']['version'] + '-tcr-' + plan['recorder']['version']
            + '-' + stamp[:12] + '-r' + plan['workflow']['run_id'] + '-' + plan['workflow']['run_attempt']}


def verify_plan(path, expected=None):
    path = Path(path); raw = path.read_bytes(); value = json.loads(raw)
    require(value.get('schema_version') == 'task-checkpoint.image-plan.v1', 'image_plan_schema')
    if expected:
        require(digest(raw) == expected, 'image_plan_changed')
    return value, raw


def image_labels(plan, arch, plan_sha):
    return {'org.opencontainers.image.source': plan['recorder']['repository'],
            'org.opencontainers.image.revision': plan['recorder']['commit'],
            'org.opencontainers.image.version': plan['recorder']['version'],
            'io.task-checkpoint.helper.revision': plan['helper']['commit'],
            'io.task-checkpoint.native.version': plan['native']['version'],
            'io.task-checkpoint.native.archive-sha256': plan['native']['assets'][arch]['sha256'],
            'io.task-checkpoint.native.protocol-sha256': plan['protocol_contract_sha256'],
            'io.task-checkpoint.base.digest': plan['base']['digest'],
            'io.task-checkpoint.plan.sha256': plan_sha}


def image_inspect(image):
    return json.loads(command(['docker', 'image', 'inspect', image]).stdout)[0]


def require_committed_checkout(root, expected):
    require(hex_value(expected, 40), 'source_commit_required')
    require(command(['git', '-C', root, 'rev-parse', 'HEAD']).stdout.decode().strip() == expected, 'checkout_commit_changed')
    # A staged change may match the worktree; an unstaged reversal may match HEAD.
    # Both comparisons are necessary before exporting the committed build inputs.
    for extra in (['--cached'], []):
        require(command(['git', '-C', root, 'diff', *extra, '--exit-code', expected, '--'], check=False).returncode == 0,
                'tracked_source_modified')


def export_committed_context(root, expected, output):
    require_committed_checkout(root, expected)
    rows = command(['git', '-C', root, 'ls-tree', '-rz', '--full-tree', expected]).stdout.split(b'\0')
    files = []; total = 0
    output.mkdir(parents=True, exist_ok=False)
    for row in rows:
        if not row:
            continue
        metadata, raw_path = row.split(b'\t', 1)
        mode, kind, object_id = metadata.decode('ascii').split(); relative = raw_path.decode('utf-8')
        if not any(relative == path or relative.startswith(path + '/') for path in BUILD_INPUTS):
            continue
        path = PurePosixPath(relative)
        require(not path.is_absolute() and '..' not in path.parts and '\\' not in relative
                and str(path) == relative and '\n' not in relative, 'unsafe_committed_context_path')
        require(kind == 'blob' and mode in ('100644', '100755') and hex_value(object_id, 40), 'non_regular_committed_context')
        require(not any(part in {'.git', '.env', 'auth.json', 'workspace', '.local', 'node_modules', '__pycache__'}
                        or part.startswith('.env.') for part in path.parts), 'private_committed_context_path')
        size = int(command(['git', '-C', root, 'cat-file', '-s', object_id]).stdout)
        total += size
        require(size <= 4 * 1024 * 1024 and total <= 32 * 1024 * 1024 and len(files) < 2048, 'committed_context_budget')
        data = command(['git', '-C', root, 'cat-file', 'blob', object_id]).stdout
        require(len(data) == size, 'committed_context_blob_changed')
        destination = output / relative; destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as stream:
            stream.write(data)
        permission = int(mode, 8) & 0o777; destination.chmod(permission)
        files.append({'path': relative, 'sha256': digest(data), 'size': size, 'mode': permission})
    return {'commit': expected, 'files': files, 'untracked_inputs': 'excluded_by_committed_export'}


def build_image(plan_path, source, helper_source, work, arch, tag, output):
    plan, raw = verify_plan(plan_path); source = source.resolve(); helper_source = helper_source.resolve()
    require(arch in ('amd64', 'arm64'), 'image_architecture')
    native_arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    require(native_arch == arch, 'native_runner_architecture_mismatch')
    daemon_machine = command(['docker', 'info', '--format', '{{.Architecture}}']).stdout.decode().strip().lower()
    daemon_arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(daemon_machine)
    require(daemon_arch == arch, 'native_docker_architecture_mismatch')
    work.mkdir(parents=True, exist_ok=False)
    recorder_export = work / 'recorder-source'; helper_export = work / 'helper-source'
    contexts = {'recorder': export_committed_context(source, plan['recorder']['commit'], recorder_export),
                'helper': export_committed_context(helper_source, plan['helper']['commit'], helper_export)}
    for name, root in [('recorder', recorder_export), ('helper', helper_export)]:
        package = read(root / 'package.json')
        expected_name = 'task-checkpoint-record' if name == 'recorder' else 'ultrafast-atif-helper'
        require(package['name'] == expected_name and package['version'] == plan[name]['version'], name + '_package_identity_changed')
    require(read(recorder_export / 'container/helper-source.json') == plan['helper'], 'helper_source_lock_changed')
    require(digest((recorder_export / 'container/app-server-surface.json').read_bytes()) == plan['protocol_contract_sha256'], 'protocol_contract_changed')
    native_lock = (plan_path.parent / 'versions.json').read_bytes()
    require(digest(native_lock) == plan['native_lock_sha256'], 'native_lock_changed')
    lock_context = work / 'codex-lock'; lock_context.mkdir()
    (lock_context / 'versions.json').write_bytes(native_lock); (lock_context / 'image-plan.json').write_bytes(raw)
    write(work / 'source-contexts.json', contexts)
    disk = shutil.disk_usage(work)
    print(json.dumps({'disk_bytes': {'free': disk.free, 'total': disk.total}, 'required_base': plan['base']['reference'],
                      'capacity_guarantee': False, 'cleanup_performed': False}), flush=True)
    command([sys.executable, '-I', '-B', recorder_export / 'scripts/distribution/package.py', 'helper-context',
             '--source', helper_export, '--output', work / 'helper-context'])
    argv = ['docker', 'buildx', 'build', '--load', '--platform', 'linux/' + arch,
            '--build-context', 'helper=' + str(work / 'helper-context'),
            '--build-context', 'codex-lock=' + str(lock_context),
            '--build-arg', 'CODEX_BASE=' + plan['base']['reference'], '--tag', tag]
    for key, value in image_labels(plan, arch, digest(raw)).items():
        argv.extend(['--label', key + '=' + value])
    argv.append(str(recorder_export))
    # Stream build diagnostics. No credentials are provided by this command.
    result = subprocess.run(argv, env=clean_environment(), timeout=10800)
    if result.returncode:
        write(output, {'schema_version': 'task-checkpoint.image-build.v1', 'status': 'failed',
                       'plan_sha256': digest(raw), 'argv': argv, 'exit_code': result.returncode,
                       'free_bytes_before': disk.free, 'platform': 'linux/' + arch,
                       'source_contexts_sha256': digest(encoded(contexts))})
        raise ValueError('image_build_failed')
    image = image_inspect(tag)
    write(output, {'schema_version': 'task-checkpoint.image-build.v1', 'status': 'pass', 'plan_sha256': digest(raw),
                   'image_id': image['Id'], 'platform': image['Os'] + '/' + image['Architecture'],
                   'argv': argv, 'free_bytes_before': disk.free, 'size_bytes': image['Size'],
                   'source_contexts_sha256': digest(encoded(contexts))})


def runtime_module():
    spec = importlib.util.spec_from_file_location('tcr_image_runtime', REPO / 'scripts/runtime/update.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def seed_selection():
    selected = runtime_module().current(Path('/opt/codex-managed'))
    require(selected is not None, 'image_seed_not_qualified')
    return selected


def in_container_smoke():
    """Local, unauthenticated checks. No task binding or activation is created."""
    plan = read(REPO / 'container/image-plan.json'); selected = seed_selection()
    require(selected['version'] == plan['native']['version'], 'image_seed_version_changed')
    rows = []
    recorder = str(REPO / 'bin/task-checkpoint-record')
    def probe(name, argv, expect_error=None):
        result = command(argv, timeout=45, check=False)
        value = json.loads(result.stderr if expect_error else result.stdout)
        require(result.returncode == (1 if expect_error else 0), 'smoke_exit:' + name)
        if expect_error:
            require(value.get('error') == expect_error, 'smoke_wrong_error:' + name)
        rows.append({'name': name, 'exit_code': result.returncode, 'stdout_sha256': digest(result.stdout),
                     'stderr_sha256': digest(result.stderr), 'expected_error': expect_error})
        return value
    require(probe('recorder-help', [recorder, '--help'])['name'] == 'task-checkpoint-record', 'recorder_help')
    require(probe('helper-help', ['/usr/local/bin/ultrafast-atif-helper', '--help'])['schema_version'] == 'ultrafast-atif.cli.v1', 'helper_help')
    probe('container-config', [recorder, 'config', 'check', '--config', REPO / 'config/task-checkpoint.container.example.json'])
    probe('agent-schema', [recorder, 'schema', 'agent-activation'])
    actual = command([selected['executable'], '--version']).stdout.decode().strip()
    require(actual == 'codex-cli ' + plan['native']['version'], 'native_cli_version')
    rows.append({'name': 'native-version', 'value': actual, 'exit_code': 0})
    with tempfile.TemporaryDirectory(prefix='tcr-image-smoke-') as temporary:
        state = Path(temporary) / 'state'
        probe('empty-store-init', [recorder, 'init', '--state', state])
        before = probe('agent-status-before', [recorder, 'agent', 'status', '--state', state])
        probe('agent-start-without-admission', [recorder, 'agent', 'start', '--state', state, '--daemon', 'image-no-admission'], 'agent_active_admission_required')
        after = probe('agent-status-after', [recorder, 'agent', 'status', '--state', state])
        require(before == after, 'agent_start_changed_unadmitted_state')
    proof = read(selected['qualificationPath'])
    require(proof['protocol']['contract_sha256'] == plan['protocol_contract_sha256'], 'seed_protocol_plan_mismatch')
    return {'schema_version': 'task-checkpoint.image-inside-smoke.v1', 'status': 'pass', 'checks': rows,
            'native_version': selected['version'], 'qualification_sha256': digest(Path(selected['qualificationPath']).read_bytes()),
            'qualification_protocol_sha256': proof['protocol']['contract_sha256'],
            'model_calls': 0, 'task_admissions': 0, 'real_account_homes': False}


def smoke_image(plan_path, arch, image, output):
    plan, raw = verify_plan(plan_path); info = image_inspect(image)
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', info['Id']) is not None, 'immutable_image_id_required')
    require(info['Os'] + '/' + info['Architecture'] == 'linux/' + arch, 'image_platform_mismatch')
    require(all(info['Config']['Labels'].get(k) == v for k, v in image_labels(plan, arch, digest(raw)).items()), 'image_label_mismatch')
    name = 'tcr-smoke-' + uuid.uuid4().hex
    argv = ['docker', 'run', '--rm', '--pull=never', '--name', name, '--label', 'io.task-checkpoint.smoke=' + name,
            '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
            '--entrypoint', '/usr/bin/env', info['Id'], '-u', 'BUN_OPTIONS', '-u', 'NODE_OPTIONS',
            'python3', '-I', '-B', '/opt/task-checkpoint-record/container/image-ci.py', 'inside-smoke']
    try:
        result = command(argv, timeout=240, check=False)
        if result.returncode:
            write(output, {'schema_version': 'task-checkpoint.image-smoke.v1', 'status': 'failed',
                           'plan_sha256': digest(raw), 'image_id': info['Id'], 'platform': 'linux/' + arch,
                           'argv': argv, 'exit_code': result.returncode, 'stdout_sha256': digest(result.stdout),
                           'stderr_sha256': digest(result.stderr), 'stderr_excerpt': result.stderr.decode('utf-8', errors='replace')[:4096],
                           'network': 'none', 'global_apply': False})
            raise ValueError('image_smoke_failed')
        inside = json.loads(result.stdout); require(inside['status'] == 'pass', 'inside_smoke_failed')
        report = {'schema_version': 'task-checkpoint.image-smoke.v1', 'status': 'pass', 'plan_sha256': digest(raw),
                  'image_id': info['Id'], 'size_bytes': info['Size'], 'platform': 'linux/' + arch,
                  'argv': argv, 'stdout_sha256': digest(result.stdout), 'stderr_sha256': digest(result.stderr),
                  'checks': inside, 'network': 'none', 'readonly_root': True, 'global_apply': False}
        write(output, report)
    finally:
        remaining = command(['docker', 'inspect', name], check=False)
        if remaining.returncode == 0:
            owned = json.loads(remaining.stdout)[0]
            require(owned.get('Config', {}).get('Labels', {}).get('io.task-checkpoint.smoke') == name, 'cleanup_owner_mismatch')
            command(['docker', 'rm', '--force', owned['Id']])


def published(plan_path, smoke_path, arch, image, output):
    plan, raw = verify_plan(plan_path); smoke = read(smoke_path); info = image_inspect(image)
    require(smoke['status'] == 'pass' and smoke['plan_sha256'] == digest(raw) and smoke['platform'] == 'linux/' + arch, 'published_smoke_binding')
    require(info['Id'] == smoke['image_id'], 'published_image_not_tested')
    refs = [x for x in info.get('RepoDigests', []) if x.startswith(plan['image_repository'] + '@sha256:')]
    require(len(refs) == 1 and hex_value(refs[0].split('@sha256:')[1], 64), 'published_digest_missing_or_ambiguous')
    write(output, {'schema_version': 'task-checkpoint.image-publication.v1', 'platform': 'linux/' + arch,
                   'plan_sha256': digest(raw), 'image_id': info['Id'], 'reference': refs[0], 'tag': image,
                   'smoke_sha256': digest(Path(smoke_path).read_bytes()), 'source_metadata': plan,
                   'visibility': 'not_verified_push_is_not_public_access'})


def push_checked(plan_path, smoke_path, arch, output):
    """Bind the publication source before tag/push, then retain the pushed digest."""
    plan, raw = verify_plan(plan_path); smoke = read(smoke_path)
    require(smoke['status'] == 'pass' and smoke['plan_sha256'] == digest(raw)
            and smoke['platform'] == 'linux/' + arch, 'published_smoke_binding')
    checked_id = smoke['image_id']
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', checked_id) is not None, 'immutable_image_id_required')
    info = image_inspect(checked_id)
    require(info['Id'] == checked_id and info['Os'] + '/' + info['Architecture'] == 'linux/' + arch, 'published_image_not_tested')
    require(all(info['Config']['Labels'].get(k) == v for k, v in image_labels(plan, arch, digest(raw)).items()), 'image_label_mismatch')
    target = plan['image_repository'] + ':' + plan_outputs(plan, raw)['immutable_tag'] + '-' + arch
    command(['docker', 'tag', checked_id, target])
    require(image_inspect(target)['Id'] == checked_id, 'publication_tag_changed_before_push')
    command(['docker', 'push', target], timeout=3600)
    published(plan_path, smoke_path, arch, target, output)


def index_plan(plan_path, receipts, output):
    plan, raw = verify_plan(plan_path); seen = {}; repository = plan['image_repository']
    for path in receipts:
        receipt = read(path); platform = receipt.get('platform')
        require(receipt.get('schema_version') == 'task-checkpoint.image-publication.v1'
                and receipt.get('plan_sha256') == digest(raw) and receipt.get('source_metadata') == plan, 'platform_receipt_binding')
        require(platform in plan['target_platforms'] and platform not in seen, 'platform_receipt_duplicate_or_unknown')
        require(re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', receipt.get('reference', '')) is not None, 'platform_digest_invalid')
        seen[platform] = receipt['reference']
    require(set(seen) == set(plan['target_platforms']), 'platform_receipt_missing')
    result = {'schema_version': 'task-checkpoint.image-index-plan.v1', 'plan_sha256': digest(raw),
              'tested_platforms': sorted(seen), 'references': [seen[x] for x in sorted(seen)],
              'tags': [repository + ':' + plan_outputs(plan, raw)['immutable_tag'], repository + ':current'],
              'source_metadata': plan, 'visibility': 'not_verified'}
    write(output, result)


def publish_index(path, output):
    plan = read(path)
    require(plan.get('schema_version') == 'task-checkpoint.image-index-plan.v1'
            and plan.get('tested_platforms') == ['linux/amd64', 'linux/arm64'], 'qualified_index_plan_required')
    repository = plan['source_metadata']['image_repository']
    require(len(plan['references']) == 2 and len(set(plan['references'])) == 2
            and all(re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', item) for item in plan['references']), 'index_references')
    require(len(plan['tags']) == 2 and plan['tags'][1] == repository + ':current'
            and re.fullmatch(re.escape(repository) + r':codex-[a-z0-9.-]+', plan['tags'][0]), 'index_tags')
    argv = ['docker', 'buildx', 'imagetools', 'create']
    for tag in plan['tags']:
        argv.extend(['--tag', tag])
    argv.extend(['--annotation', 'index:org.opencontainers.image.source=' + plan['source_metadata']['recorder']['repository']])
    argv.extend(plan['references'])
    command(argv, timeout=180)
    observations = []
    expected = {ref.split('@')[1] for ref in plan['references']}
    for tag in plan['tags']:
        observed = json.loads(command(['docker', 'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}']).stdout)
        require({item['digest'] for item in observed.get('manifests', [])} == expected, 'published_index_members_changed')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', observed.get('digest', '')) is not None, 'published_index_digest_missing')
        observations.append({'tag': tag, 'manifest': observed})
    require(observations[0]['manifest']['digest'] == observations[1]['manifest']['digest'], 'current_tag_does_not_match_qualified_index')
    write(output, {'schema_version': 'task-checkpoint.image-index-publication.v1', 'plan': plan,
                   'observed': observations, 'visibility': 'not_verified_push_is_not_public_access'})


def main():
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan'); p.add_argument('--native-lock', type=Path, required=True); p.add_argument('--base-descriptor', type=Path, required=True)
    p.add_argument('--helper-lock', type=Path, required=True); p.add_argument('--commit', required=True); p.add_argument('--repository', required=True)
    p.add_argument('--run-id', required=True); p.add_argument('--run-attempt', required=True); p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('outputs'); p.add_argument('--plan', type=Path, required=True); p.add_argument('--expected-sha256'); p.add_argument('--github-output', type=Path)
    for name in ('build', 'smoke', 'published'):
        p = sub.add_parser(name); p.add_argument('--plan', type=Path, required=True); p.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
        p.add_argument('--image', required=True); p.add_argument('--output', type=Path, required=True)
        if name == 'build':
            p.add_argument('--source', type=Path, required=True); p.add_argument('--helper-source', type=Path, required=True); p.add_argument('--work', type=Path, required=True)
        elif name == 'published': p.add_argument('--smoke', type=Path, required=True)
    p = sub.add_parser('index-plan'); p.add_argument('--plan', type=Path, required=True); p.add_argument('--receipt', action='append', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('publish-index'); p.add_argument('--index-plan', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('push-checked'); p.add_argument('--plan', type=Path, required=True); p.add_argument('--smoke', type=Path, required=True)
    p.add_argument('--arch', choices=['amd64', 'arm64'], required=True); p.add_argument('--output', type=Path, required=True)
    sub.add_parser('inside-smoke'); p = sub.add_parser('seed-exec'); p.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'plan':
        write(args.output, make_plan(read(args.native_lock), read(args.base_descriptor), read(args.helper_lock),
                                    recorder_commit=args.commit, recorder_version=read(REPO / 'package.json')['version'], repository=args.repository,
                                    protocol_sha=digest((REPO / 'container/app-server-surface.json').read_bytes()), native_lock_sha=digest(args.native_lock.read_bytes()),
                                    run_id=args.run_id, run_attempt=args.run_attempt))
    elif args.command == 'outputs':
        plan, raw = verify_plan(args.plan, args.expected_sha256); outputs = plan_outputs(plan, raw)
        if args.github_output:
            with args.github_output.open('a') as file:
                for key, value in outputs.items():
                    require('\n' not in value and '\r' not in value, 'output_injection')
                    file.write(key + '=' + value + '\n')
        print(json.dumps(outputs))
    elif args.command == 'build': build_image(args.plan, args.source, args.helper_source, args.work, args.arch, args.image, args.output)
    elif args.command == 'smoke': smoke_image(args.plan, args.arch, args.image, args.output)
    elif args.command == 'published': published(args.plan, args.smoke, args.arch, args.image, args.output)
    elif args.command == 'index-plan': index_plan(args.plan, args.receipt, args.output)
    elif args.command == 'publish-index': publish_index(args.index_plan, args.output)
    elif args.command == 'push-checked': push_checked(args.plan, args.smoke, args.arch, args.output)
    elif args.command == 'inside-smoke': print(json.dumps(in_container_smoke()))
    elif args.command == 'seed-exec':
        executable = seed_selection()['executable']; arguments = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
        environment = clean_environment()
        for key in ('OPENROUTER_API_KEY', 'TYPESAFE_API_KEY'): environment.pop(key, None)
        os.execve(executable, [executable, *arguments], environment)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError) as error:
        print(json.dumps({'error': str(error), 'status': 'failed'}), file=sys.stderr)
        raise SystemExit(1)
