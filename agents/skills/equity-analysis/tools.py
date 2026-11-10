"""equity-analysis's tools: who a change serves, worked out by the service.

The specialist gets gis-analyst's tools for making layers (a route's stops or shape,
the study's line, a named area, a buffer) and equity_profile, which sets the people
living in an area layer beside the City as a whole from the same 2021 census, and
finds the Neighbourhood Improvement Areas it reaches. The service does the geometry
and every count, saves each result as a map layer, and records its totals as figures
citing the dataset. The model reads the results and computes nothing.
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
    "equity_profile": (
        "Who lives in an area layer, such as a buffer: people in low income (LIM-AT), commuters by transit, people "
        "65 and over and 0 to 14, each as a share beside the City of Toronto's from the same 2021 census, with the "
        "difference in percentage points; the Neighbourhood Improvement Areas it reaches and the people in them; and, "
        "given a stops layer, how many stops are within 400 m of an NIA. Area-weighted estimates, saved as a layer, "
        "recorded as figures.",
        {
            "layer": GIS.LAYER,
            "stops": {"type": "string", "description": "Optional: a layer of stops, such as route_stops made, to count those within 400 m of an NIA"},
            **GIS.NAME,
        },
    ),
}
REQUIRED = {name: GIS.REQUIRED[name] for name in BASE if name in GIS.REQUIRED} | {"equity_profile": ["layer"]}


def parameters(name: str) -> dict[str, Any]:
    return GIS.parameters(name, SPECS, REQUIRED)


def arguments(name: str, study: str, given: dict[str, Any]) -> dict[str, Any]:
    """The service tool's arguments: the model's, checked, in this run's study."""
    return GIS.arguments(name, study, given, SPECS, REQUIRED)


def tools(session: Any, study: str) -> list[Any]:
    """This skill's tools, for a specialist working on this study."""
    return GIS.tools(session, study, SPECS, REQUIRED)
