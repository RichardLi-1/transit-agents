"""safety-audit's tools: a Vision Zero audit of police-reported KSI collisions, run by the service.

Specialists aren't given the service's GIS tools. Only this skill's, which call them
for the specialist's own study and nothing else: gis-analyst's tools that make the
layer to audit (a route, the study's line, a named area, a buffer), and the service's
KSI profile, hot spots and trend. The service counts every collision, saves each
result as a map layer on the study, and records its main counts as figures that cite
the dataset. The model reads the results and computes nothing.
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

# The layers to audit, made as gis-analyst makes them.
BASE = ("list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer")

FILTER = {
    "from": {"type": "integer", "description": "First year, included. The collisions start in 2006"},
    "to": {"type": "integer", "description": "Last year, included. The latest year is partial"},
    "involving": {
        "type": "string",
        "enum": ["pedestrian", "cyclist", "motorcyclist"],
        "description": "Only collisions involving this road user",
    },
}

# Each tool: what the model is told, and its inputs.
SPECS: dict[str, tuple[str, dict[str, Any]]] = {
    **{name: GIS.SPECS[name] for name in BASE},
    "ksi_profile": (
        "Profile the police-reported collisions where someone was killed or seriously injured (KSI) inside an area "
        "layer, such as a buffer: by year, road user, severity, intersection or mid-block, dark, and time of day, with "
        "the people killed and seriously injured by road user. Saved as a layer; the main counts are recorded as figures.",
        {"layer": LAYER, **FILTER, **NAME},
    ),
    "ksi_hotspots": (
        "Rank the places inside an area layer with the most KSI collisions: collisions within radius metres count as one "
        "place, named by the streets police recorded. Saved as a layer.",
        {
            "layer": LAYER,
            **FILTER,
            "radius": {"type": "number", "description": "Metres, 10 to 100. Default 30, about an intersection"},
            "top": {"type": "integer", "description": "How many places to list, 1 to 25. Default 10"},
            **NAME,
        },
    ),
    "ksi_trend": (
        "Compare KSI collisions a year inside an area layer before and from a split year, over whole years only, against "
        "the whole city's change, with an exact test of whether chance alone could give the change. Default: the last "
        "ten whole years, split in half. Saved as a layer; the counts and change are recorded as figures.",
        {
            "layer": LAYER,
            **FILTER,
            "split": {"type": "integer", "description": "The first year of the later period, such as the year a change was made"},
            **NAME,
        },
    ),
}

REQUIRED = {**{name: GIS.REQUIRED[name] for name in BASE if name in GIS.REQUIRED}, "ksi_profile": ["layer"], "ksi_hotspots": ["layer"], "ksi_trend": ["layer"]}


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
