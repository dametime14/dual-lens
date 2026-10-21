#!/usr/bin/env python3
"""Scan only source and Git history; never read home credentials or print matches."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES = {
    'provider-token': r'(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})',
    'jwt': r'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}',
    'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'personal-home-path': r'(?:/Users/|/home/)[A-Za-z0-9_.-]+|/(?:private/)?var/folders/',
    'email': r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b',
    'literal-credential': r'''(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[=:]\s*["'][A-Za-z0-9_+/=.-]{16,}["']''',
    'bearer-token': r'(?i)Bearer\s+[A-Za-z0-9_+/.=-]{24,}',
    'credential-url': r'https?://[^\s/:]+:[^\s/@]+@',
}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deny-term', action='append', default=[])
    args = parser.parse_args()
    allowed = set(json.loads((ROOT / 'public-files.json').read_text()))
    problems = []
    checked = set()

    def report(label, rule, line=None):
        problems.append(f'{label}: {rule}' + (f' (line {line})' if line else ''))

    def scan(label, data):
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            report(label, 'non-text-file')
            return
        if '\0' in text:
            report(label, 'binary-content')
        for rule, pattern in RULES.items():
            for match in re.finditer(pattern, text):
                # Image suffixes in the icon generator are not email addresses.
                if rule == 'email' and re.fullmatch(r'icon_\d+x\d+@2x\.png', match.group()):
                    continue
                report(label, rule, text.count('\n', 0, match.start()) + 1)
        for term in args.deny_term:
            if term and term.casefold() in text.casefold():
                report(label, 'private-deny-term')

    def entry(label, name, mode, oid):
        if name not in allowed:
            report(label + ':' + name, 'not-in-public-file-list')
        if mode not in ('100644', '100755'):
            report(label + ':' + name, 'non-regular-git-entry')
            return
        if oid not in checked:
            checked.add(oid)
            scan(label + ':' + name, git('cat-file', 'blob', oid))

    for name in sorted(allowed):
        path = ROOT / name
        if Path(name).is_absolute() or '..' in Path(name).parts:
            report('public-files.json', 'unsafe-path')
            continue
        if any(part.is_symlink() for part in [path, *path.parents] if part != ROOT.parent):
            report(name, 'symlink')
        elif not path.is_file():
            report(name, 'missing-file')
        else:
            scan('working:' + name, path.read_bytes())

    if not (ROOT / '.git').is_dir():
        report('repository', 'independent-git-directory-required')
    else:
        for row in git('ls-files', '--stage', '-z').split(b'\0'):
            if not row:
                continue
            meta, name = row.decode().split('\t', 1)
            mode, oid, stage = meta.split()
            if stage != '0':
                report(name, 'unmerged-index')
            entry('index', name, mode, oid)
        commits = git('rev-list', '--all').decode().splitlines()
        for commit in commits:
            scan('commit:' + commit[:10], git('show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', commit))
            for row in git('ls-tree', '-r', '-z', commit).split(b'\0'):
                if not row:
                    continue
                meta, name = row.decode().split('\t', 1)
                mode, kind, oid = meta.split()
                entry('history', name, mode, oid)
        # Reflogs are local-only and are never pushed; refs and index above are the publishable objects.
        print(f'Checked {len(allowed)} source files, {len(commits)} commits, {len(checked)} Git blobs.')
    for problem in sorted(set(problems)):
        print('BLOCKED ' + problem)
    if problems:
        return 1
    print('PASS: no matches for configured secret/privacy patterns in the checked source, index and history.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
