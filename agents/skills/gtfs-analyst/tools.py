"""gtfs-analyst's scripts: scheduled trips, trips by period and span of service, from the
TTC timetable this repo already holds.

The model reads; these count. They are fixed functions over two files, and no code
a model writes ever runs:

- services/api/assets/departures.json.gz: each surface trip's first scheduled
  departure, from the TTC's BusTime GTFS (scripts/build-departures.ts): its route,
  branch, the second it leaves its first stop and the days it runs. The collector
  counts a trial's scheduled trips from the same file. It records no dates.
- apps/display/public/data/network.json: trips started per route, day and hour, from
  the TTC's GTFS (scripts/build-transit-data.ts), with the last day its timetable
  covers. It has the subway and LRT lines, which the first file doesn't.

Neither keeps a trip's direction or its times at later stops, so every count is for
both directions together, where each trip leaves its first stop.
"""

import functools
import gzip
import json
import math
import re
from datetime import date
from pathlib import Path
from typing import Any

from core import LocalTool

ROOT = Path(__file__).resolve().parents[3]
DEPARTURES = ROOT / "services" / "api" / "assets" / "departures.json.gz"
NETWORK = ROOT / "apps" / "display" / "public" / "data" / "network.json"

HOUR = 3600
DAY = 24 * HOUR

# Day masks in the departures file, and the order of network.json's dayTypes.
DAYS = {"weekday": 1, "saturday": 2, "sunday": 4}
DAY_TYPES = ["weekday", "saturday", "sunday"]

# The operating periods of the Service Standards' Table 3 (ttc-standards-2024 p. 14),
# as printed, and as read here. The weekday late evening is printed "10:00 am - 1:00
# am"; it is read as 10:00 pm, as Saturday's and Sunday's are printed.
WEEKDAY = [
    ("Morning Peak", "6:00 am - 9:00 am", "06:00", "09:00"),
    ("Midday", "9:00 am - 3:00 pm", "09:00", "15:00"),
    ("Afternoon Peak", "3:00 pm - 7:00 pm", "15:00", "19:00"),
    ("Early Evening", "7:00 pm - 10:00 pm", "19:00", "22:00"),
    ("Late Evening", "10:00 am - 1:00 am", "22:00", "01:00"),
    ("Overnight", "1:30 am - 5:30 am", "01:30", "05:30"),
]
WEEKEND = [
    ("Early Morning", "6:00 am – 8:00 am", "06:00", "08:00"),
    ("Morning", "8:00 am – 12:00 pm", "08:00", "12:00"),
    ("Afternoon", "12:00 pm – 7:00 pm", "12:00", "19:00"),
    ("Early Evening", "7:00 pm – 10:00 pm", "19:00", "22:00"),
    ("Late Evening", "10:00 pm – 1:00 am", "22:00", "01:00"),
    ("Overnight", "1:30 am - 5:30 am", "01:30", "05:30"),
]
PERIODS = {"weekday": WEEKDAY, "saturday": WEEKEND, "sunday": WEEKEND}
MISPRINT = "Table 3 prints the weekday late evening as 10:00 am - 1:00 am. It is read here as 10:00 pm to 1:00 am, as the Saturday and Sunday rows print it; a planner should confirm."

COUNTED = (
    "Both directions together, counted where each trip leaves its first stop: the data keeps neither a trip's "
    "direction nor its times at later stops. Trips after midnight count with the day they belong to."
)

# A route, such as 52, or one of its branches, such as 52F.
ROUTE = re.compile(r"^(\d{1,3})([A-Z]?)$")

PARAMETERS = {
    "type": "object",
    "properties": {
        "route": {"type": "string", "description": "A TTC route, such as 52, for all its branches, or one branch, such as 52F"},
        "day": {"type": "string", "enum": DAY_TYPES, "description": "Which day's timetable: weekday, saturday or sunday"},
    },
    "required": ["route", "day"],
}

TRIPS = (
    "Scheduled trips each hour for a TTC route or branch on a weekday, Saturday or Sunday, both directions together, "
    "from the TTC timetable in this repo, with the last day it covers. Subway and LRT lines give whole routes only."
)
BY_PERIOD = (
    "Scheduled trips in each period of the Service Standards' Table 3 for a TTC bus or streetcar route or branch, both "
    "directions together: trips per hour, average minutes between trips in both directions together and the longest "
    "stretch with no trip leaving. Not a headway, which is for one direction. From the TTC timetable in this repo, with "
    "the last day it covers."
)
SPAN = (
    "A TTC bus or streetcar route's or branch's first and last scheduled trip of the day, both directions together, and "
    "the longest break with no trip leaving. From the TTC timetable in this repo, with the last day it covers."
)


def tools(session: Any, study: str) -> list[LocalTool]:
    """The scheduled_trips, trips_by_period and service_span tools. They read files, not the study."""
    return [
        LocalTool("scheduled_trips", TRIPS, lambda route, day, **_: scheduled_trips(route, day), PARAMETERS),
        LocalTool("trips_by_period", BY_PERIOD, lambda route, day, **_: trips_by_period(route, day), PARAMETERS),
        LocalTool("service_span", SPAN, lambda route, day, **_: service_span(route, day), PARAMETERS),
    ]


@functools.cache
def departures() -> dict[str, list[tuple[str, int, int]]]:
    """Each route's trips: (branch, seconds after its service day began, day mask)."""
    routes: dict[str, list[tuple[str, int, int]]] = {}
    for _trip, route, branch, _sequence, departure, days in json.loads(gzip.decompress(DEPARTURES.read_bytes())):
        routes.setdefault(route, []).append((branch, departure, days))
    return routes


@functools.cache
def network() -> dict[str, Any]:
    return json.loads(NETWORK.read_text(encoding="utf-8"))


def today() -> date:
    return date.today()


def scheduled_trips(route: str, day: str) -> dict[str, Any]:
    """Trips each hour, from the departures file, or network.json for a route that file lacks."""
    number, branch, row = pick(route, day)
    if number not in departures():
        hours = row["service"][DAY_TYPES.index(day)]
        result = answer(number, None, day, row, sum(hours))
        result["tripsByHour"] = by_hour(hours)
        result["note"] = "This line isn't in the departures file, which has bus and streetcar routes only, so these are its trips started each hour in network.json, for the whole line."
        return result
    times = trips(number, branch, day)
    result = answer(number, branch, day, row, len(times))
    result["tripsByHour"] = by_hour(hourly(times))
    return result


def trips_by_period(route: str, day: str) -> dict[str, Any]:
    """Trips and gaps in each of Table 3's periods, both directions together: not headways, which are for one."""
    number, branch, row = pick(route, day, exact=True)
    times = trips(number, branch, day)
    result = answer(number, branch, day, row, len(times))
    rows, outside = periods(times, day)
    result["periods"] = rows
    result["periodsFrom"] = "Table 3, ttc-standards-2024 p. 14"
    result["tripsOutsideThePeriods"] = outside
    if day == "weekday":
        result["periodNote"] = MISPRINT
    return result


def service_span(route: str, day: str) -> dict[str, Any]:
    """The first and last trip of the day, and the longest break with none."""
    number, branch, row = pick(route, day, exact=True)
    times = trips(number, branch, day)
    result = answer(number, branch, day, row, len(times))
    result.update(span(times))
    return result


def pick(route: str, day: str, exact: bool = False) -> tuple[str, str | None, dict[str, Any] | None]:
    """The route number, the branch if one was named, and the route's row in network.json."""
    if day not in DAYS:
        raise ValueError(f"day must be one of {', '.join(DAY_TYPES)}, not {day!r}.")
    match = ROUTE.match(str(route).strip().upper().removeprefix("LINE "))
    if not match:
        raise ValueError(f"Give a TTC route, such as 52, or a branch, such as 52F, not {route!r}.")
    number = match[1]
    row = next((r for r in network()["routes"] if r["id"] == number), None)
    if number not in departures():
        if row is None:
            raise ValueError(f"No route {number} in the TTC timetable here.")
        if exact or match[2]:
            raise ValueError(
                f"{row['name']} isn't in the departures file, which has bus and streetcar routes only, so its trips' "
                "times and branches aren't here. scheduled_trips gives its trips started each hour, for the whole line."
            )
        return number, None, row
    branch = match[0] if match[2] else None
    if branch:
        branches = sorted({b for b, _, _ in departures()[number]})
        if branch not in branches:
            raise ValueError(f"Route {number} has no branch {branch} here. Its branches: {', '.join(branches)}.")
    return number, branch, row


def trips(number: str, branch: str | None, day: str) -> list[int]:
    """When each trip leaves its first stop, in seconds after its service day began, in order."""
    mask = DAYS[day]
    return sorted(t for b, t, days in departures()[number] if days & mask and (branch is None or b == branch))


def answer(number: str, branch: str | None, day: str, row: dict[str, Any] | None, count: int) -> dict[str, Any]:
    """What every result says: what was counted, and the timetable's date."""
    result: dict[str, Any] = {
        "route": number,
        "name": row["name"] if row else None,
        "branch": branch,
        "day": day,
        "trips": count,
        "counted": COUNTED,
        "data": dated(number, day, row),
    }
    if number in departures() and branch is None:
        result["branches"] = dict(sorted(_count_branches(number, day).items()))
    if not count:
        result["note"] = f"No scheduled trips on a {day} in this timetable."
    return result


def _count_branches(number: str, day: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for branch, _, days in departures()[number]:
        if days & DAYS[day]:
            counts[branch] = counts.get(branch, 0) + 1
    return counts


def dated(number: str, day: str, row: dict[str, Any] | None) -> dict[str, Any]:
    """The timetable's date, and whether this route's trips in the departures file agree with it."""
    until = network()["serviceUntil"]
    said: dict[str, Any] = {"timetableUntil": until, "today": today().isoformat()}
    if number in departures():
        said["trips"] = "services/api/assets/departures.json.gz: each trip's first scheduled departure, from the TTC's BusTime GTFS. It records no dates."
        if row is None:
            said["date"] = f"This route isn't in network.json, so the departures file's trips for it can't be matched to the timetable to {until}."
        else:
            dated_hours = row["service"][DAY_TYPES.index(day)]
            mine = hourly(trips(number, None, day))
            said["agreesWithTimetable"] = mine == dated_hours
            if mine == dated_hours:
                said["date"] = f"Its trips by hour for this route on a {day} match network.json's, from the TTC timetable to {until}."
            else:
                hours = sum(1 for a, b in zip(mine, dated_hours) if a != b)
                said["date"] = (
                    f"Its trips for this route on a {day} differ from network.json's, from the TTC timetable to {until}: "
                    f"{sum(mine)} trips against {sum(dated_hours)}, with different counts in {hours} of 24 hours."
                )
    else:
        said["trips"] = "apps/display/public/data/network.json: trips started per hour, from the TTC's GTFS."
        said["date"] = f"The TTC timetable to {until}."
    if today().isoformat() > until:
        said["warning"] = f"This timetable ran until {until}, before today: check for a newer one before relying on it."
    return said


def hourly(times: list[int]) -> list[int]:
    """Trips leaving in each hour of the clock, 0 to 23, as network.json counts them."""
    counts = [0] * 24
    for t in times:
        counts[t // HOUR % 24] += 1
    return counts


def by_hour(counts: list[int]) -> dict[str, int]:
    return {f"{hour:02d}:00": n for hour, n in enumerate(counts)}


def periods(times: list[int], day: str) -> tuple[list[dict[str, Any]], int]:
    """Each Table 3 period's trips and gaps, and how many trips leave outside every period."""
    rows, inside_any = [], 0
    for name, printed, start_text, end_text in PERIODS[day]:
        start, end = seconds(start_text), seconds(end_text)
        length = (end - start) % DAY
        # Times of day, in order, running past midnight for a period that does.
        inside = sorted(t % DAY + (DAY if t % DAY < start else 0) for t in times if within(t % DAY, start, end))
        inside_any += len(inside)
        edges = [start, *inside, start + length]
        rows.append(
            {
                "period": name,
                "printed": printed,
                "from": start_text,
                "to": end_text,
                "trips": len(inside),
                "tripsPerHour": round(len(inside) * HOUR / length, 1),
                "averageMinutesBetweenTripsBothDirections": round(length / 60 / len(inside), 1) if inside else None,
                "longestMinutesWithNoTripLeaving": minutes(max(b - a for a, b in zip(edges, edges[1:]))),
            }
        )
    return rows, len(times) - inside_any


def within(time_of_day: int, start: int, end: int) -> bool:
    if start < end:
        return start <= time_of_day < end
    return time_of_day >= start or time_of_day < end  # past midnight


def span(times: list[int]) -> dict[str, Any]:
    """Service runs from the end of the day's longest break with no trip leaving to its start."""
    if not times:
        return {"firstTrip": None, "lastTrip": None, "longestBreakMinutes": None}
    clock_times = sorted({t % DAY for t in times})
    breaks = [(b - a, a, b) for a, b in zip(clock_times, clock_times[1:])]
    breaks.append((clock_times[0] + DAY - clock_times[-1], clock_times[-1], clock_times[0]))
    gap, last, first = max(breaks)
    return {
        "firstTrip": clock(first),
        "lastTrip": clock(last),
        "longestBreakMinutes": minutes(gap),
        "spanNote": "Service runs from firstTrip to lastTrip, either side of the day's longest break with no trip leaving. A lastTrip earlier than firstTrip is after midnight.",
    }


def seconds(text: str) -> int:
    hours, mins = map(int, text.split(":"))
    return hours * HOUR + mins * 60


def clock(t: int) -> str:
    t %= DAY
    return f"{t // HOUR:02d}:{t % HOUR // 60:02d}"


def minutes(span_seconds: int) -> int:
    """Whole minutes, halves rounded up."""
    return math.floor(span_seconds / 60 + 0.5)
