"""Tests for the skill-evolution loop's proposer, with a fake proposer and a fake service.
No model is called, and no service or eval run is started; one test scores a run file
with evals/score-run.ts, as the loop does. The gate is the evaluator's: test_evaluate.py."""

import contextlib
import inspect
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import evals
import evolve
import skills

LIVE = "---\nname: triage\ndescription: Sort a request.\n---\nSort the request.\nNever decide.\n"
CANDIDATE = "---\nname: triage\ndescription: Sort a request.\n---\nSort the request, and cite each page.\nNever decide.\n"


def case(name, split, behaviour="answer", skill="triage", query=None):
    return {"id": name, "skill": skill, "split": split, "query": query or f"Question {name}?", "expect": {"behaviour": behaviour}}


CASES = [
    case("dev-1", "dev"),
    case("dev-2", "dev", "refuse"),
    case("dev-3", "dev"),
    case("test-1", "test", query="SECRET TEST QUERY?"),
    case("other-1", "dev", skill="other"),
]

# What score-run.ts would say of the run file below.
ROWS = {
    "dev-1": {"id": "dev-1", "passed": False, "failures": ["missing: page"]},
    "dev-2": {"id": "dev-2", "passed": True, "failures": []},
    "test-1": {"id": "test-1", "passed": False, "failures": ["value: wanted 4242, got 1"]},
    "other-1": {"id": "other-1", "passed": False, "failures": ["behaviour: wanted flag, got answer"]},
}


class FakeService:
    """The service: its log, and what was put forward. It has no way to approve."""

    def __init__(self, entries=()):
        self.entries = list(entries)
        self.read = 0
        self.proposed = []

    def log(self):
        self.read += 1
        return self.entries

    def propose(self, skill, body):
        self.proposed.append((skill, body))
        return {"seq": 99}


def version(folder, text=None):
    """The version of the skill in `folder`, or, with `text`, of that skill with `text` as its SKILL.md."""
    return skills.skill_hash(folder) if text is None else skills.with_instructions(folder, text)


class LoopTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.skills = self.root / "skills"
        (self.skills / "triage").mkdir(parents=True)
        (self.skills / "triage" / "SKILL.md").write_text(LIVE)
        (self.skills / "triage" / "tools.py").write_text("def tools(session, study):\n    return []\n")
        self.parent = version(self.skills / "triage")
        self.mine = version(self.skills / "triage", CANDIDATE)
        self.candidates = self.root / "candidates"
        self.runs = self.root / "runs"
        self.runs.mkdir()
        lines = [
            {"id": "dev-1", "answer": {"text": "Sorted, with no page.", "behaviour": "answer"}},
            {"id": "dev-2", "answer": {"text": "I can't decide that.", "behaviour": "refuse"}},
            {"id": "test-1", "answer": {"text": "SECRET TEST ANSWER 1", "behaviour": "answer", "value": 1}},
            {"id": "other-1", "answer": {"text": "Other.", "behaviour": "answer"}},
        ]
        (self.runs / "20261110T000000Z.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        self.prompts = []
        self.events = []  # what happened, in order
        self.service = FakeService()
        self.scored = []
        # The proposer runs no eval case: the evaluator does.
        self.enterContext(mock.patch.object(evals, "main", side_effect=AssertionError("the evolver ran an eval")))

    async def propose(self, text):
        self.prompts.append(text)
        self.events.append("proposed")
        return CANDIDATE, {"model": "fake-model", "inputTokens": 10, "outputTokens": 20}

    def score(self, path):
        self.scored.append(path.name)
        return ROWS

    def evolve(self, **given):
        options = {
            "proposer": self.propose,
            "service": self.service,
            "cases": CASES,
            "runs": self.runs,
            "candidates": self.candidates,
            "skills_root": self.skills,
            "score": self.score,
            "say": lambda line: self.events.append(("said", line)),
            **given,
        }
        return evolve.evolve("triage", **options)

    def said(self):
        return "\n".join(event[1] for event in self.events if event[0] == "said")

    def test_writes_the_candidate_beside_the_live_skill_never_over_it(self):
        folder = self.evolve()
        self.assertEqual(folder, self.candidates / "triage" / self.mine[:12])
        self.assertEqual((folder / "SKILL.md").read_text(), CANDIDATE)
        self.assertEqual((self.skills / "triage" / "SKILL.md").read_text(), LIVE)
        self.assertEqual(sorted(path.name for path in (self.skills / "triage").iterdir()), ["SKILL.md", "tools.py"])
        self.assertFalse(folder.resolve().is_relative_to(self.skills.resolve()))
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["SKILL.md", "changes.diff", "lineage.json"])

    def test_candidates_cant_go_among_the_live_skills(self):
        with self.assertRaisesRegex(evolve.SetupError, "the lead would take them for live skills"):
            self.evolve(candidates=self.skills / "candidates")
        self.assertEqual(self.prompts, [])

    def test_the_test_split_never_reaches_the_proposer(self):
        self.evolve()
        [text] = self.prompts
        self.assertIn("Question dev-1?", text)
        self.assertIn("missing: page", text)
        self.assertIn("Sorted, with no page.", text)
        for secret in ("test-1", "SECRET TEST", "4242"):
            self.assertNotIn(secret, text)
        self.assertNotIn("other-1", text)  # another skill's case
        self.assertNotIn("dev-2", text)  # it passed
        self.assertEqual(self.events.count("proposed"), 1)
        lineage = json.loads((self.candidates / "triage" / self.mine[:12] / "lineage.json").read_text())
        [(_, body)] = self.service.proposed
        for written in (json.dumps(lineage), json.dumps(body)):
            for secret in ("test-1", "SECRET TEST", "4242"):
                self.assertNotIn(secret, written)
        self.assertNotIn("test", lineage)

    def test_records_lineage(self):
        self.service.entries = [
            {"seq": 1, "type": "activity", "actor": "agent:lead", "studyId": "s", "data": {"kind": "subagent.started", "id": "a", "question": "Q", "skill": "triage"}},
            {"seq": 2, "type": "decision.recorded", "actor": "planner:ana", "studyId": "s", "data": {"outcome": "adopt", "reason": "Council asked", "override": True}},
        ]
        folder = self.evolve()
        lineage = json.loads((folder / "lineage.json").read_text())
        self.assertEqual(lineage["skill"], "triage")
        self.assertEqual(lineage["parent"], self.parent)
        self.assertEqual(lineage["version"], self.mine)
        self.assertEqual(lineage["proposer"]["model"], "fake-model")
        self.assertEqual([failure["id"] for failure in lineage["signals"]["failures"]], ["dev-1"])
        self.assertEqual(lineage["signals"]["corrections"], [{"kind": "override", "study": "s", "outcome": "adopt", "reason": "Council asked"}])
        self.assertNotIn("gate", lineage)  # the evaluator's
        self.assertEqual(lineage["submitted"]["seq"], 99)
        diff = (folder / "changes.diff").read_text()
        self.assertIn(f"--- agents/skills/triage/SKILL.md ({self.parent[:12]})", diff)
        self.assertIn("-Sort the request.\n", diff)
        self.assertIn("+Sort the request, and cite each page.\n", diff)

    def test_puts_the_candidate_forward_with_its_hash_diff_and_typed_signals_and_no_scores(self):
        self.service.entries = [
            {"seq": 1, "type": "activity", "actor": "agent:lead", "studyId": "s", "data": {"kind": "subagent.started", "id": "a", "question": "Q", "skill": "triage"}},
            {"seq": 2, "type": "decision.recorded", "actor": "planner:ana", "studyId": "s", "data": {"outcome": "adopt", "reason": "Council asked", "override": True}},
        ]
        folder = self.evolve()
        [(skill, body)] = self.service.proposed
        self.assertEqual(skill, "triage")
        self.assertEqual(sorted(body), ["diff", "parent", "signals", "summary", "version"])
        # Content hashes of the whole folder, scripts and all: approving the candidate's
        # approves exactly the live folder with its SKILL.md.
        self.assertEqual(body["version"], self.mine)
        self.assertEqual(body["parent"], self.parent)
        self.assertRegex(body["version"], r"^[0-9a-f]{64}$")
        self.assertEqual(body["diff"], (folder / "changes.diff").read_text())
        # Typed: case ids and the scorer's reasons, and corrections by kind, with no
        # answer text and no planner's words.
        self.assertEqual(body["signals"], {"failures": [{"case": "dev-1", "why": ["missing: page"]}], "corrections": [{"kind": "override", "study": "s", "outcome": "adopt"}]})
        self.assertNotIn("Sorted, with no page.", json.dumps(body))
        self.assertNotIn("Council asked", json.dumps(body))
        self.assertIn(f"python agents/main.py evaluate-candidate triage {self.mine}", self.said())
        self.assertIn(f"npm run approve-skill -- triage {self.mine}", self.said())
        (self.skills / "triage" / "SKILL.md").write_text(CANDIDATE)
        self.assertEqual(skills.skill_hash(self.skills / "triage"), self.mine)

    def test_never_reads_the_private_split(self):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        canary = "transit-agents private eval canary 7f3c9e21-4b8a"
        private = {**case("private-1", "test", query="PRIVATE QUERY?"), "canary": canary}
        (folder / "cases.jsonl").write_text(json.dumps(private) + "\n")
        loads = self.enterContext(mock.patch.object(evals, "load_cases", return_value=CASES))
        with mock.patch.dict("os.environ", {"EVAL_PRIVATE_DIR": str(folder)}):
            self.evolve(cases=None)
        loads.assert_called_once_with()  # the committed cases only, never private=True
        [text] = self.prompts
        [(_, body)] = self.service.proposed
        for written in (text, json.dumps(body), (self.candidates / "triage" / self.mine[:12] / "lineage.json").read_text()):
            self.assertNotIn(canary, written)
            self.assertNotIn("PRIVATE QUERY", written)
            self.assertNotIn(str(folder), written)

    def test_the_loop_has_no_way_to_approve_a_version_or_post_scores(self):
        # It reads the log and puts a candidate forward; approving is a planner's PUT,
        # and scores the evaluator's POST, which the service refuses an agent's token
        # (services/api/src/app.test.ts).
        methods = {name for name, _ in inspect.getmembers(evolve.ServiceApi, inspect.isfunction)}
        self.assertEqual(methods, {"__init__", "_call", "log", "propose"})
        source = inspect.getsource(evolve)
        self.assertNotIn('"PUT"', source)
        self.assertNotIn("/scores", source)
        self.assertNotIn("eval_runner", inspect.signature(evolve.evolve).parameters)

    def test_a_dry_run_makes_no_service_writes(self):
        folder = self.evolve(dry_run=True)
        self.assertEqual(self.service.proposed, [])
        self.assertEqual(self.service.read, 1)  # it may read planners' corrections
        self.assertTrue((folder / "SKILL.md").exists())
        self.assertNotIn("submitted", json.loads((folder / "lineage.json").read_text()))
        self.assertIn("Dry run: not put forward.", self.said())

    def test_a_dry_run_from_the_command_line_with_no_service(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            status = evolve.main(
                ["triage", "--dry-run"],
                service=None,
                proposer=self.propose,
                cases=CASES,
                runs=self.runs,
                candidates=self.candidates,
                skills_root=self.skills,
                score=self.score,
            )
        self.assertEqual(status, 0, err.getvalue())
        self.assertTrue((self.candidates / "triage" / self.mine[:12] / "SKILL.md").exists())

    def test_a_real_run_needs_the_service(self):
        with self.assertRaisesRegex(evolve.SetupError, "needs the service"):
            self.evolve(service=None)

    def test_nothing_to_improve_calls_no_model(self):
        self.assertIsNone(self.evolve(runs=self.root / "no-runs"))
        self.assertEqual(self.prompts, [])
        self.assertFalse(self.candidates.exists())
        self.assertIn("Nothing to improve", self.said())

    def test_an_unusable_or_unchanged_proposal_writes_no_candidate(self):
        async def renamed(text):
            return CANDIDATE.replace("name: triage", "name: other"), {}

        async def unchanged(text):
            return LIVE, {}

        with self.assertRaisesRegex(evolve.EvolveError, "named 'other', not 'triage'"):
            self.evolve(proposer=renamed)
        with self.assertRaisesRegex(evolve.EvolveError, "unchanged"):
            self.evolve(proposer=unchanged)
        self.assertFalse(self.candidates.exists())

    def test_ignores_answers_without_skills_or_with_a_candidate(self):
        lines = [
            {"id": "dev-3", "skills": False, "answer": {"text": "No skills.", "behaviour": "answer"}},
            {"id": "dev-3", "candidate": {"skill": "triage", "version": "x"}, "answer": {"text": "A candidate's.", "behaviour": "answer"}},
            {"id": "dev-3", "error": "Can't reach the model server"},  # not the skill's doing
        ]
        (self.runs / "20261111T000000Z.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        rows = {"dev-3": {"id": "dev-3", "passed": False, "failures": ["missing: x"]}}
        failures, scored = evolve.dev_failures("triage", CASES, self.runs, lambda path: rows if "1111" in path.name else ROWS)
        self.assertEqual([failure["id"] for failure in failures], ["dev-1"])
        self.assertEqual(scored, 2)


class ScoringTest(unittest.TestCase):
    """The loop reads a run as evals/score-run.ts scores it, on the real cases."""

    def test_finds_a_real_skills_failed_dev_cases_and_never_its_test_cases(self):
        cases = evals.load_cases()
        dev = sorted(c["id"] for c in cases if c["skill"] == "consultation" and c["split"] == "dev" and c.get("scorer") != "rubric")
        test = sorted(c["id"] for c in cases if c["skill"] == "consultation" and c["split"] == "test")
        self.assertTrue(dev and test)
        runs = Path(self.enterContext(tempfile.TemporaryDirectory()))
        wrong = {"text": "A made-up answer.", "behaviour": "answer", "value": -1}
        (runs / "20261112T000000Z.jsonl").write_text("".join(json.dumps({"id": name, "answer": wrong}) + "\n" for name in [dev[0], *test]))
        failures, scored = evolve.dev_failures("consultation", cases, runs)
        self.assertEqual(scored, 1)
        [failure] = failures
        self.assertEqual(failure["id"], dev[0])
        self.assertTrue(failure["why"])
        text = evolve.prompt("---\nname: consultation\n---\nBody", failures, [])
        for name in test:
            self.assertNotIn(name, text)
            self.assertNotIn(next(c["query"] for c in cases if c["id"] == name), text)


class CorrectionsTest(unittest.TestCase):
    def entry(self, seq, kind, data, *, study="s", actor="agent:lead", audience=None):
        return {"seq": seq, "type": kind, "actor": actor, "studyId": study, "audience": audience, "data": data}

    def test_reads_planners_corrections_to_the_skills_work(self):
        activity = lambda seq, data, study="s": self.entry(seq, "activity", data, study=study)  # noqa: E731
        entries = [
            activity(1, {"kind": "subagent.started", "id": "a", "question": "Q", "skill": "triage"}),
            activity(2, {"kind": "subagent.started", "id": "b", "question": "Q", "skill": "other"}),
            activity(3, {"kind": "tool.called", "id": "t1", "name": "record_figure", "subagentId": "a"}),
            activity(4, {"kind": "tool.finished", "id": "t1", "ok": False, "summary": "422 quote_not_found: not on page 3"}),
            activity(5, {"kind": "tool.called", "id": "t2", "name": "record_figure", "subagentId": "b"}),
            activity(6, {"kind": "tool.finished", "id": "t2", "ok": False, "summary": "another skill's"}),
            activity(7, {"kind": "tool.called", "id": "t3", "name": "read_page", "subagentId": "a"}),
            activity(8, {"kind": "tool.finished", "id": "t3", "ok": False, "summary": "a page, not a record"}),
            self.entry(9, "finding.recorded", {"id": "f1", "tone": "positive"}),
            self.entry(10, "finding.rated", {"finding": "f1", "tone": "mixed"}, actor="planner:ana"),
            self.entry(11, "finding.rated", {"finding": "f1", "tone": "negative"}, actor="guest:x", audience="guest:x"),
            self.entry(12, "finding.rated", {"finding": "f1", "tone": "positive"}, actor="planner:ana"),
            self.entry(13, "decision.recorded", {"outcome": "adopt", "reason": "Council asked", "override": True}, actor="planner:ana"),
            self.entry(14, "decision.recorded", {"outcome": "reject", "reason": "Not this skill's study", "override": True}, study="t", actor="planner:ana"),
            self.entry(15, "decision.recorded", {"outcome": "reject", "reason": "As the analysis", "override": False}, actor="planner:ana"),
        ]
        self.assertEqual(
            evolve.corrections(entries, "triage"),
            [
                {"kind": "refused", "study": "s", "tool": "record_figure", "why": "422 quote_not_found: not on page 3"},
                {"kind": "tone", "study": "s", "finding": "f1", "proposed": "positive", "rated": "mixed"},
                {"kind": "override", "study": "s", "outcome": "adopt", "reason": "Council asked"},
            ],
        )
        self.assertEqual(len(evolve.corrections(entries, "triage", most=1)), 1)
        self.assertEqual(evolve.corrections(entries, "nobody"), [])


class ParseTest(unittest.TestCase):
    def test_takes_a_fenced_skill_md(self):
        self.assertEqual(evolve.parse_candidate(f"```markdown\n{CANDIDATE}```", "triage"), CANDIDATE)
        self.assertEqual(evolve.parse_candidate(CANDIDATE, "triage"), CANDIDATE)

    def test_refuses_one_it_cant_read(self):
        for reply, said in (("Here is a better skill.", "can't be read"), ("---\nname: triage\n---\n", "no description")):
            with self.subTest(reply), self.assertRaisesRegex(evolve.EvolveError, said):
                evolve.parse_candidate(reply, "triage")
