"""stop-accessibility's tools: an inventory of a route's or line's stops, kept by the service.

The specialist gets gis-analyst's tools for making layers (a route's stops, a named
area, a buffer, and points_within for the stops inside an area), stop_accessibility,
which reads each stop's wheelchair_boarding from the TTC's GTFS, and stop_shelters,
which finds the City's transit shelter nearest each stop. The service does the
matching and every count, saves each result as a map layer, and records its counts as
figures citing the dataset. The model reads the results and computes nothing.
"""

import importlib.util
from pathlib import Path
from typing import Any


def _gis_analyst() -> Any:
    """gis-analyst's tools.py, whose specs and plumbing these tools share."""
    path = Path(__file__).resolve().parent.parent / "gis-analyst" / "tools.py"
    spec = importlib.util.spec_from_file_location("skill_gis_analyst_shared", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"can't load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GIS = _gis_analyst()
BASE = ("list_datasets", "list_layers", "summarise_layer", "route_stops", "named_area", "buffer", "points_within")

SPECS: dict[str, tuple[str, dict[str, Any]]] = {name: GIS.SPECS[name] for name in BASE} | {
    "stop_accessibility": (
        "Inventory a layer of TTC stops, such as route_stops made, from the TTC's GTFS: how many it marks wheelchair "
        "accessible, not accessible or with no information, and which stations have a platform marked not accessible, "
        "listing those stops and stations. An inventory, not a finding of compliance. Saved as a layer, recorded as figures.",
        {"layer": GIS.LAYER, **GIS.NAME},
    ),
    "stop_shelters": (
        "Find the City's transit shelter nearest each stop of a layer of TTC stops, within some metres (default 25): "
        "how many stops have one, how many have only one temporarily removed, and which have none. Matched by "
        "distance. Saved as a layer, recorded as figures.",
        {
            "layer": GIS.LAYER,
            "metres": {"type": "number", "description": "Optional: how close a shelter must be, 5 to 60. Default 25"},
            **GIS.NAME,
        },
    ),
}
REQUIRED = {name: GIS.REQUIRED[name] for name in BASE if name in GIS.REQUIRED} | {"stop_accessibility": ["layer"], "stop_shelters": ["layer"]}


def parameters(name: str) -> dict[str, Any]:
    return GIS.parameters(name, SPECS, REQUIRED)


def arguments(name: str, study: str, given: dict[str, Any]) -> dict[str, Any]:
    """The service tool's arguments: the model's, checked, in this run's study."""
    return GIS.arguments(name, study, given, SPECS, REQUIRED)


def tools(session: Any, study: str) -> list[Any]:
    """This skill's tools, for a specialist working on this study."""
    return GIS.tools(session, study, SPECS, REQUIRED)
