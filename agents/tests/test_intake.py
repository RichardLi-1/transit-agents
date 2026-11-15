"""Tests for context intake: the listener triages a new source unasked. The service,
the session and the lead's runs are fakes; no model is called."""

import asyncio
import contextlib
import io
import os
import unittest
from unittest import mock

import main
from intake import arrived, chosen, describe, triage_task


def added(seq, actor, source="ttc-board-2026-11", *, audience=None, title="TTC Board report", pages=12):
    data = {"id": source, "title": title, "folder": "Inbox", "pageCount": pages}
    return {"seq": seq, "type": "context.added", "actor": actor, "studyId": None, "audience": audience, "data": data}


class ArrivedTest(unittest.TestCase):
    def test_a_source_a_planner_or_an_agency_system_adds(self):
        self.assertEqual(
            arrived(added(1, "planner:ana")), {"id": "ttc-board-2026-11", "title": "TTC Board report", "pages": 12, "by": "a planner"}
        )
        self.assertEqual(arrived(added(1, "integration:inbox"))["by"], "the watched folder")
        self.assertEqual(arrived(added(1, "integration:hastus"))["by"], "an agency system")

    def test_not_an_agents_upload_a_sandbox_or_anything_else(self):
        self.assertIsNone(arrived(added(1, "agent:lead")))  # it can't be cited, and an agent mustn't start runs
        self.assertIsNone(arrived(added(1, "planner:ana", audience="guest:abc")))
        self.assertIsNone(arrived({"seq": 1, "type": "figure.recorded", "actor": "planner:ana", "data": {"id": "x"}}))

    def test_the_task_names_each_source_and_keeps_the_chat(self):
        sources = [arrived(added(1, "integration:inbox")), arrived(added(2, "planner:ana", "notes", title="notes", pages=1))]
        self.assertEqual(describe(sources[0]), "ttc-board-2026-11 (TTC Board report, 12 pages), added by the watched folder")
        self.assertEqual(describe(sources[1]), "notes (1 page), added by a planner")
        history, task = triage_task(sources, ["Earlier in this study's chat ..."])
        self.assertEqual(history, "Earlier in this study's chat ...")
        self.assertIn("ttc-board-2026-11 (TTC Board report, 12 pages), added by the watched folder; notes (1 page)", task)
        self.assertIn('"TTC Board report and notes doesn\'t bear on this study."', task)
        self.assertIn("Decide nothing", task)
        self.assertEqual(len(triage_task(sources)), 1)

    def test_the_newest_studies(self):
        studies = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        self.assertEqual(chosen(studies, 2), ["b", "c"])
        self.assertEqual(chosen(studies, 5), ["a", "b", "c"])
        self.assertEqual(chosen(studies, 0), [])


class SettingsTest(unittest.TestCase):
    def test_intake_settings(self):
        with mock.patch.dict(os.environ, {"INTAKE_STUDIES": "", "INTAKE_RUN_CALLS": ""}):
            self.assertEqual((main.config().intake_studies, main.config().intake_run_calls), (3, 20))
        with mock.patch.dict(os.environ, {"INTAKE_STUDIES": "0"}):
            self.assertEqual(main.config().intake_studies, 0)
        for name, bad in (("INTAKE_STUDIES", "x"), ("INTAKE_RUN_CALLS", "0")):
            with mock.patch.dict(os.environ, {name: bad}), self.assertRaisesRegex(main.SetupError, name):
                main.config()


class FakeSession:
    pass


class IntakeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, {"INTAKE_STUDIES": "2", "INTAKE_RUN_CALLS": "7", "MAX_RUNS_PER_HOUR": "", "MAX_DAILY_USD": ""}))
        self.answered = []
        self.log = []  # entries read_log gives, then nothing

        async def fake_call(session, tool, arguments=None):
            if tool == "list_studies":
                return [{"id": "oldest"}, {"id": "lawrence"}, {"id": "ontario"}]
            if tool == "get_log_head":
                return {"seq": 0}
            if tool == "read_log":
                entries, self.log = self.log, []
                return entries
            raise AssertionError(f"unexpected tool {tool}")

        async def fake_answer(session, client, study, task, *, seconds=None, max_run_calls=None):
            self.answered.append({"study": study, "task": task, "calls": max_run_calls})
            return "TTC Board report doesn't bear on this study."

        @contextlib.asynccontextmanager
        async def fake_session(url=None, token=None, on_behalf_of=None):
            self.assertIsNone(on_behalf_of)  # the shared record, never a visitor's sandbox
            yield FakeSession()

        self.enterContext(mock.patch.object(main, "call", fake_call))
        self.enterContext(mock.patch.object(main, "answer", fake_answer))
        self.enterContext(mock.patch.object(main, "open_session", fake_session))
        self.enterContext(mock.patch.object(main, "spent_today", lambda: 0.0))
        self.listener = main.Listener(object(), url="http://fake", token="A", poll_seconds=0.01)
        self.sources = [arrived(added(1, "integration:inbox"))]

    async def intake(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            await self.listener.intake(self.sources)
        return err.getvalue()

    async def test_triages_in_the_newest_studies_with_its_own_call_limit(self):
        await self.intake()
        self.assertEqual([run["study"] for run in self.answered], ["lawrence", "ontario"])
        self.assertEqual({run["calls"] for run in self.answered}, {7})
        self.assertIn("ttc-board-2026-11", self.answered[0]["task"][-1])
        self.assertEqual(len(self.listener.started), 2)  # each counts against MAX_RUNS_PER_HOUR

    async def test_gives_each_run_the_studys_chat_so_far(self):
        self.listener.after = 10
        message = {"type": "activity", "actor": "agent:lead", "studyId": "ontario", "data": {"kind": "message", "text": "Not known yet: the fleet."}}
        self.listener._hear({**message, "seq": 5})
        await self.intake()
        ontario = next(run for run in self.answered if run["study"] == "ontario")
        self.assertIn("Agent: Not known yet: the fleet.", ontario["task"][0])
        lawrence = next(run for run in self.answered if run["study"] == "lawrence")
        self.assertEqual(len(lawrence["task"]), 1)

    async def test_stays_within_the_listeners_limits(self):
        with mock.patch.dict(os.environ, {"MAX_RUNS_PER_HOUR": "1"}):
            said = await self.intake()
        self.assertEqual([run["study"] for run in self.answered], ["lawrence"])
        self.assertIn("not triaged in ontario", said)
        self.answered.clear()
        with mock.patch.object(main, "spent_today", lambda: 10.0):
            said = await self.intake()
        self.assertEqual(self.answered, [])
        self.assertIn(main.SPENT, said)

    async def test_the_listener_triages_what_arrives_unasked(self):
        triaged = []

        async def intake(sources):
            triaged.append(sources)

        self.listener.intake = intake
        self.log = [added(1, "integration:inbox"), added(2, "agent:lead", "agents-notes"), added(3, "planner:ana", "plan-b", title="Plan B")]
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.listener.run(FakeSession()), 0.2)
        self.assertEqual([[source["id"] for source in sources] for sources in triaged], [["ttc-board-2026-11", "plan-b"]])

    async def test_intake_studies_0_turns_it_off(self):
        triaged = []

        async def intake(sources):
            triaged.append(sources)

        self.listener.intake = intake
        self.log = [added(1, "integration:inbox")]
        with mock.patch.dict(os.environ, {"INTAKE_STUDIES": "0"}), contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.listener.run(FakeSession()), 0.2)
        self.assertEqual(triaged, [])
