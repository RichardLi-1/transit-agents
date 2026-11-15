import importlib.util
import os
import shutil
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import core
import skills
import specialists
from tests import support
from tests.support import AGENT, SOURCE, FakeGemini, reply


def setUpModule():
    support.service.start()


def trial_monitor():
    """The trial-monitor skill's script, as a module."""
    spec = importlib.util.spec_from_file_location("trial_monitor_tools", skills.SKILLS_DIR / "trial-monitor" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def day(date, departures, standard, reported, scheduled):
    return {"date": date, "departures": departures, "onTimeStandard": standard, "onTimeReported": reported, "scheduled": scheduled}


TIMELINE = {
    "today": "2026-11-10",
    "reviewOn": "2027-11-01",
    "measured": {
        "patterns": ["52F"],
        "days": [
            day("2026-10-30", 10, 9, 8, 12),  # before the trial began
            day("2026-11-02", 25, 22, 20, 30),
            day("2026-11-03", 4, 4, 3, 4),
            day("2026-11-09", 5, 5, 5, 6),
        ],
    },
    "network": {
        "days": [
            day("2026-10-30", 900, 700, 650, 1000),
            day("2026-11-02", 1000, 800, 700, 1100),
            day("2026-11-03", 1000, 850, 800, 1100),
            day("2026-11-09", 1000, 900, 850, 1100),
            day("2026-11-10", 400, 300, 280, 500),  # nothing measured for the study that day
        ]
    },
    "forecast": [{"figure": "riders", "label": "Riders gained", "unit": "riders/week", "perWeek": 1680}],
}


class MeasureTest(unittest.TestCase):
    def setUp(self):
        self.script = trial_monitor()

    def test_counts_the_trial_so_far_and_each_trial_week(self):
        result = self.script.measure(TIMELINE, "2026-11-01")
        self.assertEqual(
            result["trialSoFar"],
            {
                "days": 3,
                "departures": 34,
                "scheduled": 40,
                "percentOfScheduled": 85,
                "onTime": {"standard": 31, "reported": 28},
                "percentOnTime": {"standard": 91, "reported": 82},
                "tooFew": False,
            },
        )
        week_1, week_2 = result["byTrialWeek"]
        self.assertEqual((week_1["week"], week_1["departures"], week_1["percentOnTime"]), (1, 29, {"standard": 90, "reported": 79}))
        self.assertEqual((week_2["week"], week_2["departures"], week_2["percentOnTime"], week_2["tooFew"]), (2, 5, None, True))
        self.assertEqual(result["beforeTrial"]["departures"], 10)
        self.assertEqual(result["patterns"], ["52F"])
        self.assertEqual((result["today"], result["trialStartedOn"], result["reviewOn"]), ("2026-11-10", "2026-11-01", "2027-11-01"))

    def test_too_few_departures_give_no_share(self):
        result = self.script.measure({**TIMELINE, "measured": {"patterns": ["52F"], "days": [day("2026-11-02", 19, 19, 19, 20)]}}, "2026-11-01")
        self.assertIsNone(result["trialSoFar"]["percentOnTime"])
        self.assertTrue(result["trialSoFar"]["tooFew"])
        self.assertEqual(result["trialSoFar"]["onTime"], {"standard": 19, "reported": 19})
        self.assertEqual(result["minimumDepartures"], 20)

    def test_compares_with_the_network_on_the_same_days_only(self):
        network = self.script.measure(TIMELINE, "2026-11-01")["network"]
        self.assertEqual((network["days"], network["departures"], network["onTime"]["standard"]), (3, 3000, 2550))

    def test_keeps_the_forecast_apart_from_what_was_measured(self):
        result = self.script.measure(TIMELINE, "2026-11-01")
        self.assertEqual(result["forecast"]["figures"], TIMELINE["forecast"])
        self.assertIn("claims, not measurements", result["forecast"]["note"])
        self.assertNotIn("perWeek", str(result["trialSoFar"]))

    def test_rounds_as_the_display_does(self):
        percent = self.script.percent
        self.assertEqual(percent(29, 40), 73)  # 72.5 rounds up, as Math.round does; Python's round gives 72
        self.assertEqual(percent(29, 200), 14)  # 0.145 * 100 is 14.499..., as in JavaScript

    def test_more_measured_than_scheduled_gives_no_share_of_scheduled(self):
        result = self.script.measure({**TIMELINE, "measured": {"patterns": ["52F"], "days": [day("2026-11-02", 30, 25, 20, 0)]}}, "2026-11-01")
        self.assertIsNone(result["trialSoFar"]["percentOfScheduled"])

    def test_without_trial_dates_counts_every_measured_day(self):
        result = self.script.measure(TIMELINE, None)
        self.assertEqual(result["trialSoFar"]["departures"], 44)
        self.assertEqual(result["byTrialWeek"], [])
        self.assertNotIn("beforeTrial", result)
        self.assertIn("no trial dates", result["note"])

    def test_says_when_a_study_watches_nothing(self):
        result = self.script.measure({**TIMELINE, "measured": {"patterns": [], "days": []}}, "2026-11-01")
        self.assertEqual(result["trialSoFar"]["departures"], 0)
        self.assertIn("watches no service patterns", result["note"])

    def test_names_its_skill_but_never_its_own_version(self):
        # The agent names the version, the content hash a planner approved, as it
        # passes a computed figure on. A version a script named could be any string.
        self.assertEqual(self.script.measure(TIMELINE, "2026-11-01")["computed"], {"skill": "trial-monitor"})
        self.assertFalse(hasattr(self.script, "VERSION"))


class OnTheServiceTest(unittest.IsolatedAsyncioTestCase):
    """The script against the real service's timeline, with departures written as the collector writes them."""

    def setUp(self):
        self.pattern = f"T{uuid.uuid4().hex[:5]}"
        self.study = f"trial-{uuid.uuid4().hex[:6]}"
        trial = {"startedOn": "2026-11-01", "reviewOn": "2027-11-01"}
        body = {"id": self.study, "title": "Trial", "trial": trial, "watch": [self.pattern], "project": ["riders"]}
        support.api("POST", "/v1/studies", body, token=AGENT)
        quote = {"contextId": SOURCE, "page": 1, "quote": "a weekly ridership increase of 1,680 customers"}
        figure = {"id": "riders", "label": "Riders gained", "unit": "riders/week", "value": 1680, "basis": {"kind": "cited", "citation": quote}}
        support.api("POST", f"/v1/studies/{self.study}/figures", figure, token=AGENT)
        self.enterContext(
            mock.patch.dict(os.environ, {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""})
        )

    def depart(self, date: str, deviations: list[int]) -> None:
        """Write departures into the service's measurements, as the collector does."""
        rows = [(f"{self.pattern}-{date}-{i}", date, "999", self.pattern, 0, 0, deviation) for i, deviation in enumerate(deviations)]
        self.measurements("INSERT INTO departures VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
        self.addCleanup(self.measurements, "DELETE FROM departures WHERE pattern = ?", [(self.pattern,)])

    def measurements(self, sql: str, rows: list[tuple]) -> None:
        db = sqlite3.connect(Path(support.service.data, "measurements.db"))
        try:
            with db:  # commits
                db.executemany(sql, rows)
        finally:
            db.close()

    async def trial_on_time(self):
        return await self.tool("trial_on_time")

    async def tool(self, name, skill=None, **arguments):
        async with support.session() as session:
            skill = skill or skills.load_skill("trial-monitor")
            tools = {tool.name: tool for tool in specialists.script_tools(skill, session, self.study)}
            return await tools[name].function(**arguments)

    async def test_nothing_measured_yet(self):
        result = await self.trial_on_time()
        self.assertEqual(result["patterns"], [self.pattern])
        self.assertEqual(result["trialStartedOn"], "2026-11-01")
        self.assertEqual(result["reviewOn"], "2027-11-01")
        self.assertEqual(result["trialSoFar"]["departures"], 0)
        self.assertTrue(result["trialSoFar"]["tooFew"])
        self.assertEqual(result["forecast"]["figures"], [{"figure": "riders", "label": "Riders gained", "unit": "riders/week", "perWeek": 1680}])

    async def test_counts_what_the_collector_measured(self):
        self.depart("2026-11-02", [60] * 20 + [-30] * 2 + [600] * 3)  # 22 on time by the standard, 20 by the KPI window
        self.depart("2026-11-09", [0] * 5)
        result = await self.trial_on_time()
        self.assertEqual(result["trialSoFar"]["departures"], 30)
        self.assertEqual(result["trialSoFar"]["onTime"], {"standard": 27, "reported": 25})
        self.assertEqual(result["trialSoFar"]["percentOnTime"], {"standard": 90, "reported": 83})
        self.assertEqual([(week["week"], week["departures"], week["tooFew"]) for week in result["byTrialWeek"]], [(1, 25, False), (2, 5, True)])
        self.assertGreaterEqual(result["network"]["departures"], 30)

    async def test_records_the_scripts_own_share_once_a_planner_approves_it(self):
        self.depart("2026-11-02", [60] * 20 + [-30] * 2 + [600] * 3)  # 22 of 25 on time by the standard
        self.depart("2026-11-09", [0] * 5)
        # A copy of the skill with one more line, so its content, and its hash, are new:
        # no planner has approved them.
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        shutil.copytree(skills.SKILLS_DIR / "trial-monitor", root / "trial-monitor", ignore=shutil.ignore_patterns("__pycache__"))
        with (root / "trial-monitor" / "SKILL.md").open("a") as text:
            text.write(f"\nA copy for {self.study}.\n")
        skill = skills.load_skill("trial-monitor", root)
        version = skill.hash
        self.assertEqual(version, skills.skill_hash(root / "trial-monitor"))
        arguments = {"id": "on-time", "label": "On time, trial so far", "window": "standard", "skill": skill}
        with self.assertRaisesRegex(core.ToolError, f"version {version} has not been approved"):
            await self.tool("record_on_time", **arguments)

        # Approving the copy replaces the live skill's version on the shared test service,
        # so the live one is approved again afterwards, as a planner rolls back.
        live = skills.skill_hash(skills.SKILLS_DIR / "trial-monitor")
        self.addCleanup(support.api, "PUT", "/v1/skills/trial-monitor", {"version": live})
        support.api("PUT", "/v1/skills/trial-monitor", {"version": version})
        figure = await self.tool("record_on_time", **arguments)
        self.assertEqual((figure["value"], figure["unit"]), (90, "%"))  # 27 of 30, as trial_on_time counts
        self.assertEqual(figure["basis"], {"kind": "computed", "skill": "trial-monitor", "version": version, "inputs": [], "run": "trial weeks 1–2, standard window"})

        week = await self.tool("record_on_time", skill, id="on-time-week-1", label="On time, trial week 1", window="reported", week=1)
        self.assertEqual(week["value"], 80)  # 20 of 25
        with self.assertRaisesRegex(ValueError, "Too few departures to record a share: 5, under 20"):
            await self.tool("record_on_time", skill, id="on-time-week-2", label="On time, trial week 2", window="standard", week=2)
        with self.assertRaisesRegex(ValueError, "Nothing was measured in trial week 9"):
            await self.tool("record_on_time", skill, id="on-time-week-9", label="On time, trial week 9", window="standard", week=9)

    async def test_a_specialist_with_the_skill_calls_it(self):
        def respond(request):
            if request.turn == 0:
                return reply(("trial_on_time", {}))
            return reply(text="Too few departures to judge yet.")

        fake = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, fake, self.study, "Is the extension on time?", skill="trial-monitor")

        self.assertIn("Skill trial-monitor:", fake.requests[0].system)
        self.assertIn("trial_on_time", fake.requests[0].tools)
        [(name, response)] = fake.requests[1].results
        self.assertEqual(name, "trial_on_time")
        self.assertEqual(response["output"]["trialSoFar"]["departures"], 0)


if __name__ == "__main__":
    unittest.main()
