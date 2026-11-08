"""trial-monitor's script: measured on-time departures for a study on trial.

The model reads; this counts. It takes the study's timeline and adds up what the
live feed measured: departures, the trips the timetable planned, and how many left
on time, by trial week and for the trial so far. It counts as the display does, so
the two agree: a share needs at least 20 departures, and is a whole percent.
"""

import hashlib
import math
from datetime import date
from pathlib import Path
from typing import Any

from core import LocalTool, call

# Below this many departures, a share says more about chance than service.
MIN_DEPARTURES = 20

# A planner approves one exact version of a skill before its results can enter a
# study, so the version is this file's hash: any change needs approving again.
VERSION = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]

WINDOWS = {
    "standard": "1 minute early to 5 minutes late, the Service Standards' on-time departure (ttc-standards-2024 p. 16)",
    "reported": "on time to 5 minutes late, the window TTC KPI reports have used since February 2025",
}

FORECAST = "Published weekly figures at current assumptions: claims, not measurements. Never add them up or set them against measured results."

DESCRIPTION = (
    "Measured on-time departures for this study's watched service patterns, from the live vehicle feed: "
    "departures measured and scheduled, and the share on time, by trial week and for the trial so far, "
    "with the whole network on the same days. It does the counting, so report its numbers."
)


RECORD = (
    "Record a share on time that trial_on_time measured, as a computed figure in this study: the script's own "
    "number, for the trial so far or one trial week, by one window. The service refuses it until a planner "
    "approves this version of the skill."
)

RECORD_PARAMETERS = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "The figure's id, such as on-time-trial."},
        "label": {"type": "string", "description": "What it is, for planners, such as: On time, trial so far."},
        "window": {"type": "string", "enum": list(WINDOWS), "description": "Which on-time window: standard or reported."},
        "week": {"type": "integer", "description": "A trial week, from 1. Leave it out for the trial so far."},
    },
    "required": ["id", "label", "window"],
}


def tools(session: Any, study: str) -> list[LocalTool]:
    """The trial_on_time and record_on_time tools, for a specialist working on this study."""

    async def trial_on_time(**_: Any) -> dict[str, Any]:  # it takes nothing, so stray arguments don't matter
        timeline = await call(session, "get_timeline", {"studyId": study})
        trial = (await call(session, "get_study", {"studyId": study})).get("trial")
        return measure(timeline, trial["startedOn"] if trial else None)

    async def record_on_time(id: str, label: str, window: str, week: int | None = None, **_: Any) -> Any:
        # The value comes from the script, never from the model, so what a planner
        # approved is what produced the number.
        if window not in WINDOWS:
            raise ValueError(f"window must be one of {', '.join(WINDOWS)}")
        result = await trial_on_time()
        if week is None:
            period, weeks = result["trialSoFar"], [w["week"] for w in result["byTrialWeek"]]
            run = f"trial weeks {weeks[0]}–{weeks[-1]}" if weeks else "every measured day"
        else:
            found = [w for w in result["byTrialWeek"] if w["week"] == int(week)]
            if not found:
                raise ValueError(f"Nothing was measured in trial week {week}.")
            period, run = found[0], f"trial week {int(week)}"
        if period["percentOnTime"] is None:
            raise ValueError(f"Too few departures to record a share: {period['departures']}, under {MIN_DEPARTURES}.")
        basis = {"kind": "computed", "skill": "trial-monitor", "version": VERSION, "run": f"{run}, {window} window"}
        figure = {"id": id, "label": label, "unit": "%", "value": period["percentOnTime"][window], "basis": basis}
        return await call(session, "record_figure", {"studyId": study, **figure})

    return [
        LocalTool("trial_on_time", DESCRIPTION, trial_on_time),
        LocalTool("record_on_time", RECORD, record_on_time, RECORD_PARAMETERS),
    ]


def measure(timeline: dict[str, Any], started_on: str | None) -> dict[str, Any]:
    """A study's measured results from its timeline: for the trial so far, by trial week, and for the network."""
    start = date.fromisoformat(started_on) if started_on else None
    trial, before = [], []
    weeks: dict[int, list[dict[str, Any]]] = {}
    for day in timeline["measured"]["days"]:
        if start is None:
            trial.append(day)
            continue
        days = (date.fromisoformat(day["date"]) - start).days
        if days < 0:
            before.append(day)
        else:
            trial.append(day)
            weeks.setdefault(days // 7 + 1, []).append(day)
    dates = {day["date"] for day in trial}
    result: dict[str, Any] = {
        "patterns": timeline["measured"]["patterns"],
        "today": timeline["today"],
        "trialStartedOn": started_on,
        "reviewOn": timeline["reviewOn"],
        "minimumDepartures": MIN_DEPARTURES,
        "windows": WINDOWS,
        "trialSoFar": total(trial),
        "byTrialWeek": [{"week": week, **total(days)} for week, days in sorted(weeks.items())],
        "network": total([day for day in timeline["network"]["days"] if day["date"] in dates]),
        "forecast": {"note": FORECAST, "figures": timeline["forecast"]},
        "computed": {"skill": "trial-monitor", "version": VERSION},
    }
    if before:
        result["beforeTrial"] = total(before)
    if not result["patterns"]:
        result["note"] = "This study watches no service patterns, so nothing is measured for it."
    elif start is None:
        result["note"] = "This study has no trial dates, so these results cover every measured day, with no trial weeks."
    return result


def total(days: list[dict[str, Any]]) -> dict[str, Any]:
    """One period's counts, with shares on time only when there are enough departures to judge."""
    departures = sum(day["departures"] for day in days)
    scheduled = sum(day["scheduled"] for day in days)
    standard = sum(day["onTimeStandard"] for day in days)
    reported = sum(day["onTimeReported"] for day in days)
    too_few = departures < MIN_DEPARTURES
    return {
        "days": len(days),
        "departures": departures,
        "scheduled": scheduled,
        # More measured than scheduled means the timetable doesn't match, so there is no share.
        "percentOfScheduled": percent(departures, scheduled) if scheduled >= departures and scheduled else None,
        "onTime": {"standard": standard, "reported": reported},
        "percentOnTime": None if too_few else {"standard": percent(standard, departures), "reported": percent(reported, departures)},
        "tooFew": too_few,
    }


def percent(part: int, whole: int) -> int:
    """A whole percent, rounded as the display rounds, with JavaScript's Math.round."""
    return math.floor(part / whole * 100 + 0.5)
