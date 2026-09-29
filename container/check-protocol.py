#!/usr/bin/env python3
"""Check the adapter's reviewed app-server schema surface, without authentication."""
import argparse
import json
from pathlib import Path
import re
import hashlib


def normalized(value, ignored):
    if isinstance(value, dict):
        return {key: normalized(item, ignored) for key, item in value.items() if key not in ignored}
    if isinstance(value, list):
        return [normalized(item, ignored) for item in value]
    return value


def canonical(value):
    # JSON has one number type. Keep booleans distinct while allowing a
    # JavaScript receipt to spell a schema's 0.0 as 0.
    def numbers(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [numbers(x) for x in item]
        if isinstance(item, dict):
            return {key: numbers(x) for key, x in item.items()}
        return item
    value = numbers(value)
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def pointer(document, value):
    if value == '':
        return document
    if not value.startswith('/'):
        raise ValueError('invalid_contract_pointer')
    for part in value.split('/')[1:]:
        part = part.replace('~1', '/').replace('~0', '~')
        document = document[int(part)] if isinstance(document, list) else document[part]
    return document


def verify_schema(document, contract, ignored):
    if document.get('type') != 'object':
        raise ValueError('schema_root_type_changed')
    if sorted(document.get('required', [])) != contract['required']:
        raise ValueError('required_surface_changed:' + contract['file'])
    for check in contract['checks']:
        observed = normalized(pointer(document, check['pointer']), ignored)
        if canonical(observed) != canonical(check['equals']):
            raise ValueError('used_surface_changed:' + contract['file'] + ':' + check['pointer'])


def verify_surface(schema_dir, contract_path, version):
    contract = json.loads(contract_path.read_text())
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('invalid_release_version')
    ignored = set(contract['comparison']['ignored_annotation_keys'])
    observations = []
    for schema in contract['schemas']:
        relative = Path(schema['file'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('invalid_schema_contract_path')
        document = json.loads((schema_dir / relative).read_text())
        verify_schema(document, schema, ignored)
        observations.append({'file': schema['file'], 'type': document['type'],
                             'required': sorted(document.get('required', [])),
                             'checks': [{'pointer': row['pointer'], 'observed': normalized(pointer(document, row['pointer']), ignored)} for row in schema['checks']]})
    return {'schema_version': 'codex-protocol-surface-check.v2', 'version': version,
            'contract_sha256': hashlib.sha256(contract_path.read_bytes()).hexdigest(),
            'schemas': len(observations), 'structural_checks': sum(len(row['checks']) for row in observations),
            'observations': observations, 'result': 'protocol_surface_pass', 'authenticated_model_run': False}


def verify(schema_dir, contract_path, model_policy, version):
    contract = json.loads(contract_path.read_text())
    # The exported authority is deliberately a literal tuple; fail rather than execute
    # arbitrary source code or infer a dynamic expression in a compatibility job.
    match = re.search(r'export const SUPPORTED_CODEX_VERSIONS\s*=\s*(\[[^;]+?\])\s+as const;', model_policy.read_text())
    if not match:
        raise ValueError('supported_version_authority_not_literal')
    authority = json.loads(match.group(1))
    if canonical(authority) != canonical(contract['supported_versions']) or canonical(authority) != canonical(contract['version_authority']['must_equal']):
        raise ValueError('version_authority_drift')
    if version not in authority:
        raise ValueError('unreviewed_codex_version:' + version)
    return verify_surface(schema_dir, contract_path, version)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--schema-dir', required=True, type=Path)
    parser.add_argument('--contract', type=Path, default=Path(__file__).with_name('app-server-surface.json'))
    parser.add_argument('--model-policy', type=Path, default=Path(__file__).resolve().parents[1] / 'src/model-policy.ts')
    parser.add_argument('--version-file', type=Path, required=True)
    parser.add_argument('--qualify-stable', action='store_true', help='Check actual used protocol for a separately official-metadata/digest-qualified stable package; does not admit by version alone.')
    args = parser.parse_args()
    version = re.fullmatch(r'codex-cli ([0-9]+\.[0-9]+\.[0-9]+)', args.version_file.read_text().strip())
    if not version:
        raise ValueError('codex_version_output_unrecognized')
    result = verify_surface(args.schema_dir, args.contract, version.group(1)) if args.qualify_stable else verify(args.schema_dir, args.contract, args.model_policy, version.group(1))
    print(json.dumps(result, sort_keys=True))
