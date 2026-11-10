"""gis-analyst's tools: GIS operations on open datasets, run by the service.

Specialists aren't given the service's GIS tools. Only this skill's, which call them
for the specialist's own study and nothing else. The service does the geometry, with
Turf.js, and every count: it saves each result as a map layer on the study, logs it
so the display can show it, and records its totals as figures that cite the dataset.
The model reads the results and computes nothing.
"""

from typing import Any

from core import LocalTool, ToolError, call

LAYER = {"type": "string", "description": "A map layer's id, from list_layers or the result that made it"}
NAME = {
    "id": {"type": "string", "description": "Optional: the new layer's id, lowercase words joined by dashes. Leave it out for the usual one"},
    "title": {"type": "string", "description": "Optional: the new layer's title, under 80 characters. Leave it out for the usual one"},
}
ROUTE = {"type": "string", "description": "A TTC route number, such as 52, 510 or 1"}
DATASET = {"type": "string", "description": "A dataset's id, from list_datasets"}

# Each tool: the service's tool it calls, what the model is told, and its inputs.
SPECS: dict[str, tuple[str, dict[str, Any]]] = {
    "list_datasets": (
        "List the open datasets: id, publisher, licence, retrieval date, what each covers and what to know before "
        "using it, and the census variables overlay can total.",
        {},
    ),
    "list_layers": ("List this study's map layers, newest last: id, title, kind, feature count, dataset and how each was made.", {}),
    "summarise_layer": (
        "Summarise one layer: its area in km² or length in km, its totals with the figure recording each, how they "
        "were weighted, warnings, and its first 10 rows, largest share first.",
        {"layer": LAYER},
    ),
    "route_stops": (
        "Save a TTC route's stops as a layer, from the GTFS: every stop any of its trips calls at, all branches and both directions.",
        {"route": ROUTE, **NAME},
    ),
    "route_shape": ("Save a TTC route's main shapes as a layer of lines, from the GTFS.", {"route": ROUTE, **NAME}),
    "study_line": ("Save this study's line, as the map draws it, built and proposed parts, as a layer of lines.", dict(NAME)),
    "named_area": (
        "Save one named area as a layer to work within: a neighbourhood from toronto-neighbourhoods, such as "
        "Thorncliffe Park, or a Neighbourhood Improvement Area from toronto-nia.",
        {"dataset": DATASET, "name": {"type": "string", "description": "The area's name, such as Thorncliffe Park"}, **NAME},
    ),
    "buffer": (
        "Buffer a layer by some metres into one area, saved as a new layer. Overlapping circles count once.",
        {"layer": LAYER, "metres": {"type": "number", "description": "How far, 10 to 3000, such as 400 for a walk to a stop"}, **NAME},
    ),
    "overlay": (
        "Overlay an area layer, such as a buffer, with an area dataset: census-da-2021, toronto-nia, "
        "toronto-neighbourhoods or toronto-parks-corridor. Area-weighted totals, saved as a layer, recorded as figures.",
        {
            "layer": LAYER,
            "dataset": DATASET,
            "variables": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For census-da-2021: the totals to record, such as population, households, lowIncome, lowIncomeShare, transitShare. Default population and households",
            },
            **NAME,
        },
    ),
    "points_within": (
        "Count a point dataset's points inside an area layer: toronto-ksi collisions, ttc-gtfs stops or "
        "toronto-heritage-corridor properties. Saved as a layer, counts recorded as figures.",
        {
            "layer": LAYER,
            "dataset": DATASET,
            "from": {"type": "integer", "description": "toronto-ksi only: first year, included"},
            "to": {"type": "integer", "description": "toronto-ksi only: last year, included"},
            "fatal": {"type": "boolean", "description": "toronto-ksi only: only collisions where someone was killed"},
            "involving": {
                "type": "string",
                "enum": ["pedestrian", "cyclist", "motorcyclist"],
                "description": "toronto-ksi only: only collisions involving this road user",
            },
            **NAME,
        },
    ),
}

REQUIRED = {
    "summarise_layer": ["layer"],
    "route_stops": ["route"],
    "route_shape": ["route"],
    "named_area": ["dataset", "name"],
    "buffer": ["layer", "metres"],
    "overlay": ["layer", "dataset"],
    "points_within": ["layer", "dataset"],
}


# The skills built on this one (equity-analysis, economic-development,
# stop-accessibility) pass their own specs to the three functions below.


def parameters(name: str, specs: dict[str, Any] = SPECS, required: dict[str, list[str]] = REQUIRED) -> dict[str, Any]:
    properties = specs[name][1]
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required.get(name):
        schema["required"] = required[name]
    return schema


def arguments(name: str, study: str, given: dict[str, Any], specs: dict[str, Any] = SPECS, required: dict[str, list[str]] = REQUIRED) -> dict[str, Any]:
    """The service tool's arguments: the model's, checked, in this run's study."""
    given = dict(given)
    named = given.pop("studyId", study)
    if named != study:
        raise ValueError(f"this run works only on study {study}, so studyId must be {study!r}.")
    allowed = specs[name][1]
    if unknown := given.keys() - allowed.keys():
        takes = ", ".join(allowed) or "nothing"
        raise ValueError(f"Unknown inputs: {', '.join(sorted(unknown))}. {name} takes: {takes}.")
    if missing := [key for key in required.get(name, []) if given.get(key) in (None, "")]:
        raise ValueError(f"{name} needs {', '.join(missing)}.")
    given = {key: value for key, value in given.items() if value is not None}
    return given if name == "list_datasets" else {"studyId": study, **given}


def tools(session: Any, study: str, specs: dict[str, Any] = SPECS, required: dict[str, list[str]] = REQUIRED) -> list[LocalTool]:
    """This skill's GIS tools, for a specialist working on this study."""

    def tool(name: str) -> LocalTool:
        async def run(**given: Any) -> Any:
            try:
                return await call(session, name, arguments(name, study, given, specs, required))
            except ToolError as error:  # the service's own message, so the model can correct itself
                raise ValueError(error.message) from None

        return LocalTool(name, specs[name][0], run, parameters(name, specs, required))

    return [tool(name) for name in specs]
