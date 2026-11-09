import asyncio
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import anyio
import httpx2
from google.genai import types

import core
import lead
from tests import support
from tests.support import AGENT, SOURCE, URL, FakeGemini, api, gemini_error, reply


def setUpModule():
    support.service.start()


class Notes:
    """A local tool that records what it was called with."""

    def __init__(self):
        self.calls = []
        self.tool = core.LocalTool(
            "note",
            "Keep a note.",
            self.note,
            {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        )

    def note(self, text: str) -> str:
        self.calls.append(text)
        return f"noted {text}"


def cited(page, quote):
    return {"kind": "cited", "citation": {"contextId": SOURCE, "page": page, "quote": quote}}


async def run(fake, study, task="Go.", **options):
    async with support.session() as session:
        return await core.work(
            session, fake, study=study, model="test-model", instructions="Test agent.", task=task, **options
        )


class ToolLoopTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_MODEL_CALLS": "", "TRANSIT_URL": URL}))

    async def test_routes_each_call_to_its_side(self):
        study = support.open_study("routing")
        notes = Notes()
        fake = FakeGemini(
            lambda request: reply(
                ("note", {"text": "hi"}),
                ("list_sources", {}),
                ("read_page", {"contextId": SOURCE, "page": 1}),
                ("nowhere", {}),
                ("get_study", {"studyId": "missing"}),
            )
            if request.turn == 0
            else reply(text="Done.")
        )

        answer = await run(fake, study, local=[notes.tool])

        self.assertEqual(answer, "Done.")
        self.assertEqual(notes.calls, ["hi"])
        results = fake.requests[1].results
        self.assertEqual([name for name, _ in results], ["note", "list_sources", "read_page", "nowhere", "get_study"])
        self.assertEqual(results[0][1], {"output": "noted hi"})
        self.assertIn(SOURCE, [source["id"] for source in results[1][1]["output"]])
        self.assertIn("1,680 customers", results[2][1]["output"]["text"])
        self.assertEqual(results[3][1], {"error": "You have no tool named nowhere."})
        self.assertTrue(results[4][1]["error"].startswith("404 not_found"))
        # Reading a page lights up its source on the display.
        self.assertEqual(
            [(a["contextId"], a["page"]) for a in support.activities(study, "reading")], [(SOURCE, 1)]
        )

    async def test_reports_each_tool_call_as_a_step_with_a_short_summary(self):
        study = support.open_study("steps")
        fake = FakeGemini(
            lambda request: reply(
                ("note", {"text": "hi"}),
                ("read_page", {"contextId": SOURCE, "page": 1}),
                ("nowhere", {}),
            )
            if request.turn == 0
            else reply(text="Done.")
        )

        await run(fake, study, local=[Notes().tool])

        called = support.activities(study, "tool.called")
        finished = support.activities(study, "tool.finished")
        self.assertEqual([c["name"] for c in called], ["read_page", "nowhere", "note"])
        self.assertEqual([c.get("summary") for c in called], [f"{SOURCE} p. 1", None, "text: hi"])
        # Each call's result is paired with it by id: whether it worked, how long it took, and a line on it.
        results = {f["id"]: f for f in finished}
        self.assertEqual([results[c["id"]]["ok"] for c in called], [True, False, True])
        self.assertTrue(all(isinstance(f["ms"], int) for f in finished))
        self.assertEqual(results[called[1]["id"]]["summary"], "You have no tool named nowhere.")
        self.assertEqual(results[called[2]["id"]]["summary"], "8 characters")
        # A page is never put in the log: only its size.
        self.assertNotIn("1,680", json.dumps(finished))
        self.assertTrue(all("subagentId" not in c for c in called))

    def test_a_step_summary_is_one_short_line(self):
        self.assertEqual(core.step_arguments("read_page", {"contextId": "plan", "page": 4}), "plan p. 4")
        self.assertEqual(
            core.step_arguments("search_sources", {"studyId": "s", "query": "riders\n per  km", "limit": 5, "ids": ["a", "b"], "x": {}}),
            "query: riders per km, limit: 5, ids: 2 items",
        )
        self.assertLessEqual(len(core.step_arguments("record_finding", {"text": "word " * 100}) or ""), core.STEP_SUMMARY)
        self.assertIsNone(core.step_arguments("get_study", {"studyId": "s"}))
        self.assertEqual(core.step_answer({"output": [1, 2, 3]}), "3 results")
        self.assertEqual(core.step_answer({"output": {"label": "Riders", "value": 1680.0}}), "Riders: 1680")
        self.assertEqual(core.step_answer({"output": {"title": "Study", "figures": [1, 2]}}), "Study")
        self.assertEqual(core.step_answer({"output": {"figures": [1, 2]}}), "2 figures")
        self.assertEqual(core.step_answer({"output": "x" * 30_000, "note": "Cut"}), "30,000 characters (cut)")
        self.assertEqual(core.step_answer({"error": "404 not_found:\n no study"}), "404 not_found: no study")

    async def test_offers_local_and_service_tools_but_never_report_activity(self):
        study = support.open_study("offered")
        fake = FakeGemini(lambda request: reply(text="Done."))

        await run(fake, study, local=[Notes().tool])

        offered = fake.requests[0].tools
        self.assertTrue({"note", "list_sources", "read_page", "record_figure", "open_study"} <= offered)
        self.assertNotIn("report_activity", offered)
        self.assertNotIn("record_decision", offered)  # planners only, so the service doesn't list it
        self.assertTrue(fake.requests[0].config.automatic_function_calling.disable)

    async def test_allowed_restricts_the_service_tools(self):
        study = support.open_study("allowed")
        other = f"{study}-other"
        fake = FakeGemini(
            lambda request: reply(("open_study", {"id": other, "title": "No"}))
            if request.turn == 0
            else reply(text="Done.")
        )

        await run(fake, study, local=[Notes().tool], allowed={"list_sources", "search_sources"})

        offered = fake.requests[0].tools
        # search_sources only once the service has it.
        self.assertTrue({"note", "list_sources"} <= offered <= {"note", "list_sources", "search_sources"})
        self.assertEqual(fake.requests[1].results, [("open_study", {"error": "You have no tool named open_study."})])
        self.assertNotIn(other, [s["id"] for s in api("GET", "/v1/studies")])

    async def test_writes_only_to_its_own_study(self):
        study = support.open_study("mine")
        theirs = support.open_study("theirs")
        quote = "weekly ridership increase of 1,680 customers"
        planner = {"id": "riders", "label": "Riders", "value": 1680, "basis": cited(1, quote)}
        api("POST", f"/v1/studies/{theirs}/figures", planner)  # a planner's figure in another study

        def figure(study_id, value, page, quote):
            return {"studyId": study_id, "id": "riders", "label": "Riders", "value": value, "basis": cited(page, quote)}

        def need(study_id):
            citation = {"contextId": SOURCE, "page": 1, "quote": quote}
            place = {"place": "Test Station", "lon": -79.4, "lat": 43.7}
            return {"studyId": study_id, "id": "poster", "title": "Poster", **place, "kinds": ["image"], "reason": "Riders there gain a trip.", "citations": [citation]}

        fake = FakeGemini(
            lambda request: reply(
                ("read_page", {"contextId": SOURCE, "page": 2}),
                # A real quote, as a document might ask for, in the other study and the wrong figure.
                ("record_figure", figure(theirs, 25, 2, "It needs 25 more service hours a week.")),
                ("record_finding", {"studyId": theirs, "id": "f", "label": "F", "text": "T", "tone": "neutral"}),
                ("open_study", {"id": f"{study}-new", "title": "New"}),
                ("record_figure", figure(None, 1680, 1, quote)),
                ("record_figure", figure(study, 1680, 1, quote)),
                ("add_engagement_need", need(theirs)),
                ("add_engagement_need", need(study)),
            )
            if request.turn == 0
            else reply(text="Done.")
        )

        await run(fake, study)

        results = [response for _, response in fake.requests[1].results]
        refused = "{}: this run writes only to study " + study + ", so {} must be " + repr(study) + "."
        for name, response in zip(["record_figure", "record_finding"], results[1:3]):
            self.assertEqual(response, {"error": refused.format(name, "studyId")})
        self.assertEqual(results[3], {"error": refused.format("open_study", "id")})
        self.assertIn("error", results[4])
        self.assertEqual(results[5]["output"]["value"], 1680)  # its own study, as before
        self.assertEqual(results[6], {"error": refused.format("add_engagement_need", "studyId")})
        self.assertEqual((results[7]["output"]["id"], results[7]["output"]["addedBy"]), ("poster", "agent:lead"))
        [riders] = api("GET", f"/v1/studies/{theirs}")["figures"]
        self.assertEqual((riders["value"], riders["recordedBy"]), (1680, "planner:demo"))
        self.assertEqual(api("GET", f"/v1/studies/{theirs}")["findings"], [])
        self.assertEqual(api("GET", f"/v1/studies/{theirs}")["needs"], [])
        self.assertNotIn(f"{study}-new", [s["id"] for s in api("GET", "/v1/studies")])

    async def test_reports_usage_after_every_model_call(self):
        study = support.open_study("usage")
        turns = [
            reply(("list_sources", {}), usage=(120, 7, 3)),
            reply(("list_rules", {}), usage=(240, 9, 0)),
            reply(text="Done.", usage=(360, 11, 2)),
        ]
        fake = FakeGemini(lambda request: turns[request.turn])

        await run(fake, study)

        usage = [(a["model"], a["inputTokens"], a["outputTokens"], a["actor"]) for a in support.activities(study, "usage")]
        self.assertEqual(
            usage, [("test-model", 120, 10, "agent:lead"), ("test-model", 240, 9, "agent:lead"), ("test-model", 360, 13, "agent:lead")]
        )

    async def test_reports_each_calls_cost(self):
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": "test-model=1/10/0.1"}))
        study = support.open_study("cost")
        cached = reply(text="Done.", usage=(120, 7, 3))
        cached.usage_metadata.cached_content_token_count = 100
        turns = [reply(("list_rules", {}), usage=(120, 7, 3)), cached]
        fake = FakeGemini(lambda request: turns[request.turn])

        await run(fake, study)

        # 120 in at $1 a million and 10 out at $10; then 100 of the 120 in cached, at $0.10.
        costs = [a["costUsd"] for a in support.activities(study, "usage")]
        self.assertEqual(costs, [0.00022, 0.00013])
        self.assertEqual(api("GET", "/v1/usage")["byStudy"][study]["costUsd"], 0.00035)

    async def test_a_model_with_no_price_reports_no_cost_and_says_so_once(self):
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": ""}))
        study = support.open_study("unpriced")
        turns = [reply(("list_rules", {})), reply(text="Done.")]
        fake = FakeGemini(lambda request: turns[request.turn])

        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            await run(fake, study)

        self.assertEqual([("costUsd" in a) for a in support.activities(study, "usage")], [False, False])
        self.assertEqual(
            stderr.getvalue(),
            "No price for test-model, so its calls are reported without a cost. "
            "Add one with MODEL_PRICES=test-model=<input>/<output>, in US dollars per million tokens.\n",
        )

    async def test_a_call_stopped_before_gemini_answers_is_counted_from_an_estimate(self):
        # As SIGTERM, or another agent's error, stops a run. Gemini may bill the call anyway.
        study = support.open_study("stopped")
        sent = asyncio.Event()

        async def respond(request):
            sent.set()
            await asyncio.sleep(10)  # stopped long before this

        working = asyncio.create_task(run(FakeGemini(respond), study, task="How many riders?"))
        await asyncio.wait_for(sent.wait(), 10)
        working.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await working

        [usage] = support.activities(study, "usage")
        self.assertEqual((usage["model"], usage["outputTokens"]), ("test-model", core.STOPPED_OUTPUT_TOKENS))
        self.assertGreater(usage["inputTokens"], len("Test agent. How many riders?") // core.CHARS_PER_TOKEN)

    async def test_a_try_that_timed_out_is_counted_from_an_estimate_and_takes_a_call(self):
        # Gemini may have run it, and billed it, so it counts in usage, and so in a
        # visitor's budget, and in the run's.
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": "test-model=1/10"}))
        study = support.open_study("timed-out")
        answers = iter([httpx2.ReadTimeout("timed out"), reply(text="Done.")])
        fake = FakeGemini(lambda request: next(answers))
        budget = core.Budget(10)

        self.assertEqual(await run(fake, study, task="How many riders?", budget=budget), "Done.")

        estimate, answer = support.activities(study, "usage")
        self.assertEqual((estimate["model"], estimate["outputTokens"]), ("test-model", core.STOPPED_OUTPUT_TOKENS))
        self.assertGreater(estimate["inputTokens"], len("Test agent. How many riders?") // core.CHARS_PER_TOKEN)
        self.assertEqual((answer["inputTokens"], answer["outputTokens"]), (100, 15))
        self.assertAlmostEqual(budget.spent, estimate["costUsd"] + answer["costUsd"])
        self.assertEqual(budget.left, 9)  # the second try's; the next turn's, never made, went back

    def test_an_estimate_leaves_out_a_files_bytes(self):
        image = types.Part.from_bytes(data=b"\x89PNG" + bytes(400_000), mime_type="image/png")
        contents = [types.Content(role="user", parts=[types.Part(text="Change the headway."), image])]
        estimate = core.estimated_usage(contents, types.GenerateContentConfig(system_instruction="Test agent."))
        self.assertLess(estimate.prompt_token_count, 200)

    async def test_stops_after_the_most_model_calls(self):
        study = support.open_study("limit")
        fake = FakeGemini(lambda request: reply(("list_rules", {})))

        answer = await run(fake, study, max_calls=2)

        self.assertEqual(answer, "Stopped after 2 model calls.")
        self.assertEqual(len(fake.requests), 2)
        self.assertEqual(len(support.activities(study, "usage")), 2)

    async def test_the_last_call_has_its_tools_off_and_runs_no_tool(self):
        study = support.open_study("last-call")
        notes = Notes()

        def respond(request):
            # The model calls a tool every turn, even when told it can't.
            if request.turn == 0:
                return reply(("note", {"text": "first"}))
            return reply(("note", {"text": "too late"}), text="From what I have: noted first.")

        fake = FakeGemini(respond)
        answer = await run(fake, study, local=[notes.tool], max_calls=2)

        self.assertEqual(answer, "From what I have: noted first.")
        self.assertEqual(notes.calls, ["first"])  # no model call is left to read a later one
        first, last = fake.requests
        self.assertIsNone(first.config.tool_config)
        self.assertEqual(last.config.tool_config.function_calling_config.mode, core.types.FunctionCallingConfigMode.NONE)
        self.assertIn("note", last.tools)  # still declared: earlier turns call it
        self.assertNotIn(core.LAST_CALL, first.system)
        self.assertTrue(last.system.endswith(f"Test agent.\n\n{core.LAST_CALL}"))

    async def test_a_local_tool_error_goes_back_to_the_model(self):
        study = support.open_study("local-error")

        def fail(text: str):
            raise ValueError(f"bad {text}")

        tool = core.LocalTool("fail", "Fails.", fail, {"type": "object", "properties": {"text": {"type": "string"}}})
        fake = FakeGemini(lambda request: reply(("fail", {"text": "x"})) if request.turn == 0 else reply(text="Done."))

        await run(fake, study, local=[tool])

        self.assertEqual(fake.requests[1].results, [("fail", {"error": "fail: bad x"})])

    async def test_local_tools_cant_share_a_service_tools_name(self):
        study = support.open_study("clash")
        clash = core.LocalTool("read_page", "Clashes.", lambda: None)

        with self.assertRaisesRegex(ValueError, "read_page"):
            await run(FakeGemini(lambda request: reply(text="Done.")), study, local=[clash])


class ComputedFigureTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_model_cant_type_in_a_computed_figure(self):
        study = support.open_study("computed")
        basis = {"kind": "computed", "skill": "trial-monitor", "version": "abc", "run": "trial weeks 1-2"}
        figure = {"studyId": study, "id": "on-time", "label": "On time", "unit": "%", "value": 99, "basis": basis}
        fake = FakeGemini(lambda request: reply(("record_figure", figure)) if request.turn == 0 else reply(text="Done."))

        await run(fake, study)

        [(name, result)] = fake.requests[1].results
        self.assertRegex(result["error"], "^record_figure: a computed figure comes from a skill's own tool")
        self.assertEqual(api("GET", f"/v1/studies/{study}")["figures"], [])


class LimitTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_MODEL_CALLS": "", "TRANSIT_URL": URL}))

    async def test_a_huge_result_is_cut_and_the_model_told(self):
        study = support.open_study("huge")
        source = f"huge-{os.urandom(3).hex()}"
        page = "Riders. " * 10_000  # 80,000 characters
        api("POST", "/v1/context", {"id": source, "title": "Huge", "folder": "Plans", "pages": [{"page": 1, "text": page}]}, token=support.INTEGRATION)
        fake = FakeGemini(
            lambda request: reply(("read_page", {"contextId": source, "page": 1})) if request.turn == 0 else reply(text="Done.")
        )

        await run(fake, study)

        [(name, result)] = fake.requests[1].results
        self.assertEqual(len(result["output"]), core.RESULT_LIMIT)
        self.assertRegex(result["note"], r"^Cut at 30,000 of 8\d,\d{3} characters\.")

    async def test_each_call_may_write_only_so_much(self):
        fake = FakeGemini(lambda request: reply(text="Done."))
        await run(fake, support.open_study("output"))
        self.assertEqual(fake.requests[0].config.max_output_tokens, core.MAX_OUTPUT_TOKENS)

    async def test_counts_what_it_spends_today(self):
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": "test-model=10000/0"}))  # $1 a call
        before = core.spent_today()
        await run(FakeGemini(lambda request: reply(text="Done.")), support.open_study("spent"))
        self.assertAlmostEqual(core.spent_today() - before, 1.0)

    def test_the_run_budget_stops_at_its_dollars(self):
        budget = core.Budget(10, usd=2.0)
        self.assertTrue(budget.take())
        budget.spend(1.5)
        self.assertTrue(budget.take())
        budget.spend(None)  # a call with no price
        self.assertTrue(budget.take())
        budget.spend(0.5)
        self.assertFalse(budget.take())
        self.assertEqual(budget.left, 7)


class GeminiErrorTest(unittest.IsolatedAsyncioTestCase):
    async def test_429_after_retries_is_a_clear_error(self):
        study = support.open_study("quota")
        sent = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            sent.append(request)
            error = {"code": 429, "message": "You exceeded your current quota.", "status": "RESOURCE_EXHAUSTED"}
            return httpx2.Response(429, json={"error": error})

        self.enterContext(mock.patch.dict(core.RETRY, {"attempts": 3}))
        client = core.gemini(api_key="fake", async_client_args={"transport": httpx2.MockTransport(handler)})
        async with client.aio as aio:
            with self.assertRaises(core.ModelError) as caught:
                await run(aio, study)

        message = str(caught.exception)
        self.assertIn("429 RESOURCE_EXHAUSTED", message)
        self.assertIn("test-model", message)
        self.assertIn("rate limit or quota", message)
        self.assertIn("You exceeded your current quota.", message)
        self.assertEqual(len(sent), 3)  # retried before giving up
        self.assertEqual(support.activities(study, "usage"), [])

    async def test_a_stalled_call_times_out(self):
        """Gemini's address takes the connection and never answers."""
        study = support.open_study("stall")
        self.enterContext(mock.patch.object(core, "TIMEOUT_MS", 200, create=True))  # 5 minutes, really
        accepted = []
        server = await asyncio.start_server(lambda reader, writer: accepted.append(writer), "127.0.0.1", 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        address = "http://127.0.0.1:%d" % server.sockets[0].getsockname()[1]

        client = core.gemini(api_key="fake", base_url=address)
        budget = core.Budget(10)
        async with client.aio as aio:
            with self.assertRaises(core.ModelError) as caught:
                await asyncio.wait_for(run(aio, study, budget=budget), 10)
        self.assertEqual(
            str(caught.exception), "Gemini didn't answer test-model in time, even after retries (ReadTimeout). Try again later."
        )
        # A call that timed out may have run and been billed: one more try at most, from the run's budget.
        self.assertEqual(len(accepted), 2)
        self.assertEqual(budget.left, 9)  # the second try's; its next call, never made, went back
        for writer in accepted:
            writer.close()
        # Each try is counted from an estimate.
        self.assertEqual([u["outputTokens"] for u in support.activities(study, "usage")], [core.STOPPED_OUTPUT_TOKENS] * 2)

    async def test_a_key_in_geminis_text_is_hidden(self):
        study = support.open_study("key-in-error")
        shaped = "AIzaSyFAKE-not-a-real-key-0123456789abc"
        configured = "configured-test-key-123"
        self.enterContext(mock.patch.dict(os.environ, {"GEMINI_API_KEY": configured}))

        def handler(request: httpx2.Request) -> httpx2.Response:
            said = f"Permission denied: Consumer 'api_key:{shaped}' has been suspended. Key {configured}."
            return httpx2.Response(403, json={"error": {"code": 403, "message": said, "status": "PERMISSION_DENIED"}})

        client = core.gemini(api_key="fake", async_client_args={"transport": httpx2.MockTransport(handler)})
        async with client.aio as aio:
            with self.assertRaises(core.ModelError) as caught:
                await run(aio, study)

        message = str(caught.exception)
        self.assertNotIn(shaped, message)
        self.assertNotIn(configured, message)
        self.assertIn("Consumer 'api_key:[key]' has been suspended. Key [key].", message)

    def test_a_key_gemini_names_is_hidden_whatever_its_shape(self):
        self.assertEqual(core.redact("Consumer 'api_key:some-other-key' has been suspended."), "Consumer 'api_key:[key]' has been suspended.")

    async def test_503_after_retries_is_a_clear_error(self):
        study = support.open_study("busy")
        fake = FakeGemini(lambda request: gemini_error(503))

        with self.assertRaisesRegex(core.ModelError, "test-model is overloaded \\(503 UNAVAILABLE\\)"):
            await run(fake, study)

    async def test_every_other_refusal_is_one_line_too(self):
        study = support.open_study("bad-request")
        cases = {
            400: "Gemini refused test-model with 400 ERROR. Gemini said: Test ERROR",
            404: "Gemini refused test-model with 404 ERROR. Check LEAD_MODEL and SPECIALIST_MODEL. Gemini said: Test ERROR",
            500: "Gemini refused test-model with 500 ERROR, even after retries. Gemini said: Test ERROR",
        }
        for code, message in cases.items():
            with self.subTest(code):
                fake = FakeGemini(lambda request: gemini_error(code))
                with self.assertRaises(core.ModelError) as caught:
                    await run(fake, study)
                self.assertEqual(str(caught.exception), message)
                self.assertIsInstance(caught.exception.__cause__, core.errors.APIError)

    async def test_gemini_out_of_reach_is_one_line(self):
        study = support.open_study("unreachable")
        fake = FakeGemini(lambda request: httpx2.ConnectError("All connection attempts failed"))

        with self.assertRaises(core.ModelError) as caught:
            await run(fake, study)

        self.assertEqual(
            str(caught.exception),
            "Can't reach Gemini for test-model, even after retries: All connection attempts failed. "
            "Check the network, and GOOGLE_GEMINI_BASE_URL if it's set.",
        )

    async def test_google_genai_sends_every_tool_and_result(self):
        """The real client, on a fake transport: what Gemini would receive."""
        study = support.open_study("wire")
        notes = Notes()
        bodies = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            bodies.append(json.loads(request.content))
            if len(bodies) == 1:
                parts = [
                    {"functionCall": {"id": "a", "name": "note", "args": {"text": "hi"}}},
                    {"functionCall": {"id": "b", "name": "list_rules", "args": {}}},
                ]
                usage = {"promptTokenCount": 50, "candidatesTokenCount": 5, "thoughtsTokenCount": 4}
            else:
                parts = [{"text": "Done (test-plan p. 1)."}]
                usage = {"promptTokenCount": 80, "candidatesTokenCount": 6}
            candidate = {"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}
            return httpx2.Response(200, json={"candidates": [candidate], "usageMetadata": usage})

        client = core.gemini(api_key="fake", async_client_args={"transport": httpx2.MockTransport(handler)})
        async with client.aio as aio:
            answer = await run(aio, study, local=[notes.tool])

        self.assertEqual(answer, "Done (test-plan p. 1).")
        self.assertEqual(notes.calls, ["hi"])
        declared = {d["name"]: d for tool in bodies[0]["tools"] for d in tool["functionDeclarations"]}
        self.assertTrue({"note", "list_sources", "read_page"} <= declared.keys())
        self.assertNotIn("report_activity", declared)
        self.assertEqual(declared["note"]["parameters"]["required"], ["text"])
        self.assertEqual(bodies[0]["systemInstruction"]["parts"][0]["text"], "Test agent.")
        answered = [part["functionResponse"] for part in bodies[1]["contents"][-1]["parts"]]
        self.assertEqual([(r["id"], r["name"]) for r in answered], [("a", "note"), ("b", "list_rules")])
        self.assertEqual(answered[0]["response"], {"output": "noted hi"})
        usage = [(a["inputTokens"], a["outputTokens"]) for a in support.activities(study, "usage")]
        self.assertEqual(usage, [(50, 9), (80, 6)])

    async def test_google_genai_sends_the_last_call_with_tools_off(self):
        study = support.open_study("wire-last")
        bodies = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            bodies.append(json.loads(request.content))
            candidate = {"content": {"role": "model", "parts": [{"text": "Done."}]}, "finishReason": "STOP"}
            return httpx2.Response(200, json={"candidates": [candidate]})

        client = core.gemini(api_key="fake", async_client_args={"transport": httpx2.MockTransport(handler)})
        async with client.aio as aio:
            self.assertEqual(await run(aio, study, local=[Notes().tool], max_calls=1), "Done.")

        [body] = bodies
        self.assertEqual(body["toolConfig"], {"functionCallingConfig": {"mode": "NONE"}})
        self.assertIn("note", [d["name"] for tool in body["tools"] for d in tool.get("functionDeclarations", [])])
        self.assertTrue(body["systemInstruction"]["parts"][0]["text"].endswith(core.LAST_CALL))


class SessionTest(unittest.IsolatedAsyncioTestCase):
    async def test_errors_raised_inside_the_session_come_out_unwrapped(self):
        with self.assertRaisesRegex(KeyError, "mine"):
            async with support.session():
                raise KeyError("mine")

    async def test_a_reply_after_the_session_closed_is_no_error(self):
        # A cancelled call's reply can reach the transport as it closes, which then
        # raises BrokenResourceError: nothing waits for that reply.
        real = core.streamable_http_client

        @contextlib.asynccontextmanager
        async def late_reply(*args, **kwargs):
            async with real(*args, **kwargs) as streams:
                yield streams
            raise BaseExceptionGroup("unhandled errors in a TaskGroup", [anyio.BrokenResourceError()])

        self.enterContext(mock.patch.object(core, "streamable_http_client", late_reply))
        async with core.open_session(URL, AGENT) as session:
            self.assertIn(SOURCE, [source["id"] for source in await core.call(session, "list_sources")])
        # The caller's own error still comes out as it was.
        with self.assertRaisesRegex(KeyError, "mine"):
            async with core.open_session(URL, AGENT):
                raise KeyError("mine")

    async def test_a_cancel_stays_a_cancel_when_a_late_reply_breaks_the_close(self):
        real = core.streamable_http_client

        @contextlib.asynccontextmanager
        async def late_reply(*args, **kwargs):
            async with real(*args, **kwargs) as streams:
                with contextlib.suppress(asyncio.CancelledError):  # lost, as the transport can lose it
                    yield streams
            raise BaseExceptionGroup("unhandled errors in a TaskGroup", [anyio.BrokenResourceError()])

        async def wait_in_a_session():
            async with core.open_session(URL, AGENT):
                await asyncio.sleep(10)

        self.enterContext(mock.patch.object(core, "streamable_http_client", late_reply))
        waiting = asyncio.create_task(wait_in_a_session())
        await asyncio.sleep(0.3)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting

    async def test_the_session_holds_the_services_rules(self):
        async with support.session() as session:
            self.assertIn("Only planners decide", session.instructions)

    async def test_call_raises_with_the_services_message(self):
        async with support.session() as session:
            with self.assertRaisesRegex(core.ToolError, '^get_study: 404 not_found: No study "missing"$'):
                await core.call(session, "get_study", {"studyId": "missing"})
            with self.assertRaisesRegex(core.ToolError, "Unknown tool: nowhere"):
                await core.call(session, "nowhere")
            self.assertIn(SOURCE, [source["id"] for source in await core.call(session, "list_sources")])

    async def test_a_wrong_token_is_a_setup_error(self):
        with self.assertRaisesRegex(core.SetupError, "401 bad_token"):
            async with core.open_session(URL, "wrong"):
                pass

    async def test_a_planners_token_is_a_setup_error(self):
        # Agents with a planner's tools could decide, and listen would answer its own replies.
        with self.assertRaisesRegex(core.SetupError, "^The agent token is a planner's"):
            async with core.open_session(URL, support.PLANNER):
                pass

    async def test_a_token_that_cant_report_is_a_setup_error(self):
        with self.assertRaisesRegex(core.SetupError, "^The agent token isn't an agent's"):
            async with core.open_session(URL, support.INTEGRATION):
                pass

    async def test_no_service_is_a_setup_error(self):
        with self.assertRaisesRegex(core.SetupError, "Can't connect to the service at http://127.0.0.1:9"):
            async with core.open_session("http://127.0.0.1:9", AGENT):
                pass


class VisitorTest(unittest.IsolatedAsyncioTestCase):
    """An agent acting for one visitor, or reading for everyone, and the visitors' budget."""

    VISITOR = "guest:" + "v" * 22

    async def test_a_session_for_a_visitor_sends_the_header_on_every_request(self):
        sent: list[dict[str, str]] = []
        real = core.streamable_http_client

        @contextlib.asynccontextmanager
        async def watched(url, *, http_client, **kwargs):
            async def record(request):
                sent.append(dict(request.headers))

            http_client.event_hooks["request"].append(record)
            async with real(url, http_client=http_client, **kwargs) as streams:
                yield streams

        self.enterContext(mock.patch.object(core, "streamable_http_client", watched))
        async with core.open_session(URL, AGENT, on_behalf_of=self.VISITOR) as session:
            await core.call(session, "list_sources")
        visitor = len(sent)
        async with core.open_session(URL, AGENT) as session:
            await core.call(session, "list_sources")

        self.assertGreater(visitor, 2)
        self.assertEqual({headers.get(core.ON_BEHALF_OF) for headers in sent[:visitor]}, {self.VISITOR})
        self.assertEqual({headers.get(core.ON_BEHALF_OF) for headers in sent[visitor:]}, {None})

    async def test_a_session_for_everyone_reads_and_can_never_write(self):
        study = support.open_study("everyone")
        head = api("GET", "/v1/log/head")["seq"]
        async with core.open_session(URL, AGENT, on_behalf_of=core.EVERYONE) as session:
            self.assertIsInstance(await core.call(session, "read_log", {"after": max(head - 3, 0)}), list)
            with self.assertRaisesRegex(core.ToolError, "^report_activity: 400 read_only"):
                await core.report(session, study, "message", text="From everyone.")
        self.assertEqual(api("GET", "/v1/log/head")["seq"], head)

    async def test_the_budget_tool_is_for_code_not_models(self):
        self.assertIn("get_budget", core.CODE_ONLY)

    async def test_a_usage_report_with_nothing_left_stops_the_agent(self):
        for left in (0, -0.4):
            session = _answering({"seq": 7, "budgetLeftUsd": left})
            with self.assertRaises(core.SpendCapReached) as caught:
                await core._report_usage(session, "s", "test-model", None)
            self.assertEqual(str(caught.exception), core.BUDGET_SPENT)
            self.assertTrue(caught.exception.everywhere)
            [(tool, arguments)] = [c.args for c in session.call_tool.call_args_list]
            self.assertEqual((tool, arguments["kind"], arguments["studyId"]), ("report_activity", "usage", "s"))
        # Some left, or a planner's run, whose reports carry no budget: it goes on.
        for answer in ({"seq": 7, "budgetLeftUsd": 0.01}, {"seq": 7}):
            await core._report_usage(_answering(answer), "s", "test-model", None)

    async def test_less_left_than_a_call_cost_stops_the_agent(self):
        # This call cost $0.30, and the next would likely cost as much.
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": "test-model=1500/10000"}))
        usage = reply(text="Done.", usage=(100, 15, 0)).usage_metadata
        with self.assertRaises(core.SpendCapReached):
            await core._report_usage(_answering({"seq": 7, "budgetLeftUsd": 0.29}), "s", "test-model", usage)
        await core._report_usage(_answering({"seq": 7, "budgetLeftUsd": 0.31}), "s", "test-model", usage)

    async def test_a_specialists_spend_cap_stops_the_leads_whole_run(self):
        self.enterContext(
            mock.patch.dict(os.environ, {"LEAD_MODEL": "lead-model", "SPECIALIST_MODEL": "specialist-model", "MAX_MODEL_CALLS": ""})
        )
        real = core._report_usage

        async def capped(session, study, model, usage):
            await real(session, study, model, usage)
            if model == "specialist-model":
                raise core.SpendCapReached()

        self.enterContext(mock.patch.object(core, "_report_usage", capped))
        study = support.open_study("spent")
        fake = FakeGemini(
            lambda request: reply(("ask_specialist", {"question": "How many riders?"}))
            if request.model == "lead-model"
            else reply(("read_page", {"contextId": SOURCE, "page": 1}))
        )

        async with support.session() as session:
            with self.assertRaises(core.SpendCapReached):
                await lead.run_lead(session, fake, study, "A visitor asks: how many riders?")

        # The lead's call and the specialist's, then nothing more.
        self.assertEqual([request.model for request in fake.requests], ["lead-model", "specialist-model"])
        [finished] = support.activities(study, "subagent.finished")
        self.assertEqual((finished["ok"], finished["summary"]), (False, f"Stopped. {core.BUDGET_SPENT}"))
        self.assertEqual(len(support.activities(study, "usage")), 2)

    async def test_once_the_budget_runs_out_calls_already_sent_finish_and_are_counted(self):
        env = {"LEAD_MODEL": "lead-model", "SPECIALIST_MODEL": "specialist-model", "MAX_MODEL_CALLS": "", "SPECIALIST_CONCURRENCY": "2"}
        self.enterContext(mock.patch.dict(os.environ, env))
        real = core._report_usage

        async def capped(session, study, model, usage):
            await real(session, study, model, usage)
            if usage is not None and usage.prompt_token_count == 111:  # the fast specialist's call
                raise core.SpendCapReached()

        self.enterContext(mock.patch.object(core, "_report_usage", capped))
        study = support.open_study("spent-at-once")
        slow_sent = asyncio.Event()

        async def respond(request):
            if request.model == "lead-model":
                return reply(("ask_specialist", {"question": "Fast?"}), ("ask_specialist", {"question": "Slow?"}))
            if request.task == "Fast?":
                await slow_sent.wait()
                return reply(("list_rules", {}), usage=(111, 10, 0))
            slow_sent.set()
            await asyncio.sleep(0.5)  # sent before the budget ran out, answered after
            return reply(("list_rules", {}), usage=(222, 10, 0))

        fake = FakeGemini(respond)
        async with support.session() as session:
            with self.assertRaises(core.SpendCapReached):
                await lead.run_lead(session, fake, study, "A visitor asks: how many riders?")

        # The slow specialist's call wasn't cancelled: it is counted, and it made no other.
        self.assertEqual(len(fake.requests), 3)
        self.assertEqual(sorted(usage["inputTokens"] for usage in support.activities(study, "usage")), [100, 111, 222])
        finished = support.activities(study, "subagent.finished")
        self.assertEqual([(f["ok"], f["summary"]) for f in finished], [(False, f"Stopped. {core.BUDGET_SPENT}")] * 2)


def _answering(answer: dict) -> mock.AsyncMock:
    """A session whose every tool call answers this."""
    session = mock.AsyncMock()
    session.call_tool.return_value = SimpleNamespace(is_error=False, structured_content=answer, content=[])
    return session


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        names = (
            "TRANSIT_URL",
            "LEAD_MODEL",
            "SPECIALIST_MODEL",
            "MAX_MODEL_CALLS",
            "MAX_RUN_CALLS",
            "SPECIALIST_CONCURRENCY",
            "RUNS_AT_ONCE",
            "GUEST_RUN_CALLS",
        )
        with mock.patch.dict(os.environ, {name: "" for name in names}):
            settings = core.config()
        self.assertEqual(
            settings, core.Config("http://127.0.0.1:4100", "gemini-3.6-flash", "gemini-3.6-flash", 30, 60, 2, 2, 20)
        )

    def test_from_the_environment(self):
        env = {
            "TRANSIT_URL": "http://example.test/",
            "LEAD_MODEL": "lead-model",
            "SPECIALIST_MODEL": "specialist-model",
            "MAX_MODEL_CALLS": "12",
            "MAX_RUN_CALLS": "40",
            "SPECIALIST_CONCURRENCY": "4",
            "RUNS_AT_ONCE": "3",
            "GUEST_RUN_CALLS": "9",
        }
        with mock.patch.dict(os.environ, env):
            settings = core.config()
        self.assertEqual(settings, core.Config("http://example.test", "lead-model", "specialist-model", 12, 40, 4, 3, 9))

    def test_the_run_budget_in_dollars(self):
        with mock.patch.dict(os.environ, {"MAX_RUN_USD": ""}):
            self.assertEqual(core.config().max_run_usd, 2.0)
        with mock.patch.dict(os.environ, {"MAX_RUN_USD": "0.5"}):
            self.assertEqual(core.config().max_run_usd, 0.5)
        for value in ("0", "-1", "two", "inf", "nan"):
            with mock.patch.dict(os.environ, {"MAX_RUN_USD": value}), self.assertRaisesRegex(core.SetupError, "MAX_RUN_USD"):
                core.config()

    def test_counts_must_be_whole_numbers(self):
        for name in ("SPECIALIST_CONCURRENCY", "MAX_RUN_CALLS", "RUNS_AT_ONCE", "GUEST_RUN_CALLS"):
            for value in ("0", "-1", "two", "1.5"):
                with mock.patch.dict(os.environ, {name: value}):
                    with self.assertRaisesRegex(core.SetupError, name):
                        core.config()

    def test_model_prices_must_be_readable(self):
        with mock.patch.dict(os.environ, {"MODEL_PRICES": "gemini-x=cheap"}):
            with self.assertRaisesRegex(core.SetupError, "^MODEL_PRICES: write each as model=input/output"):
                core.config()

    def test_the_agent_token_comes_from_the_environment(self):
        with mock.patch.dict(os.environ, {"TRANSIT_TOKEN_AGENT": "secret"}):
            self.assertEqual(core.agent_token(), "secret")

    def test_else_it_is_the_demos_lead_token_from_the_demos_data_folder(self):
        data = self.enterContext(tempfile.TemporaryDirectory())
        Path(data, "demo-tokens.json").write_text(json.dumps({"lead": "from-the-demo"}))
        with mock.patch.dict(os.environ, {"TRANSIT_TOKEN_AGENT": "", "DATA_DIR": data}):
            self.assertEqual(core.agent_token(), "from-the-demo")

    def test_no_agent_token_says_where_it_looked(self):
        data = self.enterContext(tempfile.TemporaryDirectory())
        with mock.patch.dict(os.environ, {"TRANSIT_TOKEN_AGENT": "", "DATA_DIR": data}):
            with self.assertRaises(core.SetupError) as caught:
                core.agent_token()
        self.assertIn(str(Path(data, "demo-tokens.json")), str(caught.exception))

    def test_gemini_needs_a_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            with self.assertRaisesRegex(core.SetupError, "GEMINI_API_KEY"):
                core.gemini()


if __name__ == "__main__":
    unittest.main()
