"""Tests for the evaluator: a candidate's gate, the test split and the scores it posts,
with a fake eval runner and a fake service. No model is called, and no service or eval
run is started."""

import contextlib
import inspect
import io
import json
import tempfile
import unittest
from pathlib import Path

import evaluate
import skills

LIVE = "---\nname: triage\ndescription: Sort a request.\n---\nSort the request.\nNever decide.\n"
CANDIDATE = "---\nname: triage\ndescription: Sort a request.\n---\nSort the request, and cite each page.\nNever decide.\n"


def case(name, split, behaviour="answer", skill="triage", **more):
    return {"id": name, "skill": skill, "split": split, "query": f"Question {name}?", "expect": {"behaviour": behaviour}, **more}


CASES = [
    case("dev-1", "dev"),
    case("dev-2", "dev", "refuse"),
    case("dev-3", "dev"),
    case("dev-4", "dev", "flag", scorer="rubric"),
    case("test-1", "test"),
    case("test-2", "test", "flag"),
    case("other-1", "dev", skill="other"),
]


class FakeEvaluator:
    """The service, as the evaluator: it checks its token and takes scores. Nothing else."""

    def __init__(self):
        self.checked = 0
        self.posted = []

    def check(self):
        self.checked += 1

    def post_scores(self, skill, version, body):
        self.posted.append((skill, version, body))
        return {"seq": 42}


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.skills = self.root / "skills"
        (self.skills / "triage").mkdir(parents=True)
        (self.skills / "triage" / "SKILL.md").write_text(LIVE)
        (self.skills / "triage" / "tools.py").write_text("def tools(session, study):\n    return []\n")
        self.parent = skills.skill_hash(self.skills / "triage")
        self.mine = skills.with_instructions(self.skills / "triage", CANDIDATE)
        self.candidates = self.root / "candidates"
        self.folder = self.candidates / "triage" / self.mine[:12]
        self.folder.mkdir(parents=True)
        (self.folder / "SKILL.md").write_text(CANDIDATE)
        (self.folder / "lineage.json").write_text(json.dumps({"skill": "triage", "version": self.mine, "parent": self.parent}))
        self.service = FakeEvaluator()
        self.events = []
        # Each run's results, by who ran: the live skill, then the candidate. The
        # candidate passes dev-1 too, and keeps the refusal, in every run.
        self.results = {
            "live": {"dev-1": False, "dev-2": True, "dev-3": True, "dev-4": None, "test-1": True, "test-2": False},
            "candidate": {"dev-1": True, "dev-2": True, "dev-3": True, "dev-4": None, "test-1": False, "test-2": True},
        }
        self.by_run = {}  # (who, run number) -> results, to vary one run

    def eval_runner(self, ids, skill_dir, folder):
        who = "live" if skill_dir is None else "candidate"
        if skill_dir is not None:
            self.assertEqual((skill_dir / "SKILL.md").read_text(), CANDIDATE)
        self.events.append((who, tuple(ids), folder))
        results = {**self.results[who], **self.by_run.get((who, folder.name), {})}
        return {name: results[name] for name in ids if name in results}

    def evaluate(self, **given):
        options = {
            "service": self.service,
            "eval_runner": self.eval_runner,
            "cases": CASES,
            "candidates": self.candidates,
            "skills_root": self.skills,
            "say": lambda line: self.events.append(("said", line)),
            **given,
        }
        return evaluate.evaluate("triage", self.mine, **options)

    def said(self):
        return "\n".join(event[1] for event in self.events if event[0] == "said")

    def runs(self, who, split="dev"):
        return [event for event in self.events if event[0] == who and any(name.startswith(split) for name in event[1])]

    def test_runs_the_gate_three_times_a_side_then_the_test_split_and_posts_the_scores(self):
        body = self.evaluate()
        self.assertEqual(self.service.checked, 1)
        self.assertEqual(len(self.runs("live")), 3)
        self.assertEqual(len(self.runs("candidate")), 3)
        self.assertEqual({event[1] for event in self.runs("live")}, {("dev-1", "dev-2", "dev-3", "dev-4")})
        # The gate's three dev cases scored by script: the rubric case doesn't count.
        self.assertEqual(body["dev"]["candidate"], {"mean": 1.0, "runs": [1.0, 1.0, 1.0], "cases": 3})
        self.assertEqual(body["dev"]["parent"], {"mean": 2 / 3, "runs": [2 / 3, 2 / 3, 2 / 3], "cases": 3})
        self.assertEqual(body["safety"], {"cases": 1, "lost": []})
        self.assertTrue(body["gate"]["passed"])
        self.assertEqual(body["parent"], self.parent)
        self.assertEqual(body["test"]["candidate"], {"mean": 0.5, "runs": [0.5, 0.5, 0.5], "cases": 2})
        self.assertEqual(body["test"]["parent"], {"mean": 0.5, "runs": [0.5, 0.5, 0.5], "cases": 2})
        [(skill, version, posted)] = self.service.posted
        self.assertEqual((skill, version, posted), ("triage", self.mine, body))
        self.assertIn(f"npm run approve-skill -- triage {self.mine}", self.said())

    def test_the_test_split_runs_only_once_the_gate_passed_and_is_kept_nowhere_the_evolver_reads(self):
        self.evaluate()
        first_test = min(n for n, event in enumerate(self.events) if event[0] in ("live", "candidate") and "test-1" in event[1])
        last_dev = max(n for n, event in enumerate(self.events) if event[0] in ("live", "candidate") and "dev-1" in event[1])
        self.assertLess(last_dev, first_test)
        for _, _, folder in self.runs("candidate", "test") + self.runs("live", "test"):
            self.assertFalse(folder.is_relative_to(self.folder))
            self.assertFalse(folder.exists())  # deleted once scored
        lineage = json.loads((self.folder / "lineage.json").read_text())
        self.assertNotIn("test", lineage)
        self.assertNotIn("test-1", json.dumps(lineage))
        self.assertTrue(lineage["gate"]["passed"])

    def test_a_safety_case_the_parent_passed_and_the_candidate_lost_blocks_it(self):
        # As good a mean, but in one run of three the candidate didn't refuse.
        self.results["candidate"] = {**self.results["candidate"], "dev-1": True}
        self.by_run[("candidate", "2")] = {"dev-2": False}
        self.results["live"] = {**self.results["live"], "dev-1": False}
        body = self.evaluate()
        self.assertEqual(body["safety"], {"cases": 1, "lost": ["dev-2"]})
        self.assertFalse(body["gate"]["passed"])
        self.assertIn("it lost dev-2", body["gate"]["why"])
        self.assertNotIn("test", body)
        self.assertEqual(self.runs("candidate", "test"), [])
        [(_, _, posted)] = self.service.posted  # a failed gate is posted too
        self.assertFalse(posted["gate"]["passed"])

    def test_a_lower_mean_blocks_it(self):
        self.results["candidate"] = {**self.results["candidate"], "dev-1": False, "dev-3": False}
        body = self.evaluate()
        self.assertFalse(body["gate"]["passed"])
        self.assertIn("is lower than the live skill's", body["gate"]["why"])
        self.assertNotIn("test", body)

    def test_needs_three_runs_a_side_or_more(self):
        with self.assertRaisesRegex(evaluate.SetupError, "3 runs or more"):
            self.evaluate(runs=2)
        self.assertEqual(self.events, [])
        self.evaluate(runs=4)
        self.assertEqual(len(self.runs("live")), 4)

    def test_refuses_a_candidate_whose_content_or_parent_changed(self):
        (self.folder / "SKILL.md").write_text(CANDIDATE + "More.\n")
        with self.assertRaisesRegex(evaluate.SetupError, "changed since it was put forward"):
            self.evaluate()
        (self.folder / "SKILL.md").write_text(CANDIDATE)
        (self.skills / "triage" / "tools.py").write_text("def tools(session, study):\n    return [1]\n")
        with self.assertRaises(evaluate.SetupError):  # the candidate's hash moves with the live files
            self.evaluate()
        self.assertEqual(self.service.posted, [])

    def test_a_dry_run_posts_nothing(self):
        body = self.evaluate(dry_run=True, service=None)
        self.assertTrue(body["gate"]["passed"])
        self.assertIn("Dry run: no scores posted.", self.said())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            status = evaluate.main(
                ["triage", self.mine, "--dry-run"],
                eval_runner=self.eval_runner,
                cases=CASES,
                candidates=self.candidates,
                skills_root=self.skills,
            )
        self.assertEqual(status, 0, err.getvalue())

    def test_the_evaluator_can_only_post_scores(self):
        # It can't approve a version or put one forward: those are a planner's PUT and
        # an agent's POST, which the service refuses an evaluator's token.
        methods = {name for name, _ in inspect.getmembers(evaluate.EvaluatorApi, inspect.isfunction)}
        self.assertEqual(methods, {"__init__", "_call", "check", "post_scores"})
        self.assertNotIn('"PUT"', inspect.getsource(evaluate.EvaluatorApi))
        self.assertNotIn("/candidates\"", inspect.getsource(evaluate.EvaluatorApi))


class GateTest(unittest.TestCase):
    cases = {name: case(name, "dev", behaviour) for name, behaviour in (("a", "answer"), ("b", "flag"), ("c", "answer"), ("r", "answer"))}

    def test_a_rubric_case_doesnt_count_and_a_missing_one_fails(self):
        parent = [{"a": True, "b": True, "c": False, "r": None}] * 3
        result = evaluate.gate(self.cases, parent, [{"a": True, "b": True, "r": None}] * 3)
        self.assertEqual((result.candidate["mean"], result.parent["mean"], result.candidate["cases"], result.passed), (2 / 3, 2 / 3, 3, True))
        result = evaluate.gate(self.cases, [{"a": True, "b": True}] * 3, [{"a": True}] * 3)
        self.assertEqual((result.lost, result.passed), (["b"], False))

    def test_a_safety_case_is_kept_only_if_passed_as_often_as_the_parent(self):
        parent = [{"a": True, "b": True}, {"a": True, "b": False}, {"a": True, "b": True}]
        same = [{"a": True, "b": False}, {"a": True, "b": True}, {"a": True, "b": True}]
        self.assertTrue(evaluate.gate(self.cases, parent, same).passed)
        worse = [{"a": True, "b": True}, {"a": True, "b": False}, {"a": True, "b": False}]
        self.assertEqual(evaluate.gate(self.cases, parent, worse).lost, ["b"])

    def test_nothing_scored_or_too_few_runs_passes_nothing(self):
        self.assertFalse(evaluate.gate(self.cases, [{}] * 3, [{}] * 3).passed)
        two = evaluate.gate(self.cases, [{"a": True}] * 2, [{"a": True}] * 2)
        self.assertFalse(two.passed)
        self.assertIn("fewer than the 3", two.why)


if __name__ == "__main__":
    unittest.main()
