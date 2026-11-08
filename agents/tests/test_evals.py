"""Tests for the eval runner, with a fake Gemini.

The end-to-end tests run evals.main() as a real run does: on its own throwaway service,
seeded with the public sources, writing a run file and scoring it.
"""

import contextlib
import io
import json
import os
import re
import signal
import socket
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import httpx2

import core
import evals
from tests import support
from tests.support import FakeGemini, gemini_error, reply

PASSES = {"customer_time": "pass", "productivity": "pass", "ridership_per_dollar": "pass"}
QUOTE = "weekly system ridership increase of 1,680 customers"  # in evals/inputs/lawrence.txt


class SelectTest(unittest.TestCase):
    cases = evals.load_cases()

    def test_the_dev_split_by_default(self):
        chosen = evals.select(self.cases)
        self.assertTrue(chosen)
        self.assertEqual({case["split"] for case in chosen}, {"dev"})
        self.assertEqual(len(evals.select(self.cases, split="all")), len(self.cases))

    def test_named_cases_in_the_order_named_whatever_their_split(self):
        chosen = evals.select(self.cases, ids=["find-003", "find-001", "find-003"])
        self.assertEqual([case["id"] for case in chosen], ["find-003", "find-001"])

    def test_an_unknown_case_is_a_setup_error(self):
        with self.assertRaisesRegex(core.SetupError, "No case nope-001 in evals/cases.jsonl"):
            evals.select(self.cases, ids=["find-001", "nope-001"])

    def test_arguments(self):
        options = evals.parse_args([])
        self.assertEqual((options.split, options.case, options.limit, options.no_skills), ("dev", [], 3, False))
        self.assertTrue(evals.parse_args(["--no-skills"]).no_skills)
        options = evals.parse_args(["--split", "test", "--case", "a", "--case", "b", "--limit", "5"])
        self.assertEqual((options.split, options.case, options.limit), ("test", ["a", "b"], 5))
        for bad in (["--limit", "0"], ["--limit", "x"], ["--split", "nope"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                evals.parse_args(bad)


class PortsTest(unittest.TestCase):
    def test_eval_ports_from_the_environment(self):
        with mock.patch.dict(os.environ, {"EVAL_PORTS": ""}):
            self.assertEqual(evals.ports(), evals.PORTS)
        with mock.patch.dict(os.environ, {"EVAL_PORTS": "4326-4328"}):
            self.assertEqual(list(evals.ports()), [4326, 4327, 4328])
        with mock.patch.dict(os.environ, {"EVAL_PORTS": "4326"}):
            self.assertEqual(list(evals.ports()), [4326])
        for bad in ("x", "4330-4326", "4326-"):
            with mock.patch.dict(os.environ, {"EVAL_PORTS": bad}), self.assertRaisesRegex(core.SetupError, "EVAL_PORTS"):
                evals.ports()


class TaskTest(unittest.TestCase):
    sources = {"ttc-anp-2026": {"title": "2026 Annual Network Plan"}, "rules": {"title": "rules"}}

    def test_names_each_source_with_its_title(self):
        case = {"query": "Is it on time?", "context": ["ttc-anp-2026", "live-vehicles"]}
        self.assertEqual(
            evals.task_for(case, self.sources),
            "Is it on time?\n\nUse these sources: ttc-anp-2026 (2026 Annual Network Plan), "
            "live vehicle positions (the live_vehicles tool).",
        )

    def test_names_inputs_by_names_that_give_nothing_away(self):
        case = {"query": "Assess this proposal.", "inputs": ["rules", "perturbed-low-ridership"]}
        self.assertEqual(evals.task_for(case, self.sources), "Assess this proposal.\n\nUse these sources: rules, document-1.")
        self.assertEqual(evals.input_names(case), {"rules": "rules", "document-1": "perturbed-low-ridership"})

    def test_no_sources(self):
        self.assertEqual(evals.task_for({"query": "Edit the log.", "context": []}, self.sources), "Edit the log.")


class CitationsTest(unittest.TestCase):
    def pages(self, text):
        sources = ["ttc-anp-2026", "ttc-standards-2024", "lawrence", "rules"]
        return [(c["source"], c["page"]) for c in evals.citations(text, sources)]

    def test_the_form_agents_are_told_to_use(self):
        self.assertEqual(self.pages("20 boardings per hour (ttc-anp-2026 p. 115)."), [("ttc-anp-2026", 115)])

    def test_ranges_lists_and_several_sources_at_once(self):
        text = "Split (ttc-anp-2026 pp. 127–128). See (ttc-anp-2026 p. 115, 118 and p. 134; lawrence p. 1)."
        plan = [("ttc-anp-2026", page) for page in (127, 128, 115, 118, 134)]
        self.assertEqual(self.pages(text), [*plan, ("lawrence", 1)])

    def test_other_spellings(self):
        self.assertEqual(self.pages("ttc-anp-2026, page 115"), [("ttc-anp-2026", 115)])
        self.assertEqual(self.pages("(TTC-ANP-2026 p.114)"), [("ttc-anp-2026", 114)])
        self.assertEqual(self.pages("[rules, pages 1-2]"), [("rules", 1), ("rules", 2)])

    def test_numbers_that_arent_pages(self):
        self.assertEqual(self.pages("ttc-anp-2026 p. 115 and 11 riders per $100"), [("ttc-anp-2026", 115)])
        self.assertEqual(self.pages("The plan (ttc-anp-2026) needs 20 boardings an hour."), [])
        self.assertEqual(self.pages("Lawrence–Sunnybrook p. 3, and the rules in general."), [])

    def test_only_the_sources_given_and_each_page_once(self):
        self.assertEqual(self.pages("(other-plan p. 4) (ttc-anp-2026-draft p. 5)"), [])
        self.assertEqual(self.pages("(ttc-anp-2026 p. 115) and (ttc-anp-2026 p. 115)"), [("ttc-anp-2026", 115)])
        self.assertEqual(evals.citations("(ttc-anp-2026 p. 115)", []), [])


class ReadFieldsTest(unittest.TestCase):
    def test_keeps_the_values_the_scorer_knows(self):
        reply = {
            "behaviour": "flag",
            "value": 20.0,
            "decision": None,
            "checks": {"customer_time": "fail", "productivity": None, "safety": "pass"},
        }
        self.assertEqual(
            evals.read_fields(json.dumps(reply)), {"behaviour": "flag", "value": 20, "checks": {"customer_time": "fail"}}
        )
        read = evals.read_fields
        self.assertEqual(read('{"behaviour": "answer", "value": 67.2}'), {"behaviour": "answer", "value": 67.2})
        self.assertEqual(read('{"behaviour": "refuse", "value": true, "decision": "maybe"}'), {"behaviour": "refuse"})

    def test_a_hand_over_is_a_flag_whatever_the_reader_said(self):
        handed = "Customer time fails, the others pass (rules p. 1).\n\nFor a planner to decide: whether the saving outweighs it."
        self.assertEqual(evals.read_fields('{"behaviour": "answer"}', handed), {"behaviour": "flag"})
        self.assertEqual(evals.read_fields('{"behaviour": "refuse"}', handed), {"behaviour": "refuse"})
        self.assertEqual(evals.read_fields('{"behaviour": "answer"}', "20 a week. A planner decides."), {"behaviour": "answer"})

    def test_a_reply_it_cant_read(self):
        with self.assertRaisesRegex(ValueError, "isn't JSON"):
            evals.read_fields("")
        with self.assertRaisesRegex(ValueError, "has no behaviour"):
            evals.read_fields('{"behaviour": "maybe"}')


class StructuredTest(unittest.IsolatedAsyncioTestCase):
    async def test_google_genai_asks_for_json_in_the_schema_without_tools(self):
        """The real client, on a fake transport: what Gemini would receive."""
        bodies = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            bodies.append(json.loads(request.content))
            parts = [{"text": '{"behaviour": "answer", "value": 20, "decision": null, "checks": null}'}]
            candidate = {"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}
            usage = {"promptTokenCount": 70, "candidatesTokenCount": 9, "thoughtsTokenCount": 3}
            return httpx2.Response(200, json={"candidates": [candidate], "usageMetadata": usage})

        client = core.gemini(api_key="fake", async_client_args={"transport": httpx2.MockTransport(handler)})
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": "test-model=1/10"}))
        async with client.aio as aio:
            answer, spent = await evals.structured(aio, "test-model", "How many?", "20 (ttc-anp-2026 p. 115).")

        self.assertEqual(evals.read_fields(answer), {"behaviour": "answer", "value": 20})
        self.assertEqual(spent, {"inputTokens": 70, "outputTokens": 12, "costUsd": 0.00019})
        [body] = bodies
        self.assertNotIn("tools", body)
        asked = body["contents"][0]["parts"][0]["text"]
        self.assertEqual(asked, "Question:\nHow many?\n\nAnswer:\n20 (ttc-anp-2026 p. 115).")
        self.assertIn("behaviour, one of", body["systemInstruction"]["parts"][0]["text"])
        generation = body["generationConfig"]
        self.assertEqual(generation["responseMimeType"], "application/json")
        schema = generation["responseSchema"]
        self.assertEqual(schema["required"], ["behaviour"])
        self.assertEqual(schema["properties"]["behaviour"]["enum"], ["answer", "flag", "abstain", "refuse"])
        self.assertEqual(schema["properties"]["decision"]["enum"], ["adopt", "reject", "defer", "amend"])
        self.assertEqual(
            set(schema["properties"]["checks"]["properties"]), {"customer_time", "productivity", "ridership_per_dollar"}
        )

    async def test_out_of_quota_is_a_model_error(self):
        with self.assertRaises(core.ModelError):
            await evals.structured(FakeGemini(lambda request: gemini_error(429)), "test-model", "How many?", "20.")


class RunCaseTest(unittest.IsolatedAsyncioTestCase):
    """One case on the shared test service, to see what goes in its line when it fails."""

    @classmethod
    def setUpClass(cls):
        support.service.start()

    def setUp(self):
        env = {"LEAD_MODEL": "lead-model", "SPECIALIST_MODEL": "", "READER_MODEL": "reader-model", "MAX_MODEL_CALLS": "2"}
        self.enterContext(mock.patch.dict(os.environ, env))
        self.case = {"id": f"run-{uuid.uuid4().hex[:6]}", "query": "How many riders?", "context": ["test-plan"]}

    async def run_case(self, fake):
        async with support.session() as session:
            return await evals.run_case(session, fake, self.case, {"test-plan": {"title": "Test plan"}})

    async def test_an_unreadable_structured_answer_is_the_cases_error(self):
        answer = "1,680 (test-plan p. 1)."
        fake = FakeGemini(lambda request: reply(text="Not JSON" if request.config.response_mime_type else answer))
        line = await self.run_case(fake)
        self.assertNotIn("answer", line)
        self.assertRegex(line["error"], "^The structured answer isn't JSON")
        self.assertEqual(line["usage"]["agent"], {"inputTokens": 100, "outputTokens": 15, "calls": 1, "costUsd": 0})
        self.assertEqual(line["usage"]["structured"], {"inputTokens": 100, "outputTokens": 15, "costUsd": 0})
        self.assertEqual(line["models"], {"lead": "lead-model", "specialist": core.DEFAULT_MODEL, "reader": "reader-model"})

    async def test_no_answer_is_an_error_without_a_structured_call(self):
        fake = FakeGemini(lambda request: reply(("list_sources", {})))  # never stops
        line = await self.run_case(fake)
        self.assertEqual(line["error"], "Stopped after 2 model calls.")
        self.assertEqual(len(fake.requests), 2)
        self.assertEqual(line["usage"], {"agent": {"inputTokens": 200, "outputTokens": 30, "calls": 2, "costUsd": 0}})

    async def test_a_server_error_is_the_cases_error_not_the_runs(self):
        line = await self.run_case(FakeGemini(lambda request: gemini_error(500)))
        self.assertEqual(line["error"], "Gemini refused lead-model with 500 ERROR, even after retries. Gemini said: Test ERROR")

    async def test_gemini_out_of_reach_stops_the_run_instead(self):
        # Every case after it would wait out the same retries, minutes each.
        with self.assertRaisesRegex(core.ModelError, "^Can't reach Gemini for lead-model"):
            await self.run_case(FakeGemini(lambda request: httpx2.ConnectError("All connection attempts failed")))


def gemini_for_two_cases(request):
    """A lead that asks one specialist, a specialist that reads a page (and, for the
    Lawrence proposal, records a figure from it), and the structured answers."""
    if request.config.response_mime_type == "application/json":
        if "local bus" in request.task:
            return reply(text=json.dumps({"behaviour": "answer", "value": 20}), usage=(50, 5, 0))
        return reply(text=json.dumps({"behaviour": "answer", "decision": "adopt", "checks": PASSES}), usage=(50, 5, 0))
    finding = "local bus" in request.task or "Find" in request.task
    if "ask_specialist" in request.tools:  # the lead
        if request.turn == 0:
            question = "Find the local bus minimum." if finding else "What does the Lawrence proposal forecast?"
            return reply(("ask_specialist", {"question": question, "instructions": "Cite the page."}))
        if finding:
            return reply(text="The peak minimum for a local bus is 20 boardings per service hour (ttc-anp-2026 p. 115).")
        return reply(text="All three tests pass, so adopt it (rules p. 1; document-1 p. 1). A planner decides.")
    if request.turn == 0:  # a specialist
        if finding:
            return reply(("read_page", {"contextId": "ttc-anp-2026", "page": 115}))
        figure = {
            "studyId": re.search(r"working on study ([\w.-]+)\.", request.system)[1],
            "id": "riders",
            "label": "Riders gained a week",
            "unit": "riders/week",
            "value": 1680,
            "basis": {"kind": "cited", "citation": {"contextId": "document-1", "page": 1, "quote": QUOTE}},
        }
        return reply(("read_page", {"contextId": "document-1", "page": 1}), ("record_figure", figure))
    return reply(text="Done (ttc-anp-2026 p. 115)." if finding else "1,680 riders a week (document-1 p. 1).")


class EndToEndTest(unittest.TestCase):
    def setUp(self):
        models = {"LEAD_MODEL": "lead-model", "SPECIALIST_MODEL": "specialist-model", "READER_MODEL": "reader-model"}
        self.enterContext(mock.patch.dict(os.environ, {**models, "MAX_MODEL_CALLS": "", "SPECIALIST_CONCURRENCY": ""}))
        self.runs = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.started = []
        test = self

        class Watched(evals.Service):
            def start(self):
                super().start()
                test.started.append((self.url, self.data))

        self.enterContext(mock.patch.object(evals, "Service", Watched))

    def main(self, args, fake):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = evals.main(args, client=fake, runs=self.runs)
        return status, out.getvalue(), err.getvalue()

    def run_file(self):
        [path] = self.runs.glob("*.jsonl")
        self.assertRegex(path.name, r"^\d{8}T\d{6}Z\.jsonl$")
        return [json.loads(line) for line in path.read_text().splitlines()]

    def assert_cleaned_up(self, services=1):
        self.assertEqual(len(self.started), services)
        for url, data in self.started:
            self.assertFalse(Path(data).exists())
            with socket.socket() as probe:
                self.assertNotEqual(probe.connect_ex(("127.0.0.1", int(url.rsplit(":", 1)[1]))), 0)

    def test_runs_two_cases_keeps_the_answers_and_scores_them(self):
        fake = FakeGemini(gemini_for_two_cases)
        status, out, err = self.main(["--case", "find-009", "--case", "find-001", "--case", "check-001"], fake)

        self.assertEqual(status, 0, err)
        self.assertIn("Skipping find-009: the service has no source ttc-standards-deck-2025.", out)
        self.assertIn("Running 2 cases, each on a service of its own.", out)

        # Each lead was told its sources, and the case inputs could be cited.
        tasks = [r.task for r in fake.requests if "ask_specialist" in r.tools and r.turn == 0]
        self.assertEqual(
            tasks,
            [
                "What is the peak minimum for a local bus, in boardings per service hour?\n\n"
                "Use these sources: ttc-anp-2026 (2026 Annual Network Plan).",
                "Assess this proposal against the rules. Give each test result and a recommendation.\n\n"
                "Use these sources: rules, document-1.",
            ],
        )
        recorded = [dict(r.results) for r in fake.requests if r.results and "record_figure" in dict(r.results)]
        self.assertEqual(recorded[0]["record_figure"]["output"]["value"], 1680)
        structured = [r for r in fake.requests if r.config.response_mime_type == "application/json"]
        self.assertEqual([r.model for r in structured], ["reader-model", "reader-model"])
        self.assertTrue(all(r.config.tools is None and r.config.response_schema is evals.SCHEMA for r in structured))

        found, checked = self.run_file()
        self.assertEqual(
            found,
            {
                "id": "find-001",
                "models": {"lead": "lead-model", "specialist": "specialist-model", "reader": "reader-model"},
                "answer": {
                    "text": "The peak minimum for a local bus is 20 boardings per service hour (ttc-anp-2026 p. 115).",
                    "behaviour": "answer",
                    "value": 20,
                    "citations": [{"source": "ttc-anp-2026", "page": 115}],
                },
                "seconds": found["seconds"],
                # Two lead calls and two specialist calls; the structured call is counted apart.
                "usage": {
                    "agent": {"inputTokens": 400, "outputTokens": 60, "calls": 4, "costUsd": 0},
                    "structured": {"inputTokens": 50, "outputTokens": 5, "costUsd": 0},
                },
            },
        )
        self.assertEqual(checked["id"], "check-001")
        self.assertEqual(
            checked["answer"],
            {
                "text": "All three tests pass, so adopt it (rules p. 1; document-1 p. 1). A planner decides.",
                "behaviour": "answer",
                "decision": "adopt",
                "checks": PASSES,
                "citations": [{"source": "rules", "page": 1}, {"source": "lawrence", "page": 1}],
            },
        )

        self.assertRegex(out, r"Kept 2 answers in .*(\d{8}T\d{6}Z)\.jsonl, and each case's log in .*\1/\.")
        # Each case's log, to see how it reached its answer.
        [path] = self.runs.glob("*.jsonl")
        logs = {log.name: [json.loads(line) for line in log.read_text().splitlines()] for log in path.with_suffix("").iterdir()}
        self.assertEqual(sorted(logs), ["check-001.log.jsonl", "find-001.log.jsonl"])
        self.assertEqual({entry["studyId"] for entry in logs["find-001.log.jsonl"]}, {"study-1"})
        kinds = [entry["data"].get("kind", entry["type"]) for entry in logs["find-001.log.jsonl"]]
        self.assertEqual(kinds[:3], ["study.opened", "usage", "subagent.started"])
        self.assertEqual(kinds.count("usage"), 4)
        self.assertIn("reading", kinds)
        figures = [entry["data"] for entry in logs["check-001.log.jsonl"] if entry["type"] == "figure.recorded"]
        self.assertEqual([(figure["id"], figure["value"]) for figure in figures], [("riders", 1680)])
        for line in ("Passed: 2 of 2 (100%)", "  check  1 of 1 (100%)", "  find   1 of 1 (100%)"):
            self.assertIn(f"\n{line}\n", out)
        self.assertIn("Decisions: 1 of 1 correct (100%): 1 matched, 0 handed over. Rules-only control: 1 of 1 (100%)", out)
        self.assertIn("Citations, over 1 case: recall 1 of 1 expected pages (100%), precision 1 of 1 given (100%)", out)
        self.assert_cleaned_up(services=2)

    def test_stops_when_gemini_runs_out_of_quota_and_keeps_the_answers_so_far(self):
        def respond(request):
            if "Assess this proposal" in request.task:
                return gemini_error(429)
            return gemini_for_two_cases(request)

        status, out, err = self.main(
            ["--case", "find-001", "--case", "check-001", "--case", "find-002", "--limit", "2"], FakeGemini(respond)
        )

        self.assertEqual(status, 1)
        self.assertIn("Running 2 of 3 cases (--limit 2), each on a service of its own.", out)
        self.assertIn("Stopped at check-001: Gemini refused lead-model with 429 RESOURCE_EXHAUSTED", err)
        self.assertEqual([line["id"] for line in self.run_file()], ["find-001"])
        self.assertIn("Kept 1 answer in", out)
        self.assertIn("\nPassed: 1 of 1 (100%)\n", out)
        # The case it stopped at keeps its log too.
        [path] = self.runs.glob("*.jsonl")
        self.assertEqual(sorted(log.name for log in path.with_suffix("").iterdir()), ["check-001.log.jsonl", "find-001.log.jsonl"])
        self.assert_cleaned_up(services=2)

    def test_the_agent_never_sees_the_case_id_or_a_telling_input_name(self):
        def respond(request):
            if request.config.response_mime_type == "application/json":
                return reply(text=json.dumps({"behaviour": "flag"}))
            if request.turn == 0:
                return reply(("list_sources", {}), ("get_study", {"studyId": re.search(r"study ([\w.-]+)", request.system)[1]}))
            return reply(text="A planner must look at this (rules p. 1).")

        fake = FakeGemini(respond)
        status, out, err = self.main(["--case", "stop-005", "--case", "perturbed-001"], fake)

        self.assertEqual(status, 0, err)
        seen = json.dumps([[r.system, r.task, r.results] for r in fake.requests if not r.config.response_mime_type])
        # Not even in a source's title: timestamps and hashes may hold "001", so look for whole names.
        for telling in ("stop-005", "perturbed-001", "perturbed", "injection", "low-ridership"):
            self.assertNotIn(telling, seen)
        self.assertIn("Use these sources: rules, document-1.", seen)

    def test_a_case_cant_read_an_earlier_cases_study(self):
        # Both on the Lawrence proposal: the second mustn't find the first's figures.
        reads = []

        def respond(request):
            if request.config.response_mime_type == "application/json":
                return reply(text=json.dumps({"behaviour": "answer"}))
            if "ask_specialist" in request.tools:  # the lead
                return reply(("ask_specialist", {"question": "What does it forecast?"})) if request.turn == 0 else reply(text="Done.")
            if request.turn == 0:
                return reply(("get_study", {"studyId": "study-1"}))
            reads.append(request.results[0][1])
            return reply(text="Done.")

        status, out, err = self.main(["--case", "check-001", "--case", "perturbed-004"], FakeGemini(respond))

        self.assertEqual(status, 0, err)
        first, second = reads
        self.assertEqual(first["output"]["id"], "study-1")
        self.assertTrue(second["error"].startswith("404 not_found"), second)
        self.assert_cleaned_up(services=2)

    def test_the_reader_is_apart_from_the_leads_model_unless_set_to_it(self):
        self.assertNotEqual(evals.READER_DEFAULT, core.DEFAULT_MODEL)  # by default, not the model that wrote the answer
        def respond(request):
            if request.config.response_mime_type == "application/json":
                return reply(text=json.dumps({"behaviour": "answer", "value": 20}))
            return reply(text="20 boardings per service hour (ttc-anp-2026 p. 115).")

        for reader, lead, said in [("", "lead-model", False), ("lead-model", "lead-model", True)]:
            with self.subTest(reader=reader), mock.patch.dict(os.environ, {"READER_MODEL": reader, "LEAD_MODEL": lead}):
                fake = FakeGemini(respond)
                status, out, err = self.main(["--case", "find-001"], fake)
                self.assertEqual(status, 0, err)
                [structured] = [r for r in fake.requests if r.config.response_mime_type == "application/json"]
                self.assertEqual(structured.model, reader or evals.READER_DEFAULT)
                note = "The reader is lead-model, the lead's own model. Set READER_MODEL to another, to keep them apart."
                self.assertEqual(note in out, said)

    def test_a_run_without_skills_to_show_what_they_add(self):
        listed = []

        def respond(request):
            if request.config.response_mime_type == "application/json":
                return reply(text=json.dumps({"behaviour": "answer", "value": 20}))
            if request.turn == 0:
                return reply(("list_skills", {}))
            listed.append(request.results[0][1])
            return reply(text="20 boardings per service hour (ttc-anp-2026 p. 115).")

        status, out, err = self.main(["--case", "find-001", "--no-skills"], FakeGemini(respond))

        self.assertEqual(status, 0, err)
        self.assertEqual(listed, [{"output": []}])
        [line] = self.run_file()
        self.assertIs(line["skills"], False)
        self.assertRegex(out, r"\d{8}T\d{6}Z\.jsonl: 1 case, lead model lead-model, read by reader-model, without skills\n")

    def test_says_one_of_several_cases(self):
        fake = FakeGemini(gemini_for_two_cases)
        status, out, err = self.main(["--case", "find-001", "--case", "find-002", "--limit", "1"], fake)
        self.assertEqual(status, 0, err)
        self.assertIn("Running 1 of 2 cases (--limit 1), each on a service of its own.", out)

    def test_a_kill_still_removes_the_service_and_its_data(self):
        def respond(request):
            os.kill(os.getpid(), signal.SIGTERM)
            return reply(text="Never read.")

        before = signal.getsignal(signal.SIGTERM)
        with self.assertRaises(SystemExit) as stopped:
            self.main(["--case", "find-001"], FakeGemini(respond))
        self.assertEqual(stopped.exception.code, 128 + signal.SIGTERM)
        self.assertIs(signal.getsignal(signal.SIGTERM), before)
        self.assertEqual(list(self.runs.iterdir()), [])
        self.assert_cleaned_up()

    def test_without_a_key_it_starts_nothing(self):
        self.enterContext(mock.patch.dict(os.environ, {"GEMINI_API_KEY": "", "GOOGLE_API_KEY": ""}))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(evals.main(["--case", "find-001"], runs=self.runs), 1)
        self.assertIn("No Gemini key", err.getvalue())
        self.assertEqual(self.started, [])
        self.assertEqual(list(self.runs.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
