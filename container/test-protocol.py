import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('check_protocol', Path(__file__).with_name('check-protocol.py'))
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


class ProtocolBoundaryTests(unittest.TestCase):
    def phase_contract(self):
        contract = json.loads(Path(__file__).with_name('app-server-surface.json').read_text())
        schema = next(row for row in contract['schemas'] if row['file'] == 'v2/ItemCompletedNotification.json')
        check = next(row for row in schema['checks'] if row['pointer'] == '/definitions/MessagePhase')
        return {'file': schema['file'], 'required': [], 'checks': [check]}

    def test_exact_old_and_partial_answer_phase_shapes_pass(self):
        contract = self.phase_contract(); check = contract['checks'][0]
        for value in [check['equals'], *check['accepted_alternatives']]:
            protocol.verify_schema({'type': 'object', 'definitions': {'MessagePhase': value}}, contract, set())

    def test_unknown_phase_and_other_structural_changes_fail(self):
        contract = self.phase_contract(); check = contract['checks'][0]
        for value in [
            {'oneOf': check['accepted_alternatives'][0]['oneOf'] + [{'enum': ['unknown_phase'], 'type': 'string'}]},
            {'type': 'string'},
            {'oneOf': [{'enum': ['partial_answer'], 'type': 'string'}]},
            {'oneOf': list(reversed(check['accepted_alternatives'][0]['oneOf']))},
        ]:
            with self.subTest(value=value), self.assertRaises(protocol.ProtocolSurfaceError) as failure:
                protocol.verify_schema({'type': 'object', 'definitions': {'MessagePhase': value}}, contract, set())
            self.assertEqual((failure.exception.code, failure.exception.schema_file, failure.exception.json_pointer),
                             ('used_surface_changed', contract['file'], check['pointer']))

    def test_missing_pointer_reports_contract_owned_location(self):
        contract = self.phase_contract()
        with self.assertRaises(protocol.ProtocolSurfaceError) as failure:
            protocol.verify_schema({'type': 'object', 'definitions': {}}, contract, set())
        self.assertEqual(failure.exception.code, 'used_surface_missing')
        self.assertEqual(failure.exception.json_pointer, '/definitions/MessagePhase')

    def test_json_integral_float_and_integer_are_equivalent_without_boolean_coercion(self):
        self.assertEqual(protocol.canonical({'minimum': 0.0}), protocol.canonical({'minimum': 0}))
        self.assertNotEqual(protocol.canonical({'minimum': False}), protocol.canonical({'minimum': 0}))

    def test_boolean_and_numeric_const_are_distinct(self):
        contract = {'file': 'synthetic', 'required': [], 'checks': [{'pointer': '/properties/x', 'equals': {'const': 0}}]}
        with self.assertRaisesRegex(ValueError, 'used_surface_changed'):
            protocol.verify_schema({'type': 'object', 'properties': {'x': {'const': False}}}, contract, set())

    def test_required_field_drift_fails(self):
        with self.assertRaisesRegex(ValueError, 'required_surface_changed'):
            protocol.verify_schema({'type': 'object', 'required': ['newRequired']}, {'file': 'synthetic', 'required': [], 'checks': []}, set())

    def test_annotations_and_unused_optional_fields_may_evolve(self):
        document = {'type': 'object', 'properties': {'used': {'type': 'string', 'description': 'new prose'}, 'newOptional': {'type': 'boolean'}}}
        contract = {'file': 'synthetic', 'required': [], 'checks': [{'pointer': '/properties/used', 'equals': {'type': 'string'}}]}
        protocol.verify_schema(document, contract, {'description'})

    def test_unreviewed_latest_fails_before_schema_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            versions = ['0.157.1', '0.158.0']
            (root / 'policy.ts').write_text('export const SUPPORTED_CODEX_VERSIONS = ' + json.dumps(versions) + ' as const;')
            (root / 'contract.json').write_text(json.dumps({'supported_versions': versions, 'version_authority': {'must_equal': versions}}))
            with self.assertRaisesRegex(ValueError, 'unreviewed_codex_version'):
                protocol.verify(root / 'missing', root / 'contract.json', root / 'policy.ts', '0.159.0')


if __name__ == '__main__':
    unittest.main()
