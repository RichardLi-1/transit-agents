"""economic-development's tools: jobs and land near stations, worked out by the service.

The specialist gets gis-analyst's tools for making layers (a route's stops or shape,
the study's line, a named area, a buffer), jobs_within, which counts the people who
work in an area layer from the 2021 census by census tract of work beside the people
who live there, and zoning_within, which measures the land each kind of zone covers,
Don Mills corridor only. The service does the geometry and every count, saves each
result as a map layer, and records its totals as figures citing the dataset. The
model reads the results, computes nothing and forecasts nothing.
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
BASE = ("list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer")

SPECS: dict[str, tuple[str, dict[str, Any]]] = {name: GIS.SPECS[name] for name in BASE} | {
    "jobs_within": (
        "Count the people who work in an area layer, such as 800 m round a line's stations: the 2021 census's people "
        "with a usual place of work there, area-weighted from census tracts of work across the Toronto CMA, and those "
        "who worked at home; beside the people who live there, with people working per resident. Saved as a layer, "
        "recorded as figures.",
        {"layer": GIS.LAYER, **GIS.NAME},
    ),
    "zoning_within": (
        "Measure the land in an area layer each kind of zone covers under Zoning By-law 569-2013: residential, mixed "
        "use, commercial, employment industrial, institutional, open space and utility, in km² and as a share of the "
        "zoned land. Don Mills corridor only: it measures inside the corridor and refuses a layer wholly beyond it. Saved "
        "as a layer, recorded as figures.",
        {"layer": GIS.LAYER, **GIS.NAME},
    ),
}
REQUIRED = {name: GIS.REQUIRED[name] for name in BASE if name in GIS.REQUIRED} | {"jobs_within": ["layer"], "zoning_within": ["layer"]}


def parameters(name: str) -> dict[str, Any]:
    return GIS.parameters(name, SPECS, REQUIRED)


def arguments(name: str, study: str, given: dict[str, Any]) -> dict[str, Any]:
    """The service tool's arguments: the model's, checked, in this run's study."""
    return GIS.arguments(name, study, given, SPECS, REQUIRED)


def tools(session: Any, study: str) -> list[Any]:
    """This skill's tools, for a specialist working on this study."""
    return GIS.tools(session, study, SPECS, REQUIRED)
