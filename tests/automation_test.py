"""Offline tests: no GitHub or model request is made."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "trigger action" / "trigger_action.py"
spec = importlib.util.spec_from_file_location("automation", source)
automation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(automation)


def valid_result(**overrides):
    return dict({
        "issue_title": "[MEDIUM] Fix cancellation",
        "issue_body": "Problem and proposed fix. PUT_PERMALINK_HERE",
        "severity": "medium", "labels": ["bug", "unknown-label"],
        "summary": "Cancellation needs a guard.",
        "affected_file": "ui/popup/popup.js", "affected_line": 12,
    }, **overrides)


class AutomationTests(unittest.TestCase):
    def test_unconfigured_run_does_not_import_network_clients(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(automation.main(), 0)

    def test_model_result_validation(self):
        files = ["ui/popup/popup.js"]
        self.assertEqual(automation.validate_result(valid_result(), files)["severity"], "medium")
        for invalid in ([], None, valid_result(issue_title=""), valid_result(issue_body=[]),
                        valid_result(labels="bug"), valid_result(severity="unexpected"),
                        valid_result(affected_file="../../secret"), valid_result(affected_line=True),
                        valid_result(affected_line=0), valid_result(summary=[])):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                automation.validate_result(invalid, files)

    def test_issue_deduplication_uses_complete_keys(self):
        issue = lambda body, pr=None: SimpleNamespace(body=body, pull_request=pr)
        self.assertFalse(automation.has_existing_issue([issue(automation.dedup_marker("PR #123"))], "PR #12"))
        self.assertTrue(automation.has_existing_issue([issue(automation.dedup_marker("PR #12"))], "PR #12"))
        self.assertTrue(automation.has_existing_issue([issue("*Generated from PR #12 | Auto-detected role: qa*")], "PR #12"))
        self.assertFalse(automation.has_existing_issue([issue(automation.dedup_marker("PR #12"), object())], "PR #12"))

    def test_permalink_encodes_paths(self):
        self.assertEqual(automation.build_permalink("owner/repo", "actual-head", "trigger action/file.py", 12),
                         "https://github.com/owner/repo/blob/actual-head/trigger%20action/file.py#L12")

    def test_prompt_diff_is_bounded_even_for_one_large_patch(self):
        files = [SimpleNamespace(filename="binary.png", patch=None), SimpleNamespace(filename="large.js", patch="x" * 100000)]
        text, names = automation.collect_diff(files, 10000)
        self.assertEqual(len(text), 10000)
        self.assertEqual(names, ["large.js"])

    def test_pr_pipeline_uses_head_sha_and_existing_labels(self):
        writes = []
        comments = []
        pr = SimpleNamespace(number=12, user=SimpleNamespace(login="trusted"),
                             head=SimpleNamespace(sha="actual-pr-head"), title="Cancellation",
                             body="Details", labels=[],
                             get_files=lambda: [SimpleNamespace(filename="ui/popup/popup.js", patch="+ guard cancellation\n" * 10)],
                             create_issue_comment=comments.append)
        def create_issue(**value):
            writes.append(value)
            return SimpleNamespace(number=42, title=value["title"])
        repo = SimpleNamespace(get_pull=lambda _: pr, get_issues=lambda **_: [],
                               get_labels=lambda: [SimpleNamespace(name="bug"), SimpleNamespace(name="severity: medium")],
                               create_issue=create_issue)
        class FakeGithub:
            def __init__(self, **_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def get_repo(self, _): return repo
        github = SimpleNamespace(Github=FakeGithub, Auth=SimpleNamespace(Token=lambda value: value))
        config = {"GITHUB_TOKEN": "test", "GH_MODELS_TOKEN": "test", "REPOSITORY": "owner/repo",
                  "EVENT_NAME": "pull_request", "PR_NUMBER": "12", "COMMIT_SHA": "merge-sha",
                  "ALLOWED_USER": "trusted"}
        with patch.dict(os.environ, config, clear=True), patch.dict("sys.modules", {"github": github}), \
                patch.object(automation, "call_model", return_value=valid_result()):
            self.assertEqual(automation.main(), 0)
        self.assertEqual(len(writes), 1)
        self.assertIn("/actual-pr-head/ui/popup/popup.js#L12", writes[0]["body"])
        self.assertIn(automation.dedup_marker("PR #12"), writes[0]["body"])
        self.assertEqual(writes[0]["labels"], ["bug", "severity: medium"])
        self.assertEqual(len(comments), 1)
        with patch.dict(os.environ, config, clear=True), patch.dict("sys.modules", {"github": github}), \
                patch.object(automation, "call_model", return_value=valid_result(affected_file="outside.js")):
            self.assertEqual(automation.main(), 0)
        self.assertEqual(len(writes), 1)


if __name__ == "__main__":
    unittest.main()
