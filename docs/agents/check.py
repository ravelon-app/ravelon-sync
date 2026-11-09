"""Check agent guidance without dependencies, network access or product builds."""
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

REQUIRED = (
    'AGENTS.md', 'CLAUDE.md', '.cursor/rules/pull-requests.mdc',
    'docs/agents/workflow.md', 'docs/agents/repositories.md',
    'docs/agents/ui-checklist.md', 'docs/agents/checks.md',
    'docs/agents/repository-guide.md', 'docs/agents/reference-tools.md',
)
STALE = re.compile(
    r'\bnever merge\b|only standing exception|einzige dauerhafte Ausnahme|'
    r'Ohne diese (?:ausdr.ckliche )?(?:Bitte|Aufforderung).*?offen|'
    r'(?:merge|mergen).*?only when.*?explicitly asks|'
    r'(?:nur mergen|mergst du nur|mergen nur).*?ausdr.cklich', re.I,
)


def anchors(text):
    result = set()
    for title in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', text, re.M):
        result.add(re.sub(r'[^\w\- ]', '', title.lower()).replace(' ', '-'))
    return result


def check(root):
    root = root.resolve()
    errors = []
    for name in REQUIRED:
        if not (root / name).is_file():
            errors.append(f'{name}: missing required guidance')
    agents = root / 'AGENTS.md'
    if agents.is_file() and agents.stat().st_size > 8192:
        errors.append('AGENTS.md: startup budget exceeds 8192 bytes; move detail to a scoped guide')
    claude = root / 'CLAUDE.md'
    if claude.is_file() and claude.read_text().strip() != '@AGENTS.md':
        errors.append('CLAUDE.md: use only @AGENTS.md to avoid divergent policy copies')
    workflow = root / 'docs/agents/workflow.md'
    if workflow.is_file():
        text = workflow.read_text()
        if any(part not in text for part in ('## Automatic merge', 'head SHA', 'required', 'Do not bypass')):
            errors.append('workflow.md: merge contract must retain head, checks and protection requirements')

    files = {root / name for name in REQUIRED if (root / name).is_file()}
    for directory, pattern in (('docs/agents', '*.md'), ('.claude/agents', '*.md'),
                               ('.claude/rules', '*.md'), ('.cursor/rules', '*.mdc')):
        files.update((root / directory).glob(pattern))
    roles = {}
    for path in sorted(files):
        name = path.relative_to(root).as_posix()
        text = path.read_text()
        if STALE.search(text):
            errors.append(f'{name}: obsolete merge instruction; use workflow.md')
        if re.search(r'/(?:Users|Volumes)/', text):
            errors.append(f'{name}: machine-specific path; use repository-relative paths')
        if name.startswith('.claude/agents/'):
            match = re.match(r'---\n(.*?)\n---\n', text, re.S)
            header = match.group(1) if match else ''
            role = re.search(r'^name:\s*[\"\']?([\w-]+)', header, re.M)
            if not role or not re.search(r'^description:\s*\S', header, re.M):
                errors.append(f'{name}: role requires name and description frontmatter')
            elif role.group(1) in roles:
                errors.append(f'{name}: duplicate role {role.group(1)} in {roles[role.group(1)]}')
            else:
                roles[role.group(1)] = name
            if '../../docs/agents/workflow.md' not in text:
                errors.append(f'{name}: specialist must reference the shared workflow')
        for raw in re.findall(r'(?<!!)\[[^\]\n]+\]\(([^\s)]+)\)', text):
            target = urlsplit(raw)
            if target.scheme or target.netloc:
                continue
            linked = (path.parent / unquote(target.path)).resolve() if target.path else path
            if not linked.is_relative_to(root):
                errors.append(f'{name}: link outside repository: {raw}')
            elif not linked.exists():
                errors.append(f'{name}: broken link: {raw}')
            elif target.fragment and linked.is_file() and linked.suffix in {'.md', '.mdc'}:
                if unquote(target.fragment) not in anchors(linked.read_text()):
                    errors.append(f'{name}: broken anchor: {raw}')
    return errors


if __name__ == '__main__':
    problems = check(Path(__file__).resolve().parents[2])
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        sys.exit(1)
    print('Agent guidance: budgets, adapters, roles, merge policy and local links passed.')
