import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_update', Path(__file__).with_name('update.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def release(version):
    tag = 'rust-v' + version
    return runtime.resolver.release_lock({'tag_name': tag, 'draft': False, 'prerelease': False,
        'html_url': 'https://github.com/openai/codex/releases/tag/' + tag, 'id': 1, 'published_at': '2026-09-29T00:00:00Z',
        'assets': [{'name': 'codex-package-' + target + '.tar.gz', 'digest': 'sha256:' + hashlib.sha256((version + key).encode()).hexdigest(),
                    'browser_download_url': 'https://github.com/openai/codex/releases/download/' + tag + '/codex-package-' + target + '.tar.gz'}
                   for key, target in runtime.resolver.TARGETS.items()]})


def install_fake(lock, arch, prefix):
    for path in ['bin', 'codex-resources', 'codex-path']:
        (prefix / path).mkdir(parents=True, exist_ok=True)
    for name in ['bin/codex', 'bin/codex-code-mode-host']:
        file = prefix / name
        file.write_text('SYNTHETIC NON-EXECUTED PACKAGE ' + lock['codex_version'])
        file.chmod(0o755)
    (prefix / 'codex-package.json').write_text(json.dumps({'layoutVersion': 1, 'version': lock['codex_version'],
        'target': lock['codex_assets'][arch]['target'], 'variant': 'codex', 'entrypoint': 'bin/codex',
        'resourcesDir': 'codex-resources', 'pathDir': 'codex-path'}))


def qualify_fake(package, lock, arch):
    c = json.loads(runtime.CONTRACT.read_text())
    observations = [{'file': row['file'], 'type': 'object', 'required': row['required'],
        'checks': [{'pointer': x['pointer'], 'observed': x['equals']} for x in row['checks']]} for row in c['schemas']]
    version = lock['codex_version']
    return {'schema_version': 'task-checkpoint.codex-qualification.v1', 'version': version, 'platform': arch,
        'release': lock, 'archive_sha256': lock['codex_assets'][arch]['sha256'], 'package': 'package',
        'entrypoint': 'bin/codex', 'observed_version': 'codex-cli ' + version, 'authenticated_model_run': False,
        'initialize': {'method': 'initialize', 'observed_version': version, 'initialized_notification_sent': True,
                       'threads_started': 0, 'turns_started': 0, 'process_exit_code': 0},
        'protocol': {'schema_version': 'codex-protocol-surface-check.v2', 'version': version,
                     'contract_sha256': runtime.digest(runtime.CONTRACT), 'schemas': len(observations),
                     'structural_checks': sum(len(x['checks']) for x in observations), 'observations': observations,
                     'result': 'protocol_surface_pass', 'authenticated_model_run': False},
        'files': runtime.installer.package_inventory(package)}


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tcr-runtime-test-')
        self.root = Path(self.temp.name).resolve() / 'managed'

    def tearDown(self):
        self.temp.cleanup()

    def ensure(self, version='0.999.0', **overrides):
        options = {'force': True, 'resolve': lambda: release(version), 'install': install_fake, 'qualify_candidate': qualify_fake}
        options.update(overrides)
        return runtime.ensure(self.root, **options)

    def test_automatic_a_to_b_promotion_preserves_a_bytes(self):
        a = self.ensure()
        old = Path(a['selection']['executable']).read_bytes()
        b = self.ensure('0.999.1')
        self.assertEqual((a['status'], b['status']), ('updated', 'updated'))
        self.assertEqual(Path(a['selection']['executable']).read_bytes(), old)
        self.assertEqual(runtime.current(self.root), b['selection'])
        self.assertEqual(len(list((self.root / 'checks').iterdir())), 2)

    def test_corrupt_candidate_retains_last_qualified_selection(self):
        a = self.ensure()
        def fail(*_):
            raise ValueError('codex_archive_sha256_mismatch')
        bad = self.ensure('0.999.1', install=fail)
        self.assertEqual(bad['status'], 'update_failed')
        self.assertFalse(bad['latestCheckSucceeded'])
        self.assertEqual(runtime.current(self.root), a['selection'])
        self.assertEqual(bad['updateFailure']['code'], 'codex_archive_sha256_mismatch')

    def test_protocol_mismatch_cannot_promote(self):
        a = self.ensure()
        def fail(*args):
            value = qualify_fake(*args)
            value['protocol']['observations'][0]['checks'][0]['observed'] = 'changed'
            return value
        bad = self.ensure('0.999.1', qualify_candidate=fail)
        self.assertEqual(bad['status'], 'update_failed')
        self.assertEqual(runtime.current(self.root), a['selection'])

    def test_forced_shutdown_cannot_qualify_or_promote(self):
        a = self.ensure()
        for code in (-9, 1, False):
            def bad_shutdown(*args):
                value = qualify_fake(*args)
                value['initialize']['process_exit_code'] = code
                return value
            bad = self.ensure('0.999.1', qualify_candidate=bad_shutdown)
            self.assertEqual(bad['status'], 'update_failed')
            self.assertEqual(bad['updateFailure']['code'], 'runtime_initialize_evidence_missing')
            self.assertEqual(runtime.current(self.root), a['selection'])

    def test_busy_defers_without_network_or_pointer_write(self):
        a = self.ensure()
        before = (self.root / 'current.json').stat().st_mtime_ns
        with patch.object(runtime.resolver, 'resolve_latest', side_effect=AssertionError('network forbidden')):
            report = self.ensure('0.999.1', busy=True, resolve=lambda: self.fail('network forbidden'))
        self.assertEqual(report['status'], 'deferred_busy')
        self.assertEqual(report['selection'], a['selection'])
        self.assertEqual((self.root / 'current.json').stat().st_mtime_ns, before)

    def test_recent_check_does_not_rediscover(self):
        a = self.ensure()
        report = self.ensure(force=False, resolve=lambda: self.fail('network forbidden'))
        self.assertEqual(report['selection'], a['selection'])

    def test_held_rollback_persists_until_explicit_resume(self):
        a = self.ensure(); b = self.ensure('0.999.1')
        held = runtime.rollback(self.root, '0.999.0')
        self.assertEqual(held['status'], 'held_not_latest')
        self.assertEqual(runtime.current(self.root), a['selection'])
        again = self.ensure('0.999.1', resolve=lambda: self.fail('hold must suppress network'))
        self.assertEqual(again['status'], 'held_not_latest')
        resumed = self.ensure('0.999.1', resume_latest=True)
        self.assertEqual(resumed['selection'], b['selection'])
        self.assertIsNone(runtime.held_selection(self.root))

    def test_rollback_hold_survives_interruption_after_atomic_selection_write(self):
        a = self.ensure(); self.ensure('0.999.1')
        original = runtime.write_atomic
        def interrupted(path, value):
            original(path, value)
            if path.name == 'current.json':
                raise OSError('synthetic interruption before secondary receipt')
        with patch.object(runtime, 'write_atomic', side_effect=interrupted):
            with self.assertRaises(OSError):
                runtime.rollback(self.root, '0.999.0')
        report = self.ensure('0.999.1', resolve=lambda: self.fail('interrupted rollback must remain held'))
        self.assertEqual(report['status'], 'held_not_latest')
        self.assertEqual(report['selection'], a['selection'])

    def test_foreign_root_and_client_home_are_rejected_without_mutation(self):
        self.root.mkdir(); (self.root / 'foreign').write_text('untouched')
        with self.assertRaisesRegex(ValueError, 'foreign_content'):
            self.ensure()
        self.assertEqual([x.name for x in self.root.iterdir()], ['foreign'])
        with self.assertRaisesRegex(ValueError, 'client_or_credential_namespace'):
            runtime.ensure(self.root.parent / '.codex' / 'nested', resolve=lambda: self.fail('no network'))

    def test_existing_empty_root_is_allowed_and_stale_package_refused(self):
        self.root.mkdir()
        a = self.ensure()
        Path(a['selection']['executable']).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'runtime_package_changed'):
            runtime.current(self.root)

    def test_downgrade_from_stable_metadata_is_explicit_failure(self):
        a = self.ensure('0.999.1')
        report = self.ensure('0.999.0')
        self.assertEqual(report['updateFailure']['code'], 'runtime_release_downgrade_refused')
        self.assertEqual(report['selection'], a['selection'])

    def test_draft_and_prerelease_metadata_rejected(self):
        for flag in ['draft', 'prerelease']:
            with self.assertRaisesRegex(ValueError, 'not_stable'):
                runtime.resolver.release_lock({'tag_name': 'rust-v0.999.0', 'draft': False, 'prerelease': False, flag: True})

    def test_real_installer_digest_and_layout_checks_without_network(self):
        lock = release('0.999.0'); arch = runtime.arch_key()
        package = self.root.parent / 'source'; install_fake(lock, arch, package)
        archive = self.root.parent / 'package.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for path in sorted(package.rglob('*')):
                output.add(path, arcname=str(path.relative_to(package)), recursive=False)
        lock['codex_assets'][arch]['sha256'] = runtime.digest(archive)
        out = self.root.parent / 'unpacked'
        receipt = runtime.installer.install(lock, arch, out, archive_path=archive)
        self.assertEqual(receipt['files'], runtime.installer.package_inventory(package))
        lock['codex_assets'][arch]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'sha256_mismatch'):
            runtime.installer.install(lock, arch, self.root, archive_path=archive)
        self.assertFalse(self.root.exists())

    def test_archive_symlink_is_rejected_before_target_creation(self):
        lock = release('0.999.0'); arch = runtime.arch_key(); archive = self.root.parent / 'unsafe.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            item = tarfile.TarInfo('escape'); item.type = tarfile.SYMTYPE; item.linkname = '/tmp'; output.addfile(item)
        lock['codex_assets'][arch]['sha256'] = runtime.digest(archive)
        with self.assertRaisesRegex(ValueError, 'unsafe_archive_member'):
            runtime.installer.install(lock, arch, self.root, archive_path=archive)
        self.assertFalse(self.root.exists())

    def test_managed_child_symlinks_block_before_discovery_staging_or_promotion(self):
        for child in ('versions', 'checks'):
            with self.subTest(child=child):
                root = self.root.parent / ('managed-' + child)
                foreign = self.root.parent / ('foreign-' + child)
                foreign.mkdir()
                runtime.own_root(root)
                if child == 'checks':
                    runtime.ensure(root, force=True, resolve=lambda: release('0.999.0'), install=install_fake, qualify_candidate=qualify_fake)
                    (root / child).rename(root / (child + '-retained'))
                (root / child).symlink_to(foreign, target_is_directory=True)
                before = (root / 'current.json').read_bytes() if (root / 'current.json').exists() else None
                calls = []
                def discovered():
                    calls.append('discovery'); return release('0.999.1')
                def installed(*args):
                    calls.append('install'); return install_fake(*args)
                with self.assertRaisesRegex(ValueError, 'runtime_symlink_denied'):
                    runtime.ensure(root, force=True, resolve=discovered, install=installed, qualify_candidate=qualify_fake)
                self.assertEqual(calls, [])
                self.assertEqual(list(foreign.iterdir()), [])
                after = (root / 'current.json').read_bytes() if (root / 'current.json').exists() else None
                self.assertEqual(after, before)

    def test_atomic_writer_rejects_symlinked_parent_before_temporary_file(self):
        runtime.own_root(self.root)
        foreign = self.root.parent / 'foreign-writer'; foreign.mkdir()
        (self.root / 'checks').symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'runtime_symlink_denied'):
            runtime.write_atomic(self.root / 'checks' / 'receipt.json', {'private': 'synthetic'})
        self.assertEqual(list(foreign.iterdir()), [])

    def test_rollback_refuses_symlinked_audit_child_before_selection_change(self):
        self.ensure(); b = self.ensure('0.999.1')
        foreign = self.root.parent / 'foreign-rollback'; foreign.mkdir()
        (self.root / 'checks').rename(self.root / 'checks-retained')
        (self.root / 'checks').symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'runtime_symlink_denied'):
            runtime.rollback(self.root, '0.999.0')
        self.assertEqual(runtime.current(self.root), b['selection'])
        self.assertIsNone(runtime.held_selection(self.root))
        self.assertEqual(list(foreign.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
