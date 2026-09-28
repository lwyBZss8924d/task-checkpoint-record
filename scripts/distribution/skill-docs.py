#!/usr/bin/env python3
"""Project bounded public references into one independently installable Skill."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import stat
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from package import DENIED, RUNTIME_SUFFIXES

ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r'(!?\[[^\]]*\]\()([^\n)]+)(\))')
COPY_SUFFIXES = {'.md', '.txt', '.json', '.yaml', '.yml', '.toml'}


def checked(path: Path) -> bytes:
    if not path.is_relative_to(ROOT):
        raise ValueError('reference_escapes_repository')
    relative = path.relative_to(ROOT)
    if any(part in DENIED or part.startswith('.env.') for part in relative.parts) or path.suffix in RUNTIME_SUFFIXES:
        raise ValueError('private_reference_path')
    cursor = ROOT
    for part in relative.parts:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError('symlink_reference')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 128 * 1024:
        raise ValueError('invalid_reference_input')
    data = path.read_bytes()
    if re.search(rb'/(?:Users|home)/[A-Za-z][^\s/]+/|sk-or-v1-[a-f0-9]{32,}', data):
        raise ValueError('private_marker_in_reference')
    return data


def destination(source: str) -> str:
    if source.startswith(('docs/', 'config/')):
        return 'references/' + source
    return 'references/repository/' + source


def project() -> tuple[Path, dict[str, bytes]]:
    package = json.loads(checked(ROOT / 'package.json'))
    name = package['name']
    skill = ROOT / 'skills' / name
    checked(skill / 'SKILL.md')
    queue = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / 'docs').glob('*.md'))
    queue += sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / 'config').glob('task-checkpoint*.json'))
    if (ROOT / 'config/codex-service.toml').is_file():
        queue.append('config/codex-service.toml')
    projected: dict[str, bytes] = {}
    provenance = []
    external = set()
    seen = set()
    total = 0
    while queue:
        source = queue.pop(0)
        if source in seen:
            continue
        seen.add(source)
        data = checked(ROOT / source)
        total += len(data)
        if len(seen) > 40 or total > 1024 * 1024:
            raise ValueError('reference_projection_budget')
        output = destination(source)
        if Path(source).suffix in {'.md', '.txt'}:
            def rewrite(match):
                raw = match[2].strip()
                if raw.startswith('<'):
                    end = raw.find('>')
                    if end == -1:
                        raise ValueError('invalid_reference_link')
                    target, title = raw[1:end], raw[end + 1:]
                else:
                    parts = raw.split(maxsplit=1)
                    target, title = parts[0], (' ' + parts[1]) if len(parts) > 1 else ''
                parsed = urlsplit(target)
                if parsed.scheme in ('https', 'http', 'mailto') or not parsed.path:
                    return match[0]
                if parsed.scheme:
                    raise ValueError('nonportable_reference_scheme')
                candidate = Path(os.path.normpath(str((ROOT / source).parent / unquote(parsed.path))))
                checked(candidate)
                rel = candidate.relative_to(ROOT).as_posix()
                if candidate.suffix in COPY_SUFFIXES and not rel.startswith('skills/'):
                    queue.append(rel)
                    local = posixpath.relpath(destination(rel), posixpath.dirname(output))
                    new = urlunsplit(('', '', local, parsed.query, parsed.fragment))
                elif rel == 'skills/' + name + '/SKILL.md':
                    new = posixpath.relpath('SKILL.md', posixpath.dirname(output))
                    if parsed.fragment:
                        new += '#' + parsed.fragment
                else:
                    new = 'https://github.com/lwyBZss8924d/' + name + '/blob/main/' + quote(rel)
                    if parsed.fragment:
                        new += '#' + parsed.fragment
                    external.add(new)
                return match[1] + new + title + match[3]
            body = LINK.sub(rewrite, data.decode('utf-8'))
            banner = '> Package reference from `' + source + '`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.\n\n'
            generated = (banner + body).encode()
        else:
            generated = data
        projected[output] = generated
        provenance.append({'source': source, 'destination': output,
                           'source_sha256': hashlib.sha256(data).hexdigest(),
                           'projected_sha256': hashlib.sha256(generated).hexdigest()})
    manifest = {'schema_version': 'skill-docs-projection.v1', 'skill': name,
                'generator': 'scripts/distribution/skill-docs.py',
                'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'files': sorted(provenance, key=lambda row: row['source']),
                'external_source_links': sorted(external)}
    projected['references/source-map.json'] = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    return skill, projected


def verify_links(skill: Path) -> int:
    if skill.is_symlink():
        raise ValueError('symlink_skill_root')
    links = 0
    paths = sorted([*skill.rglob('*.md'), *skill.rglob('*.txt')])
    if len(paths) > 80:
        raise ValueError('skill_link_file_budget')
    for path in paths:
        if path.is_symlink():
            raise ValueError('symlink_in_skill')
        if path.stat().st_size > 128 * 1024:
            raise ValueError('skill_link_byte_budget')
        for match in LINK.finditer(path.read_text()):
            target = match[2].split()[0].strip('<>')
            parsed = urlsplit(target)
            if parsed.scheme in ('https', 'http', 'mailto') or not parsed.path:
                continue
            if parsed.scheme:
                raise ValueError('nonportable_skill_scheme')
            resolved = (path.parent / unquote(parsed.path)).resolve()
            if not resolved.is_relative_to(skill.resolve()) or not resolved.is_file():
                raise ValueError('skill_link_missing_or_escaping:' + str(path.relative_to(skill)) + ':' + target)
            links += 1
    return links


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('write', 'check', 'links'))
    parser.add_argument('--skill-root', type=Path)
    args = parser.parse_args()
    if args.command == 'links':
        if args.skill_root is None:
            raise ValueError('skill_root_required')
        print(json.dumps({'schema_version': 'standalone-skill-links.v1', 'local_links': verify_links(args.skill_root)}))
        return
    skill, expected = project()
    folder = skill / 'references'
    if folder.is_symlink():
        raise ValueError('symlink_reference_output_root')
    existing = {p.relative_to(skill).as_posix() for p in folder.rglob('*') if p.is_file() or p.is_symlink()} if folder.exists() else set()
    if existing - set(expected):
        raise ValueError('unexpected_reference_files')
    for relative in existing:
        path = skill / relative
        if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
            raise ValueError('nonregular_reference_output')
    if args.command == 'write':
        for relative, data in expected.items():
            path = skill / relative
            cursor = skill
            for part in Path(relative).parts:
                cursor /= part
                if cursor.is_symlink():
                    raise ValueError('symlink_reference_output')
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
                raise ValueError('nonregular_reference_output')
            path.write_bytes(data)
    else:
        if existing != set(expected) or any((skill / relative).read_bytes() != data for relative, data in expected.items()):
            raise ValueError('stale_skill_references')
    print(json.dumps({'schema_version': 'skill-docs-check.v1', 'skill': skill.name, 'files': len(expected), 'command': args.command}))


if __name__ == '__main__':
    main()
