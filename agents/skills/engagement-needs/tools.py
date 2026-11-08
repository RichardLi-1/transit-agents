"""engagement-needs' scripts: where on the study's line a need goes, and the only way
an agent adds one.

A need is pinned to a point on the study's line, as the display draws it. The model
names the place and gives its best lon and lat for it; this finds the nearest point
on the line, so the need sits on it, and says how far that moved the point. A place
far from the line isn't on it, so it gets an error instead.

Specialists aren't given the service's add_engagement_need. Only this skill's tool of
that name adds a need: in the specialist's own study, with at least one citation, and
at the point pinned to the line. The service checks each citation's quote.
"""

import functools
import json
import math
from pathlib import Path
from typing import Any

from core import LocalTool, ToolError, call

# The lines the display draws, built by scripts/build-transit-data.ts and
# scripts/ontario-study-line.ts: metres east and north of ORIGIN, on the same flat
# projection, which is undone here.
LINES = Path(__file__).resolve().parents[3] / "apps" / "display" / "public" / "data" / "studies.json"
ORIGIN = {"lat": 43.7, "lon": -79.4}
METRES_PER_DEG_LAT = 110_574
METRES_PER_DEG_LON = 111_320 * math.cos(math.radians(ORIGIN["lat"]))

# Farther than this from the line, a place isn't on it: the need belongs to another
# study, or the point is wrong.
MAX_METRES = 500

DESCRIPTION = (
    "Pin a place to this study's line, as the map draws it: give your best lon and lat for the place, and it "
    "returns the nearest point on the line, how far that is, and whether it is on a proposed part that isn't "
    "built. Use the point it returns as the need's lon and lat."
)

LON = {"type": "number", "description": "Your best longitude for the place, such as -79.347"}
LAT = {"type": "number", "description": "Your best latitude for the place, such as 43.756"}

PARAMETERS = {"type": "object", "properties": {"lon": LON, "lat": LAT}, "required": ["lon", "lat"]}

ADD = (
    "Propose something to make so people in one place hear about a change in this study: an image such as a "
    "poster, a short video, or both. It pins the place to the study's line, refusing one more than 500 m from it, "
    "and needs at least one citation of a page that backs the change there, with a quote exactly on the page. "
    "Nothing is made until a planner asks."
)

ADD_PARAMETERS = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Lowercase words joined by dashes, such as york-mills-poster"},
        "title": {"type": "string", "description": "A short name for what to make, such as Engagement poster"},
        "place": {"type": "string", "description": "The place as a map names it, in a few words, such as Don Mills Station"},
        "lon": LON,
        "lat": LAT,
        "kinds": {
            "type": "array",
            "items": {"type": "string", "enum": ["image", "video"]},
            "description": "image for a poster, video for screens, or both",
        },
        "reason": {"type": "string", "description": "One plain sentence on why people there need to hear about it, with no numbers"},
        "citations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "description": "The pages that back the change at this place, each with a quote exactly on its page",
            "items": {
                "type": "object",
                "properties": {
                    "contextId": {"type": "string", "description": "The source's id, such as ttc-anp-2026"},
                    "page": {"type": "integer", "description": "The page, as read_page numbers it"},
                    "quote": {"type": "string", "description": "Words exactly as they are on the page"},
                },
                "required": ["contextId", "page", "quote"],
            },
        },
    },
    "required": ["id", "title", "place", "lon", "lat", "kinds", "reason", "citations"],
}


def tools(session: Any, study: str) -> list[LocalTool]:
    """The pin_to_line and add_engagement_need tools, for a specialist working on this study."""

    async def line() -> str | None:
        return (await call(session, "get_study", {"studyId": study})).get("line")

    async def pin_to_line(lon: float, lat: float, **_: Any) -> dict[str, Any]:
        return pin(lines(), await line(), float(lon), float(lat))

    async def add_engagement_need(**need: Any) -> dict[str, Any]:
        named = need.pop("studyId", study)
        if named != study:
            raise ValueError(f"this run writes only to study {study}, so studyId must be {study!r}.")
        if unknown := need.keys() - ADD_PARAMETERS["properties"].keys():
            raise ValueError(f"Unknown inputs: {', '.join(sorted(unknown))}. It takes: {', '.join(ADD_PARAMETERS['properties'])}.")
        citations = need.get("citations")
        if not isinstance(citations, list) or not citations:
            raise ValueError(
                "No citation, no need: cite at least one page that backs the change at this place, with a quote "
                "exactly on the page."
            )
        lon, lat = need.get("lon"), need.get("lat")
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in (lon, lat)):
            raise ValueError("Give lon and lat as numbers: your best point for the place.")
        pinned = pin(lines(), await line(), float(lon), float(lat))
        try:
            added = await call(session, "add_engagement_need", {**need, "studyId": study, "lon": pinned["lon"], "lat": pinned["lat"]})
        except ToolError as error:  # the service's own message, as for its other tools
            raise ValueError(error.message) from None
        return {**added, "pinned": {key: pinned[key] for key in ("metresMoved", "onProposedPart")}}

    return [
        LocalTool("pin_to_line", DESCRIPTION, pin_to_line, PARAMETERS),
        LocalTool("add_engagement_need", ADD, add_engagement_need, ADD_PARAMETERS),
    ]


@functools.cache
def lines() -> dict[str, Any]:
    """Every study line the display draws, by line id."""
    return json.loads(LINES.read_text(encoding="utf-8"))


def pin(lines: dict[str, Any], line: str | None, lon: float, lat: float) -> dict[str, Any]:
    """The nearest point to (lon, lat) on a study's line, drawn or proposed."""
    if not line or line not in lines:
        raise ValueError("This study has no line on the map, so no need can be pinned to it. Say where one would go, for a planner.")
    x, y = project(lon, lat)
    best: tuple[float, float, float, bool] | None = None
    for proposed, key in ((False, "lines"), (True, "proposed")):
        for points in lines[line].get(key) or []:
            for a, b in zip(points, points[1:]):
                px, py = nearest(x, y, a, b)
                metres = math.hypot(px - x, py - y)
                if best is None or metres < best[2]:
                    best = (px, py, metres, proposed)
    if best is None:
        raise ValueError("This study's line has no points to pin a need to.")
    px, py, metres, proposed = best
    if metres > MAX_METRES:
        raise ValueError(
            f"That point is {metres:,.0f} m from this study's line, more than {MAX_METRES} m, so it isn't on it. "
            "Check the place, and that it is on this study's line."
        )
    pinned_lon, pinned_lat = unproject(px, py)
    return {
        "lon": round(pinned_lon, 6),
        "lat": round(pinned_lat, 6),
        "metresMoved": round(metres),
        "onProposedPart": proposed,
    }


def nearest(x: float, y: float, a: list[float], b: list[float]) -> tuple[float, float]:
    """The point on segment a-b nearest to (x, y)."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length))
    return ax + t * dx, ay + t * dy


def project(lon: float, lat: float) -> tuple[float, float]:
    return (lon - ORIGIN["lon"]) * METRES_PER_DEG_LON, (lat - ORIGIN["lat"]) * METRES_PER_DEG_LAT


def unproject(x: float, y: float) -> tuple[float, float]:
    return ORIGIN["lon"] + x / METRES_PER_DEG_LON, ORIGIN["lat"] + y / METRES_PER_DEG_LAT
