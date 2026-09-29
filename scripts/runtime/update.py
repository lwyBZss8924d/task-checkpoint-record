#!/usr/bin/env python3
"""Dedicated stable Codex selection. No account reads, global CLI edits or models."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
import sys

REPO = Path(__file__).resolve().parents[2]
CONTRACT = REPO / 'container/app-server-surface.json'
OWNER = {'schema_version': 'task-checkpoint.codex-runtime-owner.v1', 'owner': 'task-checkpoint-record'}


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, REPO / 'container' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


resolver = module('tcr_resolver', 'resolve-latest.py')
installer = module('tcr_installer', 'install-codex.py')
protocol = module('tcr_protocol', 'check-protocol.py')


def canonical(value):
    return protocol.canonical(value)


def digest(path):
    return installer.file_digest(path)


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def safe(path, *, owned=False):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(path):
        raise ValueError('runtime_path_not_absolute_canonical')
    if any(x in ('.codex', '.codex-test', '.claude', '.pi', 'auth.json', '.env') for x in path.parts):
        raise ValueError('runtime_root_in_client_or_credential_namespace')
    for parent in [*reversed(path.parents), path]:
        if os.path.lexists(parent):
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('runtime_symlink_denied')
    if owned and path.exists():
        info = path.lstat()
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError('runtime_root_not_owned_private')
    return path


def read_json(path, limit=2 * 1024 * 1024):
    safe(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('runtime_json_not_regular_or_too_large')
        return json.loads(file.read())


def product_version():
    """Source bundles carry package.json; CLI installs retain an owned manifest."""
    package = REPO / 'package.json'
    if os.path.lexists(package):
        metadata = read_json(package)
        if not isinstance(metadata, dict) or metadata.get('name') != 'task-checkpoint-record':
            raise ValueError('runtime_product_identity_invalid')
        version = metadata.get('version')
    else:
        metadata = read_json(REPO / 'manifest.json')
        if not isinstance(metadata, dict) or metadata.get('schema_version') != 'task-checkpoint-record.install-manifest.v1' or metadata.get('owner') != 'task-checkpoint-record.cli.v1':
            raise ValueError('runtime_product_identity_invalid')
        sources = metadata.get('sources')
        if not isinstance(sources, list):
            raise ValueError('runtime_product_identity_invalid')
        selected = [source for source in sources if isinstance(source, dict) and source.get('name') == 'task-checkpoint-record']
        if len(selected) != 1:
            raise ValueError('runtime_product_identity_invalid')
        version = selected[0].get('version')
    if not isinstance(version, str) or len(version) > 128 or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version):
        raise ValueError('runtime_product_identity_invalid')
    return version


def owned_directory(path, *, create=False):
    """Validate fixed managed children before staging, probing or audit writes."""
    safe(path, owned=True)
    if create and not os.path.lexists(path):
        safe(path.parent, owned=True)
        path.mkdir(mode=0o700)
    safe(path, owned=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('runtime_child_not_directory')
    return info


def write_atomic(path, value):
    # Anchor temporary creation and rename to the checked parent descriptor.
    # A corrupt child-directory symlink must never redirect a receipt write.
    safe(path)
    parent = owned_directory(path.parent)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
    temporary = '.' + path.name + '-' + uuid.uuid4().hex
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (parent.st_dev, parent.st_ino):
            raise ValueError('runtime_directory_changed')
        output_fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(output_fd, 'w') as output:
            output.write(canonical(value) + '\n')
            output.flush()
            os.fsync(output.fileno())
        safe(path)
        current_parent = owned_directory(path.parent)
        if (current_parent.st_dev, current_parent.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('runtime_directory_changed')
        os.replace(temporary, path.name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def own_root(root):
    safe(root, owned=True)
    if not root.exists():
        root.mkdir(mode=0o700, parents=True)
    marker = root / 'owner.json'
    if not marker.exists():
        if any(root.iterdir()):
            raise ValueError('runtime_root_foreign_content')
        write_atomic(marker, OWNER)
    elif read_json(marker) != OWNER:
        raise ValueError('runtime_owner_mismatch')


def arch_key():
    pair = (platform.system(), platform.machine().lower())
    names = {('Darwin', 'arm64'): 'darwin-arm64', ('Linux', 'aarch64'): 'arm64',
             ('Linux', 'arm64'): 'arm64', ('Linux', 'x86_64'): 'amd64', ('Linux', 'amd64'): 'amd64'}
    if pair not in names:
        raise ValueError('runtime_platform_unsupported')
    return names[pair]


def clean_env(home):
    result = {key: os.environ[key] for key in ('PATH', 'LANG', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy') if key in os.environ}
    result.update({'HOME': str(home), 'CODEX_HOME': str(home), 'PYTHONDONTWRITEBYTECODE': '1'})
    return result


def native_probe(argv, cwd, env):
    # Children inherit the updater's process group. The TS parent closes that
    # complete owned group on success, timeout, cancellation and failure.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        deadline = time.monotonic() + 60
        try:
            while process.poll() is None:
                if time.monotonic() > deadline or out.tell() + err.tell() > 4 * 1024 * 1024:
                    process.kill()
                    raise ValueError('runtime_probe_budget_exceeded')
                time.sleep(0.025)
            if process.returncode:
                raise ValueError('runtime_probe_failed')
            out.seek(0)
            value = out.read(4 * 1024 * 1024 + 1)
            if len(value) > 4 * 1024 * 1024:
                raise ValueError('runtime_probe_budget_exceeded')
            return value.decode('utf-8')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def initialize_probe(executable, cwd, env, version):
    client_version = product_version()
    with tempfile.TemporaryFile() as err:
        process = subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'], cwd=cwd, env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            request = {'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'task-checkpoint-runtime-qualification', 'version': client_version}, 'capabilities': {'experimentalApi': True}}}
            process.stdin.write((canonical(request) + '\n').encode()); process.stdin.flush()
            deadline = time.monotonic() + 20
            pending = b''; total = 0; reply = None
            while time.monotonic() < deadline and reply is None:
                if not selector.select(0.05):
                    if process.poll() is not None:
                        raise ValueError('runtime_initialize_process_exited')
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise ValueError('runtime_initialize_eof')
                pending += chunk; total += len(chunk)
                if total + err.tell() > 1024 * 1024:
                    raise ValueError('runtime_initialize_output_budget')
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    value = json.loads(line)
                    if value.get('id') == 1:
                        reply = value
            if reply is None or 'error' in reply:
                raise ValueError('runtime_initialize_failed')
            agent = reply.get('result', {}).get('userAgent')
            observed = re.match(r'^[A-Za-z0-9._-]+/([0-9]+\.[0-9]+\.[0-9]+)(?= |$)', agent or '')
            if not observed or observed.group(1) != version:
                raise ValueError('runtime_initialize_version_mismatch')
            process.stdin.write(b'{"method":"initialized","params":{}}\n'); process.stdin.flush()
            process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
                raise ValueError('runtime_initialize_shutdown_timeout')
            if process.returncode != 0:
                raise ValueError('runtime_initialize_exit_failed')
            return {'method': 'initialize', 'user_agent': agent, 'observed_version': version,
                    'initialized_notification_sent': True, 'threads_started': 0, 'turns_started': 0,
                    'process_exit_code': process.returncode}
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()


def qualify(package, lock, arch):
    version = lock['codex_version']
    with tempfile.TemporaryDirectory(prefix='qualification-', dir=package.parent) as temporary:
        probe = Path(temporary)
        home = probe / 'empty-home'
        home.mkdir(mode=0o700)
        (home / 'config.toml').write_text('[features]\napps = false\nhooks = false\nmemories = false\n[otel]\nexporter = "none"\ntrace_exporter = "none"\nlog_user_prompt = false\n[analytics]\nenabled = false\n')
        env = clean_env(home)
        executable = str(package / 'bin/codex')
        observed = native_probe([executable, '--version'], probe, env).strip()
        if observed != 'codex-cli ' + version:
            raise ValueError('runtime_version_identity_mismatch')
        native_probe([executable, 'app-server', 'generate-json-schema', '--experimental', '--out', str(probe / 'schema')], probe, env)
        surface = protocol.verify_surface(probe / 'schema', CONTRACT, version)
        initialized = initialize_probe(executable, probe, env, version)
    return {'schema_version': 'task-checkpoint.codex-qualification.v1', 'version': version,
            'platform': arch, 'release': lock, 'archive_sha256': lock['codex_assets'][arch]['sha256'],
            'package': 'package', 'entrypoint': 'bin/codex', 'qualified_at': now(),
            'protocol': surface, 'files': installer.package_inventory(package),
            'observed_version': observed, 'initialize': initialized, 'authenticated_model_run': False}


def validate_selection(selection):
    executable = safe(Path(selection['executable']))
    receipt_path = safe(Path(selection['qualificationPath']))
    if executable != receipt_path.parent / 'package/bin/codex':
        raise ValueError('runtime_selection_path_mismatch')
    receipt = read_json(receipt_path)
    contract = read_json(CONTRACT)
    if receipt.get('schema_version') != 'task-checkpoint.codex-qualification.v1' or receipt.get('version') != selection['version']:
        raise ValueError('runtime_qualification_identity')
    version = selection['version']
    arch = receipt.get('platform'); release = receipt.get('release', {}); asset = release.get('codex_assets', {}).get(arch, {})
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) or arch not in resolver.TARGETS or release.get('codex_version') != version or release.get('codex_release') != 'https://github.com/openai/codex/releases/tag/rust-v' + version or release.get('discovery', {}).get('url') != resolver.URL or release['discovery'].get('draft') is not False or release['discovery'].get('prerelease') is not False:
        raise ValueError('runtime_official_release_binding')
    if asset.get('target') != resolver.TARGETS[arch] or asset.get('name') != 'codex-package-' + resolver.TARGETS[arch] + '.tar.gz' or not re.fullmatch(r'[a-f0-9]{64}', asset.get('sha256', '')) or receipt.get('archive_sha256') != asset['sha256']:
        raise ValueError('runtime_official_asset_binding')
    if receipt.get('observed_version') != 'codex-cli ' + version or receipt.get('package') != 'package' or receipt.get('entrypoint') != 'bin/codex' or receipt.get('authenticated_model_run') is not False:
        raise ValueError('runtime_qualification_identity')
    if receipt['protocol']['contract_sha256'] != digest(CONTRACT):
        raise ValueError('runtime_protocol_contract_changed')
    initialized = receipt.get('initialize', {})
    if initialized.get('method') != 'initialize' or initialized.get('observed_version') != selection['version'] or initialized.get('initialized_notification_sent') is not True or canonical(initialized.get('threads_started')) != '0' or canonical(initialized.get('turns_started')) != '0' or canonical(initialized.get('process_exit_code')) != '0':
        raise ValueError('runtime_initialize_evidence_missing')
    if canonical(receipt['files']) != canonical(installer.package_inventory(executable.parents[1])):
        raise ValueError('runtime_package_changed')
    metadata = read_json(executable.parents[1] / 'codex-package.json')
    expected_metadata = {'layoutVersion': 1, 'version': version, 'target': resolver.TARGETS[arch], 'variant': 'codex', 'entrypoint': 'bin/codex', 'resourcesDir': 'codex-resources', 'pathDir': 'codex-path'}
    if any(canonical(metadata.get(key)) != canonical(value) for key, value in expected_metadata.items()):
        raise ValueError('runtime_package_identity')
    for path in ['bin/codex', 'bin/codex-code-mode-host']:
        if not (executable.parents[1] / path).stat().st_mode & 0o111:
            raise ValueError('runtime_paired_executables_missing')
    for path in ['codex-resources', 'codex-path']:
        if not (executable.parents[1] / path).is_dir():
            raise ValueError('runtime_resources_missing')
    checks = receipt['protocol'].get('observations', [])
    if len(checks) != len(contract['schemas']):
        raise ValueError('runtime_protocol_observations_missing')
    for observed, expected in zip(checks, contract['schemas']):
        want = {'file': expected['file'], 'type': 'object', 'required': expected['required'],
                'checks': [{'pointer': row['pointer'], 'observed': row['equals']} for row in expected['checks']]}
        if canonical(observed) != canonical(want):
            raise ValueError('runtime_protocol_observations_changed')
    return selection


def current(root):
    if not root.exists():
        return None
    if not (root / 'owner.json').exists():
        if any(root.iterdir()):
            raise ValueError('runtime_root_foreign_content')
        return None
    if read_json(root / 'owner.json') != OWNER:
        raise ValueError('runtime_owner_mismatch')
    if not (root / 'current.json').exists():
        return None
    value = read_json(root / 'current.json')
    selection = value['selection']
    if Path(selection['qualificationPath']).parent.parent != root / 'versions':
        raise ValueError('runtime_selection_outside_owner_root')
    return validate_selection(selection)


def result(status, selection, checked_at=None, succeeded=False, failure=None):
    return {'status': status, 'selection': selection, 'checkedAt': checked_at,
            'latestCheckSucceeded': succeeded, 'updateFailure': failure}


def held_selection(root):
    pointer = read_json(root / 'current.json') if (root / 'current.json').exists() else None
    if pointer and pointer.get('hold'):
        return {**pointer['hold'], 'selection': pointer['selection']}
    # Earlier prepared installations used a second hold file. New operations
    # put selection and hold in one atomic record; retain old reads for recovery.
    return read_json(root / 'hold.json') if (root / 'hold.json').exists() else None


def ensure(root, *, busy=False, force=False, interval_ms=14400000, resume_latest=False, resolve=resolver.resolve_latest,
           install=installer.install, qualify_candidate=qualify):
    root = safe(Path(root), owned=True)
    selection = current(root)
    last = read_json(root / 'latest-check.json') if (root / 'latest-check.json').exists() else None
    if busy:
        return result('deferred_busy', selection, last and last['checkedAt'], False)
    held = held_selection(root)
    if held and not resume_latest:
        if held.get('selection') != selection:
            raise ValueError('runtime_hold_selection_mismatch')
        return result('held_not_latest', selection, held['held_at'], False)
    if not force and not resume_latest and last and (time.time() - datetime.fromisoformat(last['checkedAt'].replace('Z', '+00:00')).timestamp()) * 1000 < interval_ms:
        return {**last, 'selection': selection}
    own_root(root)
    lock_fd = os.open(root / '.update.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(lock_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
        os.close(lock_fd)
        raise ValueError('runtime_lock_boundary')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        return result('update_failed', selection, now(), False, {'code': 'runtime_update_busy'})
    stamp = now()
    candidate = None
    # Re-check hold under the same lock as promotion, including a concurrent
    # operator rollback completed since the initial read.
    try:
        # Check both children before any download, candidate creation, resume or
        # promotion. Checking only at final validation is too late for staging.
        versions = root / 'versions'
        checks = root / 'checks'
        owned_directory(versions, create=True)
        owned_directory(checks, create=True)
        held = held_selection(root)
        if held and not resume_latest:
            held_current = current(root)
            fcntl.flock(lock_fd, fcntl.LOCK_UN); os.close(lock_fd)
            return result('held_not_latest', held_current, held['held_at'], False)
    except Exception:
        fcntl.flock(lock_fd, fcntl.LOCK_UN); os.close(lock_fd)
        raise
    try:
        # Re-read after lock acquisition; never overwrite a newer admitted selection.
        selection = current(root)
        if resume_latest and held_selection(root):
            write_atomic(root / 'current.json', {'schema_version': 'task-checkpoint.codex-selection.v1', 'selection': selection})
            if (root / 'hold.json').exists():
                (root / 'hold.json').unlink()
        release = resolve()
        arch = arch_key()
        version = release['codex_version']
        if selection and tuple(map(int, version.split('.'))) < tuple(map(int, selection['version'].split('.'))):
            raise ValueError('runtime_release_downgrade_refused')
        owned_directory(versions)
        target = versions / (version + '-' + release['codex_assets'][arch]['sha256'])
        safe(target, owned=True)
        if not target.exists():
            candidate = Path(tempfile.mkdtemp(prefix='.candidate-', dir=versions))
            install(release, arch, candidate / 'package')
            qualification = qualify_candidate(candidate / 'package', release, arch)
            write_atomic(candidate / 'qualification.json', qualification)
            prospective = {'version': version, 'executable': str(candidate / 'package/bin/codex'), 'qualificationPath': str(candidate / 'qualification.json')}
            validate_selection(prospective)
            os.rename(candidate, target)
            candidate = None
        selected = validate_selection({'version': version, 'executable': str(target / 'package/bin/codex'), 'qualificationPath': str(target / 'qualification.json')})
        changed = selection != selected
        write_atomic(root / 'current.json', {'schema_version': 'task-checkpoint.codex-selection.v1', 'selection': selected})
        report = result('updated' if changed else 'current', selected, stamp, True)
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z0-9_]+', str(error)) else 'runtime_update_failed'
        report = result('update_failed', selection, stamp, False, {'code': code})
    try:
        owned_directory(checks)
        write_atomic(checks / (uuid.uuid4().hex + '.json'), report)
        write_atomic(root / 'latest-check.json', report)
    finally:
        if candidate is not None:
            # Only this invocation's new staging directory, never retained versions.
            shutil.rmtree(candidate)
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
    return report


def rollback(root, version):
    safe(root, owned=True)
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version or ''):
        raise ValueError('runtime_rollback_version_invalid')
    current(root)
    fd = os.open(root / '.update.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        owned_directory(root / 'versions')
        owned_directory(root / 'checks', create=True)
        choices = [x for x in (root / 'versions').iterdir() if re.fullmatch(re.escape(version) + r'-[a-f0-9]{64}', x.name)]
        if len(choices) != 1:
            raise ValueError('runtime_rollback_version_missing_or_ambiguous')
        selection = validate_selection({'version': version, 'executable': str(choices[0] / 'package/bin/codex'), 'qualificationPath': str(choices[0] / 'qualification.json')})
        stamp = now()
        report = result('held_not_latest', selection, stamp, False)
        write_atomic(root / 'current.json', {'schema_version': 'task-checkpoint.codex-selection.v1', 'selection': selection,
                     'hold': {'held_at': stamp, 'reason': 'explicit_operator_rollback'}})
        write_atomic(root / 'checks' / (uuid.uuid4().hex + '.json'), report)
        return report
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('status', 'plan', 'ensure', 'rollback', 'qualify'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--busy', action='store_true')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--interval-ms', type=int, default=14400000)
    parser.add_argument('--resume-latest', action='store_true')
    parser.add_argument('--version')
    parser.add_argument('--lock', type=Path, help='Fresh official resolved metadata, only for isolated CI qualification.')
    args = parser.parse_args()
    if sys.version_info < (3, 9):
        raise ValueError('python_3_9_required')
    if not 60000 <= args.interval_ms <= 86400000:
        raise ValueError('runtime_interval_out_of_range')
    root = safe(args.root, owned=True)
    if (args.lock is not None) != (args.command == 'qualify'):
        raise ValueError('runtime_lock_only_for_qualification')
    if args.command == 'plan':
        report = {'status': 'resolved_not_qualified', 'release': resolver.resolve_latest(), 'targetRoot': str(root), 'effects': 'none'}
    elif args.command == 'status':
        held = held_selection(root)
        report = {'status': 'held_not_latest' if held else 'inspected', 'selection': current(root), 'hold': held, 'lastCheck': read_json(root / 'latest-check.json') if (root / 'latest-check.json').exists() else None, 'effects': 'none'}
    elif args.command == 'rollback':
        report = rollback(root, args.version)
    elif args.command == 'qualify':
        locked = read_json(safe(args.lock))
        report = ensure(root, force=True, resolve=lambda: locked)
        report['selectionMode'] = 'explicit_official_metadata_lock'
    else:
        report = ensure(root, busy=args.busy, force=args.force, interval_ms=args.interval_ms, resume_latest=args.resume_latest)
    print(canonical(report))
    if report.get('status') == 'update_failed':
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z0-9_]+', str(error)) else 'runtime_update_failed'
        print(canonical({'status': 'update_failed', 'selection': None, 'checkedAt': now(), 'latestCheckSucceeded': False, 'updateFailure': {'code': code}}))
        raise SystemExit(1)
