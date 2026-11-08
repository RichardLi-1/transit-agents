import contextlib
import io
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import core
import lead
import skills
from tests import support
from tests.support import SKILLS, SOURCE, FakeGemini, gemini_error, reply


def setUpModule():
    support.service.start()


async def run_lead(fake, study, task="How many riders, and which rule applies?"):
    async with support.session() as session:
        return await lead.run_lead(session, fake, study, task, skills_dir=SKILLS)


def ask(question, instructions="Answer it.", **more):
    return ("ask_specialist", {"question": question, "instructions": instructions, **more})


class LeadTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        env = {
            "LEAD_MODEL": "lead-model",
            "SPECIALIST_MODEL": "specialist-model",
            "SPECIALIST_CONCURRENCY": "2",
            "MAX_MODEL_CALLS": "",
            "MAX_RUN_CALLS": "",
        }
        self.enterContext(mock.patch.dict(os.environ, env))

    async def test_reports_usage_for_every_model_call_the_leads_and_the_specialists(self):
        study = support.open_study("lead-usage")
        lead_turns = [
            reply(("list_skills", {}), usage=(1000, 20, 30)),
            reply(ask("How many riders?", skill="quote-check"), ask("Which rule applies?"), usage=(1100, 40, 0)),
            reply(text="1,680 riders a week (test-plan p. 1). A planner decides.", usage=(1500, 60, 10)),
        ]

        def respond(request):
            if request.model == "lead-model":
                return lead_turns[request.turn]
            if request.turn == 0:
                return reply(("read_page", {"contextId": SOURCE, "page": 1}), usage=(300, 5, 5))
            return reply(text=f"Answer (test-plan p. 1) to {request.task}", usage=(600, 15, 0))

        fake = FakeGemini(respond)
        answer = await run_lead(fake, study)

        self.assertEqual(answer, "1,680 riders a week (test-plan p. 1). A planner decides.")
        usage = support.activities(study, "usage")
        self.assertEqual(len(usage), len(fake.requests))  # one report for each model call
        by_model = {}
        for activity in usage:
            calls, tokens_in, tokens_out = by_model.get(activity["model"], (0, 0, 0))
            by_model[activity["model"]] = (calls + 1, tokens_in + activity["inputTokens"], tokens_out + activity["outputTokens"])
        self.assertEqual(
            by_model,
            {
                "lead-model": (3, 3600, 160),  # thinking counts as output
                "specialist-model": (4, 1800, 50),
            },
        )
        self.assertEqual(len(support.activities(study, "subagent.finished")), 2)

    async def test_the_lead_reads_and_checks_and_specialists_record(self):
        study = support.open_study("lead-tools")
        fake = FakeGemini(lambda request: reply(text="Nothing to do."))

        await run_lead(fake, study)

        offered = fake.requests[0].tools
        self.assertTrue({"ask_specialist", "list_skills", "read_page", "trace_figure", "list_rules"} <= offered)
        self.assertLessEqual(offered, lead.TOOLS | {"ask_specialist", "list_skills"})
        self.assertFalse({"record_figure", "record_check", "open_study", "report_activity"} & offered)
        system = fake.requests[0].system
        self.assertIn("Only planners decide.", system)  # the service's rules
        self.assertIn(f"You lead the first pass on study {study}.", system)
        self.assertIn("write no Markdown", system)  # the chat shows plain text

    async def test_the_lead_ends_every_first_pass_with_what_isnt_known_yet(self):
        # As the handover skill sets out: the cited answer first, then each gap with its
        # next step and who to contact, citing the page that shows it.
        study = support.open_study("lead-gaps")
        fake = FakeGemini(lambda request: reply(text="Nothing to do."))

        await run_lead(fake, study)

        system = fake.requests[0].system
        lines = system.splitlines()
        self.assertIn("Not known yet:", lines)
        gap = lines[lines.index("Not known yet:") + 1]
        self.assertRegex(gap, r"^- <what's missing>\. Next: <[^>]+>\. Contact: <[^>]+> \(<source-id> p\. <N>\)\.$")
        handover = skills.load_skill("handover").body.splitlines()
        self.assertEqual(gap, handover[handover.index("Not known yet:") + 1])  # the skill's own form
        self.assertLess(system.index("First the answer"), system.index("Not known yet:"))
        self.assertIn("end every answer with what isn't known yet", system)
        self.assertIn("Where no page shows it, ask it as a question for the planner, and claim nothing.", system)
        self.assertIn("Name an organisation or team, never a person.", system)

    async def test_list_skills_shows_names_and_descriptions_not_instructions(self):
        study = support.open_study("lead-skills")
        fake = FakeGemini(lambda request: reply(("list_skills", {})) if request.turn == 0 else reply(text="Done."))

        await run_lead(fake, study)

        skills = [{"name": "quote-check", "description": "Check that a quote is on the page it cites, word for word."}]
        self.assertEqual(fake.requests[1].results, [("list_skills", {"output": skills})])
        lead_context = str(fake.requests[1].contents) + fake.requests[1].system
        self.assertNotIn("Read the cited page with read_page.", lead_context)

    async def test_the_leads_last_call_starts_no_specialist(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_MODEL_CALLS": "2"}))
        study = support.open_study("lead-last")

        def respond(request):
            if request.model == "lead-model":
                return reply(("list_sources", {})) if request.turn == 0 else reply(ask("How many riders?"))
            return reply(text="1,680 riders a week (test-plan p. 1).")

        fake = FakeGemini(respond)
        answer = await run_lead(fake, study)

        # The lead's second call is its last, so no specialist runs for a summary nobody reads.
        self.assertEqual(answer, "Stopped after 2 model calls.")
        self.assertEqual([request.model for request in fake.requests], ["lead-model", "lead-model"])
        self.assertEqual(support.activities(study, "subagent.started"), [])

    async def test_a_specialists_server_error_goes_back_to_the_lead(self):
        study = support.open_study("lead-500")

        def respond(request):
            if request.model == "lead-model":
                if request.turn == 0:
                    return reply(ask("Will fail?"), ask("How many riders?"))
                return reply(text="1,680 riders a week (test-plan p. 1); one question failed.")
            return gemini_error(500) if request.task == "Will fail?" else reply(text="1,680 (test-plan p. 1).")

        fake = FakeGemini(respond)
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            answer = await run_lead(fake, study)

        self.assertEqual(answer, "1,680 riders a week (test-plan p. 1); one question failed.")
        error = "Gemini refused specialist-model with 500 ERROR, even after retries. Gemini said: Test ERROR"
        self.assertEqual(fake.requests[-1].results, [("ask_specialist", {"error": f"ask_specialist: {error}"}), ("ask_specialist", {"output": "1,680 (test-plan p. 1)."})])
        self.assertEqual(stderr.getvalue(), f"  A specialist stopped: {error}\n")  # the lead carries on, so the terminal hears why

    async def test_a_wrong_model_stops_the_whole_run(self):
        study = support.open_study("lead-404")

        def respond(request):
            if request.model == "lead-model":
                return reply(ask("How many riders?"))
            return gemini_error(404)

        fake = FakeGemini(respond)
        with self.assertRaisesRegex(core.ModelError, "404 ERROR. Check LEAD_MODEL and SPECIALIST_MODEL"):
            await run_lead(fake, study)
        self.assertEqual(len([r for r in fake.requests if r.model == "lead-model"]), 1)

    async def test_running_out_of_quota_stops_the_whole_run(self):
        study = support.open_study("lead-quota")

        def respond(request):
            if request.model == "lead-model":
                return reply(ask("How many riders?"))
            return gemini_error(429)

        fake = FakeGemini(respond)
        with self.assertRaisesRegex(core.ModelError, "429"):
            await run_lead(fake, study)

        self.assertEqual(len([r for r in fake.requests if r.model == "lead-model"]), 1)

    async def test_a_question_in_parts_goes_to_one_specialist_a_part_each_with_its_skill(self):
        study = support.open_study("lead-parts")
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ("gtfs-analyst", "engagement-needs"):
            (root / name).mkdir()
            (root / name / "SKILL.md").write_text(f"---\nname: {name}\ndescription: The {name} skill.\n---\nAnswer from the sources.\n")
        lead_turns = [
            reply(("list_skills", {})),
            reply(
                ask("How often does the route run?", skill="gtfs-analyst"),
                ask("Who must hear about the change?", skill="engagement-needs"),
            ),
            reply(text="Every 10 minutes (test-plan p. 1). Riders near the stop (test-plan p. 2)."),
        ]

        def respond(request):
            if request.model == "lead-model":
                return lead_turns[request.turn]
            return reply(text=f"Answer to {request.task} (test-plan p. 1).")

        fake = FakeGemini(respond)
        async with support.session() as session:
            await lead.run_lead(session, fake, study, "How often does it run, and who must hear about it?", skills_dir=root)

        system = fake.requests[0].system
        self.assertIn("A request with several parts, such as ridership, cost and the public's needs, is one question for each part.", system)
        self.assertIn("Ask one specialist for each part; don't read the sources for every part yourself.", system)
        self.assertIn("gtfs-analyst", system)
        # The display shows each specialist's skill from its start.
        started = support.activities(study, "subagent.started")
        self.assertEqual(
            sorted((a["question"], a.get("skill")) for a in started),
            [("How often does the route run?", "gtfs-analyst"), ("Who must hear about the change?", "engagement-needs")],
        )
        specialist = {r.task: r.system for r in fake.requests if r.model == "specialist-model"}
        self.assertIn("Skill gtfs-analyst: The gtfs-analyst skill.", specialist["How often does the route run?"])

    async def test_what_if_previews_the_change_and_records_nothing(self):
        study = support.open_study("lead-what-if")
        key = f"growth-{uuid.uuid4().hex[:6]}"
        support.api("PUT", f"/v1/assumptions/{key}", {"value": 1, "label": "Growth", "reason": "No growth yet."})
        quote = "weekly ridership increase of 1,680 customers"
        support.api(
            "POST",
            f"/v1/studies/{study}/figures",
            {"id": "riders", "label": "Riders", "value": 1680, "basis": {"kind": "cited", "citation": {"contextId": SOURCE, "page": 1, "quote": quote}}},
            token=support.AGENT,
        )
        formula = {"kind": "derived", "formula": "riders * growth", "inputs": {"riders": {"figure": "riders"}, "growth": {"assumption": key}}}
        support.api("POST", f"/v1/studies/{study}/figures", {"id": "grown", "label": "Riders grown", "basis": formula}, token=support.AGENT)
        lead_turns = [
            reply(("get_study", {"studyId": study}), ("preview_change", {"studyId": study, "assumptions": {key: 1.5}})),
            reply(text="- Riders grown: 1,680 → 2,520 (test-plan p. 1). Nothing was saved."),
        ]
        fake = FakeGemini(lambda request: lead_turns[request.turn])

        answer = await run_lead(fake, study, f"What changes if {key} is 1.5?")

        self.assertIn("preview_change", fake.requests[0].tools)
        system = fake.requests[0].system
        self.assertIn("when a planner asks what changes if an input changes", system)
        self.assertIn("you never record the change: a planner does.", system)
        (_, now), (_, after) = fake.requests[1].results
        value = lambda view: next(f["value"] for f in view["output"]["figures"] if f["id"] == "grown")
        self.assertEqual((value(now), value(after)), (1680, 2520))
        self.assertIn("1,680 → 2,520", answer)
        # Nothing saved: the assumption and the figure are as they were.
        rules = {a["key"]: a["value"] for a in support.api("GET", "/v1/assumptions")}
        self.assertEqual(rules[key], 1)
        self.assertEqual(value({"output": support.api("GET", f"/v1/studies/{study}")}), 1680)
        self.assertEqual([e["type"] for e in support.entries(study) if e["type"] == "assumption.set"], [])



def tools_off(request):
    mode = request.config.tool_config and request.config.tool_config.function_calling_config.mode
    return mode == core.types.FunctionCallingConfigMode.NONE


def keeps_asking(questions):
    """A lead that asks `questions` specialists a turn, and specialists that keep reading,
    until their tools are off: then each answers."""

    def respond(request):
        if tools_off(request):
            return reply(text=f"From what I have ({request.model}).")
        if request.model == "lead-model":
            return reply(*[ask(f"Question {i}?") for i in range(questions)])
        return reply(("list_rules", {}))

    return respond


class RunBudgetTest(unittest.IsolatedAsyncioTestCase):
    """MAX_RUN_CALLS: one budget for a run, the lead's calls and its specialists' together."""

    def setUp(self):
        env = {"LEAD_MODEL": "lead-model", "SPECIALIST_MODEL": "specialist-model", "MAX_MODEL_CALLS": "30"}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def test_the_run_stops_at_its_budget_and_the_lead_answers_from_what_it_has(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_RUN_CALLS": "7", "SPECIALIST_CONCURRENCY": "4"}))
        study = support.open_study("budget")
        fake = FakeGemini(keeps_asking(4))

        answer = await run_lead(fake, study)

        self.assertEqual(len(fake.requests), 7)
        self.assertEqual(len(support.activities(study, "usage")), 7)
        self.assertEqual(answer, "From what I have (lead-model).")
        leads = [request for request in fake.requests if request.model == "lead-model"]
        self.assertEqual([tools_off(request) for request in leads], [False, True])
        # Each specialist read the result of every tool it called.
        specialists = [request for request in fake.requests if request.model == "specialist-model"]
        self.assertEqual(sum(not tools_off(request) for request in specialists), 1)
        self.assertEqual(len(support.activities(study, "subagent.finished")), 4)

    async def test_the_run_stops_once_it_has_spent_its_dollars(self):
        # A dollar a call: 100 input tokens at $10,000 a million.
        prices = "lead-model=10000/0,specialist-model=10000/0"
        env = {"MAX_RUN_CALLS": "60", "MAX_RUN_USD": "1.5", "SPECIALIST_CONCURRENCY": "1", "MODEL_PRICES": prices}
        self.enterContext(mock.patch.dict(os.environ, env))
        study = support.open_study("budget-usd")
        fake = FakeGemini(keeps_asking(1))

        answer = await run_lead(fake, study)

        # The lead's first call spends $1. The specialist starts under $1.50, so it makes
        # one call with tools, then its last without: a call given out is still made,
        # so a run can go a little over. Then the lead answers with its tools off.
        self.assertEqual([request.model for request in fake.requests], ["lead-model", "specialist-model", "specialist-model", "lead-model"])
        self.assertEqual([tools_off(request) for request in fake.requests], [False, False, True, True])
        self.assertEqual(answer, "From what I have (lead-model).")
        self.assertEqual(sum(a["costUsd"] for a in support.activities(study, "usage")), 4)

    async def test_a_specialist_starts_only_with_a_call_left_for_it(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_RUN_CALLS": "3", "SPECIALIST_CONCURRENCY": "2"}))
        study = support.open_study("budget-start")
        fake = FakeGemini(keeps_asking(2))

        await run_lead(fake, study)

        self.assertEqual([request.model for request in fake.requests], ["lead-model", "specialist-model", "lead-model"])
        [first, second] = fake.requests[-1].results
        self.assertEqual(first, ("ask_specialist", {"output": "From what I have (specialist-model)."}))
        error = "ask_specialist: This run has no model calls or budget left for a specialist. Answer from what you have."
        self.assertEqual(second, ("ask_specialist", {"error": error}))
        self.assertEqual([a["question"] for a in support.activities(study, "subagent.started")], ["Question 0?"])

    async def test_the_lead_asks_at_most_four_specialists_a_turn(self):
        self.enterContext(mock.patch.dict(os.environ, {"MAX_MODEL_CALLS": "2", "MAX_RUN_CALLS": "", "SPECIALIST_CONCURRENCY": "4"}))
        study = support.open_study("at-once")
        fake = FakeGemini(keeps_asking(25))

        await run_lead(fake, study)

        # Two lead calls, and two for each of the four specialists it may ask at once.
        self.assertEqual(len(fake.requests), 10)
        results = fake.requests[-1].results
        self.assertEqual([response.get("output") for _, response in results[:4]], ["From what I have (specialist-model)."] * 4)
        error = "Call ask_specialist at most 4 times in one turn. Make the other calls once these answers are back."
        self.assertEqual([response for _, response in results[4:]], [{"error": error}] * 21)
        self.assertEqual(len(support.activities(study, "subagent.started")), 4)


if __name__ == "__main__":
    unittest.main()
