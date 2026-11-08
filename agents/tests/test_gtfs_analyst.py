"""The gtfs-analyst skill: fixed functions over the TTC timetable in this repo, and a
specialist that calls them."""

import importlib.util
import os
import unittest
from datetime import date
from unittest import mock

import skills
import specialists
from tests import support
from tests.support import FakeGemini, reply
from tests.test_skills import SOURCES, normalize


def setUpModule():
    support.service.start()


def gtfs_analyst():
    """The gtfs-analyst skill's script, as a module."""
    spec = importlib.util.spec_from_file_location("gtfs_analyst_tools", skills.SKILLS_DIR / "gtfs-analyst" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def at(clock: str) -> int:
    """Seconds after the service day began, from "H:MM", which may run past 24:00."""
    hours, minutes = map(int, clock.split(":"))
    return hours * 3600 + minutes * 60


class CountingTest(unittest.TestCase):
    """The arithmetic, on trips made up here."""

    def setUp(self):
        self.script = gtfs_analyst()

    def test_counts_trips_by_clock_hour_as_the_display_does(self):
        counts = self.script.hourly([at("6:00"), at("6:59"), at("7:00"), at("24:10"), at("25:05")])
        self.assertEqual((counts[0], counts[1], counts[6], counts[7], sum(counts)), (1, 1, 2, 1, 5))

    def test_each_period_has_its_trips_and_gaps(self):
        times = [at("6:10"), at("6:40"), at("7:00"), at("8:30"), at("9:05")]
        rows, outside = self.script.periods(times, "weekday")
        peak = rows[0]
        self.assertEqual((peak["period"], peak["from"], peak["to"]), ("Morning Peak", "06:00", "09:00"))
        self.assertEqual((peak["trips"], peak["tripsPerHour"], peak["averageMinutesBetweenTripsBothDirections"]), (4, 1.3, 45.0))
        self.assertEqual(peak["longestMinutesWithNoTripLeaving"], 90)  # 7:00 to 8:30
        self.assertEqual((rows[1]["trips"], rows[1]["longestMinutesWithNoTripLeaving"]), (1, 355))  # 9:05 to 3:00 pm
        self.assertEqual(outside, 0)

    def test_a_period_with_no_trips_is_one_long_gap(self):
        rows, _ = self.script.periods([at("12:00")], "saturday")
        early = rows[0]
        self.assertEqual((early["period"], early["trips"], early["averageMinutesBetweenTripsBothDirections"]), ("Early Morning", 0, None))
        self.assertEqual(early["longestMinutesWithNoTripLeaving"], 120)

    def test_the_late_evening_runs_past_midnight(self):
        # 23:50 on the service day, then 00:20 written both ways GTFS allows: 24:20, and 0:20.
        rows, outside = self.script.periods([at("23:50"), at("24:20"), at("0:20"), at("1:10")], "sunday")
        late = next(row for row in rows if row["period"] == "Late Evening")
        self.assertEqual((late["from"], late["to"], late["trips"]), ("22:00", "01:00", 3))
        self.assertEqual(late["longestMinutesWithNoTripLeaving"], 110)  # 22:00 to 23:50
        self.assertEqual(outside, 1)  # 1:10 is between the late evening and the overnight

    def test_the_span_runs_either_side_of_the_longest_break(self):
        hourly = [at(f"{hour}:00") for hour in range(6, 24)]
        span = self.script.span([at("5:15"), *hourly, at("23:30"), at("25:40")])  # the last trip leaves at 1:40 am
        self.assertEqual((span["firstTrip"], span["lastTrip"], span["longestBreakMinutes"]), ("05:15", "01:40", 215))

    def test_a_route_that_runs_all_night_has_only_short_breaks(self):
        times = [at(f"{hour}:00") for hour in range(24)] + [at("3:30")]
        span = self.script.span(times)
        self.assertEqual(span["longestBreakMinutes"], 60)
        self.assertEqual(self.script.span([]), {"firstTrip": None, "lastTrip": None, "longestBreakMinutes": None})

    def test_rounds_halves_up(self):
        self.assertEqual((self.script.minutes(90), self.script.minutes(89), self.script.minutes(150)), (2, 1, 3))


class TimetableTest(unittest.TestCase):
    """The tools on the timetable files the repo holds."""

    def setUp(self):
        self.script = gtfs_analyst()
        self.network = self.script.network()

    def dated(self, route, day):
        row = next(r for r in self.network["routes"] if r["id"] == route)
        return row["service"][self.script.DAY_TYPES.index(day)]

    def test_counts_a_routes_trips_and_states_the_timetables_date(self):
        result = self.script.scheduled_trips("52", "weekday")
        self.assertEqual((result["route"], result["name"], result["branch"]), ("52", "Lawrence West", None))
        self.assertEqual(list(result["tripsByHour"].values()), self.dated("52", "weekday"))
        self.assertEqual(result["trips"], sum(self.dated("52", "weekday")))
        self.assertEqual(sum(result["branches"].values()), result["trips"])
        self.assertEqual(result["data"]["timetableUntil"], self.network["serviceUntil"])
        self.assertTrue(result["data"]["agreesWithTimetable"])
        self.assertIn(f"from the TTC timetable to {self.network['serviceUntil']}", result["data"]["date"])
        self.assertIn("Both directions together", result["counted"])

    def test_a_branch_is_part_of_its_route(self):
        whole, branch = self.script.scheduled_trips("52", "weekday"), self.script.scheduled_trips("52f", "weekday")
        self.assertEqual(branch["branch"], "52F")
        self.assertEqual(branch["trips"], whole["branches"]["52F"])
        self.assertNotIn("branches", branch)

    def test_every_trip_is_in_a_period_or_counted_outside_them(self):
        for day in ("weekday", "saturday", "sunday"):
            with self.subTest(day):
                result = self.script.trips_by_period("52F", day)
                self.assertEqual(sum(row["trips"] for row in result["periods"]) + result["tripsOutsideThePeriods"], result["trips"])
                self.assertEqual(result["periodsFrom"], "Table 3, ttc-standards-2024 p. 14")
                self.assertEqual("periodNote" in result, day == "weekday")

    def test_gives_the_span_of_service(self):
        result = self.script.service_span("52", "weekday")
        self.assertRegex(result["firstTrip"], r"^\d\d:\d\d$")
        self.assertRegex(result["lastTrip"], r"^\d\d:\d\d$")
        self.assertGreater(result["longestBreakMinutes"], 0)

    def test_a_subway_line_has_hourly_counts_only(self):
        result = self.script.scheduled_trips("Line 1", "sunday")
        self.assertEqual((result["route"], result["branch"]), ("1", None))
        self.assertEqual(list(result["tripsByHour"].values()), self.dated("1", "sunday"))
        self.assertIn("isn't in the departures file", result["note"])
        for tool in (self.script.trips_by_period, self.script.service_span):
            with self.assertRaisesRegex(ValueError, "isn't in the departures file, which has bus and streetcar routes only"):
                tool("1", "weekday")

    def test_says_when_a_route_doesnt_run(self):
        result = self.script.service_span("10", "saturday")  # Van Horne runs on weekdays only
        self.assertEqual((result["trips"], result["firstTrip"]), (0, None))
        self.assertIn("No scheduled trips on a saturday", result["note"])

    def test_refuses_what_it_cant_answer(self):
        cases = {
            ("52Z", "weekday"): "Route 52 has no branch 52Z here. Its branches: 52, ",
            ("999", "weekday"): "No route 999 in the TTC timetable here.",
            ("52", "monday"): "day must be one of weekday, saturday, sunday",
            ("Lawrence", "weekday"): "Give a TTC route, such as 52",
        }
        for (route, day), problem in cases.items():
            with self.subTest(route=route, day=day), self.assertRaisesRegex(ValueError, problem):
                self.script.scheduled_trips(route, day)

    def test_warns_once_the_timetable_has_ended(self):
        until = date.fromisoformat(self.network["serviceUntil"])
        with mock.patch.object(self.script, "today", return_value=until.replace(year=until.year + 1)):
            self.assertIn("check for a newer one", self.script.scheduled_trips("52", "weekday")["data"]["warning"])
        with mock.patch.object(self.script, "today", return_value=until):
            self.assertNotIn("warning", self.script.scheduled_trips("52", "weekday")["data"])

    def test_table_3s_periods_are_as_printed(self):
        page = normalize(SOURCES["ttc-standards-2024"][14])
        for day, rows in self.script.PERIODS.items():
            for name, printed, start, end in rows:
                with self.subTest(day=day, period=name):
                    self.assertIn(normalize(name), page)
                    self.assertIn(normalize(printed), page)
                    if (day, name) == ("weekday", "Late Evening"):  # printed 10:00 am, read as 10:00 pm
                        self.assertEqual((printed, start, end), ("10:00 am - 1:00 am", "22:00", "01:00"))
                        continue
                    self.assertEqual((start, end), tuple(map(self.twenty_four_hour, printed.replace("–", "-").split(" - "))))

    @staticmethod
    def twenty_four_hour(text: str) -> str:
        clock, half = text.split()
        hours, minutes = map(int, clock.split(":"))
        return f"{hours % 12 + (12 if half == 'pm' else 0):02d}:{minutes:02d}"


class SpecialistTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_specialist_with_the_skill_calls_its_tools(self):
        study = support.open_study("gtfs")
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

        def respond(request):
            if request.turn == 0:
                return reply(("trips_by_period", {"route": "52F", "day": "weekday"}), ("service_span", {"route": "1", "day": "weekday"}))
            return reply(text="The 52F's trips by period, both directions together.")

        fake = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, fake, study, "How often does the 52F run at the morning peak?", skill="gtfs-analyst")

        self.assertIn("Skill gtfs-analyst:", fake.requests[0].system)
        self.assertTrue({"scheduled_trips", "trips_by_period", "service_span"} <= fake.requests[0].tools)
        (name, periods), (_, subway) = fake.requests[1].results
        self.assertEqual(name, "trips_by_period")
        self.assertEqual(periods["output"]["periods"][0]["period"], "Morning Peak")
        self.assertIn("timetableUntil", periods["output"]["data"])
        self.assertIn("service_span: Line 1 (Yonge-University) isn't in the departures file", subway["error"])


if __name__ == "__main__":
    unittest.main()
