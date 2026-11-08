import asyncio
import contextlib
import io
import os
import signal
import time
import unittest
from unittest import mock

import httpx2

import core
import main
from tests import support
from tests.support import AGENT, PLANNER, SOURCE, URL, FakeGemini, api, gemini_error, reply


def setUpModule():
    support.service.start()


def say(study, text, token, url=None):
    api("POST", f"/v1/studies/{study}/activity", {"kind": "message", "text": text}, token=token, url=url)


def chat(study, url=None):
    return [(a["actor"], a["text"]) for a in support.activities(study, "message", url)]


async def until(check, timeout=10.0):
    """Wait, letting the listener run, until check() is true."""
    deadline = time.monotonic() + timeout
    while not await asyncio.to_thread(check):
        if time.monotonic() > deadline:
            raise AssertionError("Timed out")
        await asyncio.sleep(0.05)


@contextlib.asynccontextmanager
async def listening(fake, after):
    async with support.session() as session:
        listener = asyncio.create_task(main.listen(session, fake, after=after, poll_seconds=0.05))
        try:
            yield
        finally:
            listener.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await listener


class ListenTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"LEAD_MODEL": "lead-model", "MAX_MODEL_CALLS": ""}))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.err = self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    async def test_answers_only_planners_messages(self):
        study = support.open_study("listen")
        head = api("GET", "/v1/log/head")["seq"]
        say(study, "A note from an agent.", AGENT)
        say(study, "How many riders?", PLANNER)
        fake = FakeGemini(lambda request: reply(text=f"Answer to: {request.first_turn[-1]}"))

        async with listening(fake, head):
            await until(lambda: len(chat(study)) == 3)
            await asyncio.sleep(0.3)  # time to answer anything else, its own reply included

        # The question, after the study's chat so far.
        earlier = "Earlier in this study's chat, oldest first, for context:\n<chat>\nAgent: A note from an agent.\n</chat>"
        self.assertEqual([request.first_turn for request in fake.requests], [[earlier, "A planner asks: How many riders?"]])
        self.assertEqual(
            chat(study),
            [
                ("agent:lead", "A note from an agent."),
                ("planner:demo", "How many riders?"),
                ("agent:lead", "Answer to: A planner asks: How many riders?"),
            ],
        )
        kinds = [a["kind"] for a in support.activities(study)]
        self.assertEqual(kinds, ["message", "message", "run.started", "usage", "message", "run.finished"])

    async def test_a_failure_goes_in_the_chat_and_it_keeps_listening(self):
        study = support.open_study("listen-fails")
        head = api("GET", "/v1/log/head")["seq"]
        say(study, "First?", PLANNER)
        fake = FakeGemini(lambda request: gemini_error(429) if "First?" in request.first_turn[-1] else reply(text="Second answer."))

        async with listening(fake, head):
            await until(lambda: len(chat(study)) == 2)
            say(study, "Second?", PLANNER)
            await until(lambda: len(chat(study)) == 4)

        messages = chat(study)
        # Plain words in the chat. The detail, with its settings, is for the terminal.
        self.assertEqual(messages[1][1], "That failed. Gemini couldn't answer. Try again in a few minutes; the agent's terminal says why.")
        self.assertIn("That failed: Gemini refused lead-model with 429", self.err.getvalue())
        self.assertEqual(messages[3], ("agent:lead", "Second answer."))
        self.assertEqual(len(support.activities(study, "run.finished")), 2)

    async def test_a_follow_up_comes_with_the_chat_before_it(self):
        study = support.open_study("follow-up")
        other = support.open_study("follow-up-other")
        say(study, "What is the Ontario Line's BCR?", PLANNER)  # before it starts listening
        say(study, "1.05 (ontario-line-pdbc-2020 p. 12).", AGENT)
        say(other, "Something else entirely.", PLANNER)
        head = api("GET", "/v1/log/head")["seq"]
        say(study, "And is that above 1?", PLANNER)
        fake = FakeGemini(lambda request: reply(text="Yes: 1.05 is above 1."))

        async with listening(fake, head):
            await until(lambda: len(chat(study)) == 4)

        [request] = fake.requests
        self.assertEqual(
            request.first_turn,
            [
                "Earlier in this study's chat, oldest first, for context:\n<chat>\n"
                "Planner: What is the Ontario Line's BCR?\nAgent: 1.05 (ontario-line-pdbc-2020 p. 12).\n</chat>",
                "A planner asks: And is that above 1?",
            ],
        )

    def test_the_history_keeps_the_last_few_messages_each_shortened(self):
        earlier = [("planner", "x" * 2000)] + [("agent", f"{n}") for n in range(3)]
        history, asked = main.with_history("Why?", earlier)
        self.assertEqual(asked, "A planner asks: Why?")
        self.assertIn(f"Planner: {'x' * (main.HISTORY_CHARS - 1)}…\nAgent: 0\nAgent: 1\nAgent: 2\n</chat>", history)
        self.assertEqual(main.with_history("Why?", []), ["A planner asks: Why?"])

    async def test_messages_that_came_in_together_get_one_answer(self):
        study = support.open_study("together")
        head = api("GET", "/v1/log/head")["seq"]
        for text in ("Riders?", "And cost?", "And time?"):
            say(study, text, PLANNER)
        fake = FakeGemini(lambda request: reply(text="All three, with pages."))

        async with listening(fake, head):
            await until(lambda: len(chat(study)) == 4)
            await asyncio.sleep(0.3)  # time to answer the others, if it would

        [request] = fake.requests
        self.assertEqual(request.first_turn[-1], "A planner asks: And time?")
        self.assertIn("Planner: Riders?\nPlanner: And cost?\n</chat>", request.first_turn[0])
        self.assertEqual(len(support.activities(study, "run.started")), 1)

    async def test_stops_answering_once_it_has_spent_its_daily_limit(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_DAILY_USD": "5"}))
        self.enterContext(mock.patch.object(main, "spent_today", lambda: 5.0))
        study = support.open_study("spent")
        head = api("GET", "/v1/log/head")["seq"]
        say(study, "First?", PLANNER)
        fake = FakeGemini(lambda request: reply(text="Never."))

        async with listening(fake, head):
            await until(lambda: len(chat(study)) == 2)
            say(study, "Second?", PLANNER)
            await until(lambda: chat(study)[-1][1] == "Second?")
            await asyncio.sleep(0.3)  # time to say it again, if it would

        self.assertEqual(fake.requests, [])
        self.assertEqual([text for _, text in chat(study)], ["First?", main.SPENT, "Second?"])  # told once
        self.assertEqual(support.activities(study, "run.started"), [])

    async def test_answers_only_so_many_messages_an_hour(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_RUNS_PER_HOUR": "1"}))
        first, second = support.open_study("hourly"), support.open_study("hourly")
        head = api("GET", "/v1/log/head")["seq"]
        say(first, "Riders?", PLANNER)
        say(second, "Cost?", PLANNER)
        fake = FakeGemini(lambda request: reply(text="An answer."))

        async with listening(fake, head):
            await until(lambda: len(chat(second)) == 2)

        self.assertEqual(len(fake.requests), 1)
        self.assertEqual(chat(first)[-1], ("agent:lead", "An answer."))
        self.assertEqual(chat(second)[-1], ("agent:lead", main.BUSY))

    async def test_a_run_that_takes_too_long_stops_and_says_so(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_RUN_MINUTES": "2"}))
        self.enterContext(mock.patch.object(main, "MINUTE", 0.05))  # 2 "minutes" of 0.05 s
        study = support.open_study("too-long")
        head = api("GET", "/v1/log/head")["seq"]
        say(study, "Stall?", PLANNER)

        async def respond(request):
            if "Stall?" in request.first_turn[-1]:
                await asyncio.sleep(5)
            return reply(text="Quick answer.")

        async with listening(FakeGemini(respond), head):
            await until(lambda: len(chat(study)) == 2)
            say(study, "Quick?", PLANNER)  # it still listens
            await until(lambda: len(chat(study)) == 4)

        said = [text for _, text in chat(study)]
        self.assertEqual(said[1], "That took more than 2 minutes, so the agent stopped. Try again, or ask something narrower.")
        self.assertEqual(said[3], "Quick answer.")
        self.assertEqual(len(support.activities(study, "run.finished")), 2)

    async def test_never_answers_its_own_messages(self):
        # Even with a planner's token, which the session refuses, so let it through here.
        self.enterContext(mock.patch.object(core, "check_agent", mock.AsyncMock()))
        study = support.open_study("listen-own")
        head = api("GET", "/v1/log/head")["seq"]
        say(study, "How many riders?", PLANNER)
        fake = FakeGemini(lambda request: reply(text="1,680 a week."))

        async with core.open_session(URL, PLANNER) as session:
            listener = asyncio.create_task(main.listen(session, fake, after=head, poll_seconds=0.05))
            try:
                await until(lambda: len(chat(study)) == 2)
                await asyncio.sleep(0.5)  # time to answer its own reply, as a planner's
            finally:
                listener.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await listener

        self.assertEqual(len(fake.requests), 1)
        self.assertEqual(chat(study), [("planner:demo", "How many riders?"), ("planner:demo", "1,680 a week.")])

    async def test_the_display_message_filter(self):
        def entry(actor, data, study="s", type="activity"):
            return {"type": type, "actor": actor, "studyId": study, "data": data}

        message = {"kind": "message", "text": "Hi"}
        self.assertEqual(main.planner_message(entry("planner:ana", message)), "Hi")
        self.assertIsNone(main.planner_message(entry("agent:lead", message)))
        self.assertIsNone(main.planner_message(entry("planner:ana", message, study=None)))
        self.assertIsNone(main.planner_message(entry("planner:ana", {"kind": "run.started"})))
        self.assertIsNone(main.planner_message(entry("planner:ana", message, type="study.opened")))


class KeepListeningTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"LEAD_MODEL": "lead-model", "MAX_MODEL_CALLS": ""}))
        self.out = self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.err = self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    async def test_carries_on_where_it_was_once_the_service_is_back(self):
        service = support.Service(support.PORT + 1)  # its own, to stop and start again
        await asyncio.to_thread(service.start)
        self.addCleanup(service.stop)
        url = service.url
        api("POST", "/v1/studies", {"id": "outage", "title": "Outage"}, token=AGENT, url=url)
        fake = FakeGemini(lambda request: reply(text=f"Answer to: {request.first_turn[-1]}"))
        timing = {"poll_seconds": 0.05, "retry_seconds": 0.05, "most_seconds": 0.2}
        listener = asyncio.create_task(main.keep_listening(fake, url=url, token=AGENT, **timing))
        try:
            await until(lambda: "Listening for planners' messages" in self.out.getvalue())
            say("outage", "First?", PLANNER, url)
            await until(lambda: len(chat("outage", url)) == 2)

            await asyncio.to_thread(service.stop, keep_data=True)
            await until(lambda: "Trying again" in self.err.getvalue())
            await asyncio.sleep(0.6)  # it tries again several times, and says so once
            await asyncio.to_thread(service.start)
            await until(lambda: "Back on" in self.out.getvalue())
            say("outage", "Second?", PLANNER, url)
            await until(lambda: len(chat("outage", url)) == 4)
        finally:
            listener.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await listener

        self.assertEqual([request.first_turn[-1] for request in fake.requests], ["A planner asks: First?", "A planner asks: Second?"])
        said = [line for line in self.err.getvalue().splitlines() if "Trying again" in line]
        self.assertEqual(len(said), 1)
        self.assertRegex(said[0], f"^Lost the service at {url}: .+\\. Is it still running\\? Trying again until it's back\\.$")

    async def test_must_connect_the_first_time(self):
        with self.assertRaisesRegex(core.SetupError, "Can't connect to the service at http://127.0.0.1:9"):
            await main.keep_listening(FakeGemini(lambda request: None), url="http://127.0.0.1:9", token=AGENT)


class RunTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"LEAD_MODEL": "lead-model", "MAX_MODEL_CALLS": ""}))

    async def test_opens_a_new_study_and_answers_in_its_chat(self):
        study = f"run-{os.urandom(3).hex()}"
        read = reply(("read_page", {"contextId": SOURCE, "page": 1}))
        fake = FakeGemini(lambda request: read if request.turn == 0 else reply(text="Here's the answer (test-plan p. 1)."))

        async with support.session() as session:
            first = await main.run_task(session, fake, "Find the riders.", study, "Run test")
            again = await main.run_task(session, fake, "And again.", study)

        self.assertEqual(first, "Here's the answer (test-plan p. 1).")
        self.assertEqual(again, first)
        self.assertEqual(api("GET", f"/v1/studies/{study}")["title"], "Run test")
        self.assertEqual([request.task for request in fake.requests[::2]], ["Find the riders.", "And again."])
        kinds = [a["kind"] for a in support.activities(study)]
        self.assertEqual(kinds, ["run.started", "usage", "reading", "usage", "message", "run.finished"] * 2)


class AnswerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"LEAD_MODEL": "lead-model", "MAX_MODEL_CALLS": ""}))

    async def test_says_so_when_the_lead_gave_no_answer(self):
        study = support.open_study("no-answer")
        # Gemini finishes, after a tool call, with no text.
        fake = FakeGemini(lambda request: reply(("list_sources", {})) if request.turn == 0 else reply(text=""))

        async with support.session() as session:
            text = await main.answer(session, fake, study, "A planner asks: how many riders does the 52 gain?")

        self.assertEqual(text, "The lead gave no answer. Try again, or ask differently.")
        self.assertEqual(chat(study), [("agent:lead", text)])

    async def answer_citing(self, study, text, *, read=None):
        """main.answer, with a lead that reads `read` (contextId, page) first, then says `text`."""
        def respond(request):
            if request.turn == 0 and read:
                return reply(("read_page", {"contextId": read[0], "page": read[1]}))
            return reply(text=text)

        async with support.session() as session:
            return await main.answer(session, FakeGemini(respond), study, "A planner asks: riders?")

    async def test_a_cited_page_the_run_read_needs_no_mark(self):
        study = support.open_study("cited-read")
        text = await self.answer_citing(study, "1,680 a week (test-plan p. 1).", read=(SOURCE, 1))
        self.assertEqual(text, "1,680 a week (test-plan p. 1).")

    async def test_a_cited_page_nobody_read_is_marked(self):
        study = support.open_study("cited-unread")
        text = await self.answer_citing(study, "1,680 a week (test-plan p. 1), and 25 hours (test-plan p. 2).", read=(SOURCE, 1))
        self.assertEqual(
            text, "1,680 a week (test-plan p. 1), and 25 hours (test-plan p. 2).\n\nNot checked: this run didn't read (test-plan p. 2)."
        )
        self.assertEqual(chat(study), [("agent:lead", text)])

    async def test_a_page_a_recorded_figure_cites_counts_as_checked(self):
        study = support.open_study("cited-figure")
        quote = "weekly ridership increase of 1,680 customers"
        figure = {"id": "riders", "label": "Riders", "value": 1680, "basis": {"kind": "cited", "citation": {"contextId": SOURCE, "page": 1, "quote": quote}}}
        api("POST", f"/v1/studies/{study}/figures", figure, token=AGENT)
        text = await self.answer_citing(study, "1,680 a week (test-plan p. 1).")
        self.assertEqual(text, "1,680 a week (test-plan p. 1).")

    async def test_a_page_that_doesnt_exist_is_named(self):
        study = support.open_study("cited-missing")
        text = await self.answer_citing(study, "It says so (test-plan p. 99).")
        self.assertEqual(text, "It says so (test-plan p. 99).\n\nNo such page: test-plan has no page 99.")


class Client:
    """Stands in for google-genai's Client: its aio is a fake Gemini."""

    def __init__(self, fake):
        self.aio = self
        self.fake = fake

    async def __aenter__(self):
        return self.fake

    async def __aexit__(self, *_):
        return False


class CommandLineTest(unittest.TestCase):
    def test_eval_hands_its_arguments_to_the_eval_runner(self):
        with mock.patch("evals.main", return_value=3) as runner:
            self.assertEqual(main.main(["eval", "--split", "dev"]), 3)
        runner.assert_called_once_with(["--split", "dev"])

    def test_eval_checks_its_cases_before_starting_anything(self):
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main.main(["eval", "--case", "nope-001"]), 1)
        self.assertIn("No case nope-001 in evals/cases.jsonl.", stderr.getvalue())

    def test_setup_problems_are_one_line_not_a_traceback(self):
        env = {"TRANSIT_URL": "http://127.0.0.1:9", "TRANSIT_TOKEN_AGENT": "A"}
        with mock.patch.dict(os.environ, env), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main.main(["run", "Anything.", "--study", "nowhere"]), 1)
        self.assertTrue(stderr.getvalue().startswith("Can't connect to the service at http://127.0.0.1:9"))

    def run_one(self, gemini, study, model="gemini-nope"):
        """main.py run, with this Gemini client, against the test service."""
        env = {"TRANSIT_URL": URL, "TRANSIT_TOKEN_AGENT": AGENT, "LEAD_MODEL": model, "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))
        self.enterContext(mock.patch.object(core, "gemini", lambda: gemini))
        with contextlib.redirect_stderr(io.StringIO()) as stderr, contextlib.redirect_stdout(io.StringIO()):
            status = main.main(["run", "How many riders?", "--study", study])
        return status, stderr.getvalue()

    def test_gemini_refusing_is_one_line_in_the_terminal_and_the_chat(self):
        def handler(request):
            error = {"code": 404, "message": "models/gemini-nope is not found.", "status": "NOT_FOUND"}
            return httpx2.Response(404, json={"error": error})

        study = f"refused-{os.urandom(3).hex()}"
        client = core.genai.Client(api_key="fake", http_options={"async_client_args": {"transport": httpx2.MockTransport(handler)}})
        status, said = self.run_one(client, study)

        line = (
            "Gemini refused gemini-nope with 404 NOT_FOUND. Check LEAD_MODEL and SPECIALIST_MODEL. "
            "Gemini said: models/gemini-nope is not found."
        )
        self.assertEqual((status, said), (1, f"{line}\n"))
        self.assertEqual(chat(study), [("agent:lead", f"That failed. {core.for_planners(core.ModelError(line))}")])

    def test_losing_the_service_is_one_line(self):
        study = f"lost-{os.urandom(3).hex()}"
        lost = httpx2.ConnectError("All connection attempts failed")
        self.enterContext(mock.patch.object(main.ClientSession, "call_tool", side_effect=lost))
        client = core.genai.Client(api_key="fake", http_options={"async_client_args": {"transport": httpx2.MockTransport(lambda r: None)}})

        status, said = self.run_one(client, study)

        self.assertEqual(status, 1)
        self.assertEqual(said, f"Lost the service at {URL}: All connection attempts failed. Is it still running?\n")

    def test_a_bug_keeps_its_traceback(self):
        self.enterContext(mock.patch.object(main, "_run", side_effect=ZeroDivisionError("a bug")))
        with self.assertRaises(ZeroDivisionError):
            main.main(["run", "Anything.", "--study", "s"])

    def test_sigterm_stops_a_run_as_ctrl_c_does(self):
        # Docker, systemd and most process managers stop a process with SIGTERM.
        async def respond(request):
            if request.model == "lead-model":
                return reply(("ask_specialist", {"question": "How many riders?", "instructions": "Read the plan."}))
            os.kill(os.getpid(), signal.SIGTERM)
            await asyncio.sleep(10)  # stopped long before this

        study = f"stop-{os.urandom(3).hex()}"
        before = signal.getsignal(signal.SIGTERM)
        status, said = self.run_one(Client(FakeGemini(respond)), study, model="lead-model")

        self.assertEqual((status, said), (130, ""))
        self.assertIs(signal.getsignal(signal.SIGTERM), before)
        # The run and its specialist still show they ended.
        self.assertEqual([a["summary"] for a in support.activities(study, "subagent.finished")], ["Stopped."])
        self.assertEqual(len(support.activities(study, "run.finished")), 1)
        self.assertEqual(chat(study), [("agent:lead", "Stopped before answering.")])

    def test_run_needs_a_study(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            main.main(["run", "Anything."])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
