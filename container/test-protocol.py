import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('check_protocol', Path(__file__).with_name('check-protocol.py'))
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


class ProtocolBoundaryTests(unittest.TestCase):
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
