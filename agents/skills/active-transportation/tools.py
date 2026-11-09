"""active-transportation's tools: walking, cycling and bike share near transit, measured by the service.

Specialists aren't given the service's GIS tools. Only this skill's, which call them
for the specialist's own study and nothing else: gis-analyst's tools that make the
layer to measure (a route's stops, the study's line, a named area, a buffer), and the
service's cycling network, sidewalks, bike share stations and first and last mile by
bike. The service measures every km and counts every station, saves each result as a
map layer on the study, and records its totals as figures that cite the dataset. The
model reads the results and computes nothing.
"""

import importlib.util
from pathlib import Path
from typing import Any

from core import LocalTool, ToolError, call


def _gis_analyst() -> Any:
    """gis-analyst's tools.py, for the tools that make layers."""
    spec = importlib.util.spec_from_file_location("skill_gis_analyst_layers", Path(__file__).parent.parent / "gis-analyst" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GIS = _gis_analyst()
LAYER = GIS.LAYER
NAME = GIS.NAME

# The layers to measure, made as gis-analyst makes them.
BASE = ("list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer")

AREA = {"type": "string", "description": "An area layer's id, such as a buffer's, from list_layers or the result that made it"}

# Each tool: what the model is told, and its inputs.
SPECS: dict[str, tuple[str, dict[str, Any]]] = {
    **{name: GIS.SPECS[name] for name in BASE},
    "cycling_within": (
        "Measure the City's cycling network inside an area layer: km of separated cycle tracks, painted bike lanes, "
        "multi-use trails and shared roads (sharrows, signed routes), and km by the City's own type. Saved as a layer; "
        "the km are recorded as figures.",
        {"layer": AREA, **NAME},
    ),
    "sidewalks_within": (
        "Measure streets inside an area layer by their sidewalks, from the City's 2017 inventory: km with sidewalks on "
        "both sides, one side, partial or none, and the share with none. Saved as a layer; the totals are recorded as figures.",
        {"layer": AREA, **NAME},
    ),
    "bike_share_within": (
        "Count Bike Share Toronto stations and their docks inside an area layer. Saved as a layer; the counts are recorded as figures.",
        {"layer": AREA, **NAME},
    ),
    "first_last_mile": (
        "For each stop of a points layer, such as route_stops makes: the nearest bike share station and the stations "
        "within metres, and the km of bikeway (cycle track, bike lane or trail) within metres. Saves two layers, bike "
        "share and bikeways, records how many stops have each within reach, and lists the stops with neither.",
        {
            "layer": {"type": "string", "description": "A layer of stops, such as route_stops makes"},
            "metres": {"type": "number", "description": "How far, 50 to 1500, such as 400 for a walk to a stop"},
            **NAME,
        },
    ),
}

REQUIRED = {
    **{name: GIS.REQUIRED[name] for name in BASE if name in GIS.REQUIRED},
    "cycling_within": ["layer"],
    "sidewalks_within": ["layer"],
    "bike_share_within": ["layer"],
    "first_last_mile": ["layer", "metres"],
}


def parameters(name: str) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "properties": SPECS[name][1]}
    if REQUIRED.get(name):
        schema["required"] = REQUIRED[name]
    return schema


def arguments(name: str, study: str, given: dict[str, Any]) -> dict[str, Any]:
    """The service tool's arguments: the model's, checked, in this run's study."""
    given = dict(given)
    named = given.pop("studyId", study)
    if named != study:
        raise ValueError(f"this run works only on study {study}, so studyId must be {study!r}.")
    allowed = SPECS[name][1]
    if unknown := given.keys() - allowed.keys():
        takes = ", ".join(allowed) or "nothing"
        raise ValueError(f"Unknown inputs: {', '.join(sorted(unknown))}. {name} takes: {takes}.")
    if missing := [key for key in REQUIRED.get(name, []) if given.get(key) in (None, "")]:
        raise ValueError(f"{name} needs {', '.join(missing)}.")
    given = {key: value for key, value in given.items() if value is not None}
    return given if name == "list_datasets" else {"studyId": study, **given}


def tools(session: Any, study: str) -> list[LocalTool]:
    """This skill's tools, for a specialist working on this study."""

    def tool(name: str) -> LocalTool:
        async def run(**given: Any) -> Any:
            try:
                return await call(session, name, arguments(name, study, given))
            except ToolError as error:  # the service's own message, so the model can correct itself
                raise ValueError(error.message) from None

        return LocalTool(name, SPECS[name][0], run, parameters(name))

    return [tool(name) for name in SPECS]
