"""Regression tests for the instruction-file contract, using isolated fixtures."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from check import check


class GuidanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        files = {
            'AGENTS.md': '# Agent guidance\n\n[Workflow](docs/agents/workflow.md#automatic-merge)\n',
            'CLAUDE.md': '@AGENTS.md\n',
            '.cursor/rules/pull-requests.mdc': '---\nalwaysApply: true\n---\nRead AGENTS.md.\n',
            'docs/agents/workflow.md': '# Workflow\n\n## Automatic merge\n\nCheck the head SHA and required checks. Do not bypass protection.\n',
            'docs/agents/repositories.md': '# Repositories\n',
            'docs/agents/ui-checklist.md': '# UI acceptance\n',
            'docs/agents/checks.md': '# Verification\n',
            'docs/agents/repository-guide.md': '# Domain rules\n',
            'docs/agents/reference-tools.md': '# References\n',
        }
        for name, text in files.items():
            self.write(name, text)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def assert_problem(self, text):
        self.assertTrue(any(text in e for e in check(self.root)), check(self.root))

    def test_valid_standalone_checkout(self):
        self.assertEqual(check(self.root), [])

    def test_missing_required_guide(self):
        (self.root / 'docs/agents/checks.md').unlink()
        self.assert_problem('missing required')

    def test_startup_budget(self):
        self.write('AGENTS.md', 'x' * 8193)
        self.assert_problem('8192')

    def test_claude_import_is_the_only_source(self):
        self.write('CLAUDE.md', 'Follow AGENTS.md.\nNever merge.\n')
        self.assert_problem('@AGENTS.md')

    def test_missing_relative_file(self):
        self.write('docs/agents/checks.md', '[Command](missing.md)\n')
        self.assert_problem('broken link')

    def test_missing_anchor(self):
        self.write('docs/agents/checks.md', '[Flow](workflow.md#missing)\n')
        self.assert_problem('broken anchor')

    def test_rejects_old_merge_policy_in_specialists(self):
        self.write('.claude/agents/qa.md', '---\nname: qa\ndescription: QA\n---\nNever merge.\n')
        self.assert_problem('obsolete merge')

    def test_rejects_duplicate_specialist_names(self):
        for file in ['first', 'second']:
            self.write('.claude/agents/' + file + '.md', '---\nname: qa\ndescription: QA\n---\n[Workflow](../../docs/agents/workflow.md)\n')
        self.assert_problem('duplicate role')

    def test_no_external_local_file_dependency(self):
        self.write('docs/agents/checks.md', '[Guide](../../../outside.md)\n')
        self.assert_problem('outside repository')

    def test_obsolete_german_merge_rule(self):
        self.write('docs/agents/checks.md', 'Ohne diese Bitte bleibt der Pull Request offen.\n')
        self.assert_problem('obsolete merge')

    def test_unverified_merge_contract_is_not_accepted(self):
        self.write('docs/agents/workflow.md', '# Workflow\n\n## Automatic merge\nMerge immediately.\n')
        self.assert_problem('merge contract')


if __name__ == '__main__':
    unittest.main()
