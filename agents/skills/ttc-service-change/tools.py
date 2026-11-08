"""ttc-service-change's script: classify a proposed service change as minor or major.

The model says what the change does; this applies the Service Standards' Table 7 and
the text above it (ttc-standards-2024 p. 22), and lists the steps that class requires,
each with the words it rests on. It never guesses. What the sources don't say, it names
as missing. A change Table 7 doesn't list goes to a planner, and so does one of minor
kinds that needs more than existing equipment and the adopted budget, unless the sources
say it will have a significant effect on resources: that is major.

Page numbers are read_page's. Table 7 prints its rows beside a second column, so a
row's words don't all run on: each citation quotes words that run on the page, and
gives a table row's full words as its row, for reading. The service would refuse a row
as a quote, so a model cites the quote.
"""

import math
from dataclasses import dataclass
from typing import Any

from core import LocalTool

STANDARDS = "ttc-standards-2024"
PLAN = "ttc-anp-2026"

# Table 7's minor span change, in minutes.
MINOR_SPAN_MINUTES = 90


def cite(page: int, quote: str, source: str = STANDARDS, row: str | None = None) -> dict[str, Any]:
    """Where a rule is: a source, its page, words exactly on the page and, for a table row, the row's words."""
    return {"source": source, "page": page, "quote": quote, **({"row": row} if row else {})}


# The text above Table 7: what makes a change major, and who approves it.
SUBSTANTIAL = cite(
    22,
    "Changes which are more substantial, either affecting the travel options of current TTC customers or "
    "requiring additional resources for operation, undergo a more rigorous review.",
)
INCLUDED = cite(
    22,
    "Included in this category are requests and proposals for new routes or route extensions, additional periods "
    "of service on the present routes (e.g. new weekend service) and major changes to the structure of routes in a community.",
)
BOARD = cite(22, "These major changes require TTC Board approval.")

# Table 7's resource implications, one for each class.
MINOR_RESOURCES = cite(
    22, "implemented with existing", row="Changes that can be implemented with existing equipment and within the adopted budget"
)
MAJOR_RESOURCES = cite(
    22,
    "significant effect on",
    row="Changes that will have a significant effect on resources, and may potentially have a significant effect on customers",
)

# Section 6.3: crowding's service increases, start and finish time changes and minor
# routing changes go through the Board Period process, if the budget has the resources.
BOARD_PERIOD_BUDGET = cite(
    29, "These changes are implemented through the Board Period process, subject to the availability of operating resources in the budget."
)

# A change of minor kinds that existing equipment or the adopted budget doesn't cover. The
# standards don't settle its class, so a planner does: the text above Table 7 calls a change
# needing more resources more substantial, but Table 7's major changes are those with a
# significant effect on resources, and section 6.3 has minor ones wait on the budget.
MORE_RESOURCES = {
    "question": "It needs more than existing equipment and the adopted budget, which Table 7 asks of a minor change, "
    "and the standards don't settle whether that makes it major: the text above Table 7 gives a change requiring "
    "additional resources for operation a more rigorous review, Table 7's major changes are those with a significant "
    "effect on resources, and section 6.3 introduces service increases, changes to start and finish times and minor "
    "routing changes through the Board Period process, subject to operating resources in the budget.",
    "citations": [SUBSTANTIAL, MAJOR_RESOURCES, BOARD_PERIOD_BUDGET],
}


@dataclass(frozen=True)
class Kind:
    magnitude: str | None  # minor or major, or None where Table 7 doesn't say
    means: str  # what it is, for the model choosing it
    rule: dict[str, Any] | None


KINDS = {
    "service-level": Kind(
        "minor",
        "more or fewer trips, to match capacity with demand",
        cite(22, "Service level changes to match capacity with", row="Service level changes to match capacity with demand"),
    ),
    "span": Kind(
        "minor",
        "service starting earlier or ending later, or the reverse; give span_minutes",
        cite(22, "Span of service changes within 90 minutes or", row="Span of service changes within 90 minutes or less, such as earlier or later trips"),
    ),
    "route-off-shared-road": Kind(
        "minor",
        "a routing change taking service off a road, or part of one, that other transit services also run on",
        cite(22, "Routing changes resulting in service being removed from a road (or portion of a road) where there are multiple transit services on the road"),
    ),
    "reliability-schedule": Kind("minor", "a schedule change to make service more reliable", cite(22, "Schedule changes to improve service reliability")),
    "seasonal": Kind(
        "minor",
        "a recurring seasonal route change the Board has approved before",
        cite(22, "Recurring seasonal route changes that have been previously approved by the Board"),
    ),
    "route-onto-new-road": Kind(
        "major",
        "a routing change putting service on a road, or part of one, that had no transit service",
        cite(
            22,
            "where there was no previous transit service",
            row="Routing changes resulting in service being proposed on a road (or portion of a road) where there was no previous transit service",
        ),
    ),
    "route-off-only-service": Kind(
        "major",
        "a routing change taking service off a road, or part of one, where it is the only transit option",
        cite(
            22,
            "where it is the only transit option available",
            row="Routing changes resulting in service being removed from a road (or portion of a road) where it is the only transit option available",
        ),
    ),
    "period-removed-only-option": Kind(
        "major",
        "removing a period of service, such as weekends, from a route that is the only transit option",
        cite(22, "Addition/removal of a period of service on a route where it is the only transit option available"),
    ),
    "added-period": Kind("major", "an additional period of service on a present route, such as new weekend service", INCLUDED),
    "new-route": Kind("major", "a new route", INCLUDED),
    "route-extension": Kind("major", "a route extension", INCLUDED),
    "restructure": Kind("major", "a major change to the structure of routes in a community", INCLUDED),
    "other": Kind(None, "anything else: Table 7 doesn't list it, so a planner classifies it", None),
}

# The planners' rule for the fare change's threshold. The step names it, not its value:
# planners may set another than the page's.
RIDERS_PER_100 = "ttc.min-riders-per-100"

# Every service change, of either class, except those for comfort and schedule adherence.
FARE_TEST = {
    "step": "Unless the change is needed for passenger comfort or schedule adherence, it must do better than a fare "
    "change: an increase must gain at least the threshold in new customers per $100 spent, and a reduction lose "
    f"fewer than it per $100 saved. The threshold is the rule {RIDERS_PER_100} from list_rules; test it only against "
    "that rule's value.",
    "citations": [
        cite(21, "All service changes (outside changes required for passenger comfort and schedule adherence) must do better than the threshold set by fare changes."),
        cite(21, "Service increases must gain 11 or more new customers per $100 spent and service reductions must lose less than 11 customers per $100 saved to be worthwhile."),
    ],
}

MINOR_STEPS = [
    {
        "step": "Introduce it through the Board Period process, about every six weeks, without waiting for the Annual "
        "Service Plan, subject to operating resources in the budget.",
        "citations": [
            cite(22, "Minor changes developed through the continuous monitoring of services are introduced every Board Period."),
            cite(113, "Minor changes are generally developed and introduced through the Board Period process which occurs approximately every six weeks.", PLAN),
            cite(28, "Minor service changes may also be identified at this time; however, they may be implemented as soon as possible, rather than waiting for the Annual Service Plan."),
            BOARD_PERIOD_BUDGET,
        ],
    },
    FARE_TEST,
]

MAJOR_STEPS = [
    {
        "step": "Show an overall benefit for customers: a net saving in weighted travel time, over every group the change affects.",
        "citations": [
            cite(23, "Major service changes including routing changes, the provision of new service and the addition or removal of service must result in an overall benefit for customers."),
            cite(23, "The net benefit is measured by estimating the net change in weighted travel time for customers."),
        ],
    },
    {
        "step": "Assess it on the 2026 plan's metrics: net customer impact (the effect on customers, and consultation) and "
        "service performance (boardings per service hour, net cost per passenger, ridership per net dollar).",
        "citations": [
            cite(114, "Net Customer Impact of a major service change is assessed based on two metrics:", PLAN),
            cite(114, "Service Performance of a major service change is assessed based on three metrics:", PLAN),
        ],
    },
    FARE_TEST,
    {
        "step": "Consult the public, with an engagement plan to suit the scale of the change.",
        "citations": [
            cite(31, "All major service changes and plans require public consultation."),
            cite(24, "Staff will develop engagement plans to suit the scale of work to be undertaken."),
        ],
    },
    {
        "step": "Evaluate it in the Annual Service Plan: one that meets the performance standards and the minimum customers "
        "per dollar goes to the comparative evaluation, and the plan includes those recommended.",
        "citations": [
            cite(28, "Major service changes are evaluated during the development of the Annual Service Plan."),
            cite(28, "Major service changes which meet the performance standards and whose economic performance is expected to meet the minimum value for the customer change per dollar of net cost change are referred to the comparative evaluation process."),
            cite(29, "Recommended major service changes resulting from this analysis are included in the Annual Service Plan."),
        ],
    },
    {"step": "It needs TTC Board approval.", "citations": [BOARD, cite(113, "These major changes require TTC Board approval.", PLAN)]},
    {
        "step": "A new service runs a trial of at least twelve months, then a formal evaluation. New routes, extensions and "
        "added periods of service at an additional cost also get a financial review.",
        "citations": [
            cite(29, "Every new service that the TTC introduces is initially operated for a trial period of at least twelve months"),
            cite(30, "A formal evaluation will be conducted after twelve months"),
            cite(30, "New routes, extensions and additional periods of service, which have been introduced at an additional cost, undergo a financial review to check that the service meets the TTC's financial standard."),
        ],
    },
]

# Conditions the standards set on some kinds of change, whichever class it falls in.
CONDITIONS = {
    "service-level": [
        cite(23, "Service level increases will be considered on a route when the vehicle crowding thresholds identified in Section 3.2 are consistently greater than 95% for a period of six months."),
        cite(23, "Service level reductions will be considered on a route when vehicle crowding targets identified in Section 3.2 are consistently below 80% for a period of six months."),
        cite(24, "considered as long as the resulting vehicle crowding target does not exceed 95%"),
        cite(24, "Service reductions should not result in a headway widening greater than 25%"),
        cite(24, "Service reductions will not be made on a route that belongs to the 10 minute network if the change results in a headway greater than 10 minutes."),
    ],
    "span": [
        cite(24, "An additional period of operation or an additional first/last trip will be considered on a route if estimated ridership projections demonstrate that the minimum boardings per revenue vehicle hour thresholds identified in Section 4.1 can be met."),
    ],
    "route-off-shared-road": [cite(29, "Minor routing changes using weighted passenger minutes (see Section 5.1.1) can also be made.")],
}
CONDITIONS["added-period"] = CONDITIONS["span"]

DESCRIPTION = (
    "Classify a proposed TTC service change as minor or major by the Service Standards' Table 7, and list the steps "
    "that class requires, each cited. Give only what the sources say: it never guesses, names what's missing, and "
    "leaves to a planner a change Table 7 doesn't list, or one of minor kinds that needs more resources than "
    "existing equipment and the adopted budget. To cite a rule, use its quote, which is word for word on its page, "
    "never its row: a table row's full words don't run on the page, and the service refuses them."
)

PARAMETERS = {
    "type": "object",
    "properties": {
        "changes": {
            "type": "array",
            "items": {"type": "string", "enum": list(KINDS)},
            "description": "Each kind of change the proposal makes. "
            + "; ".join(f"{name}: {kind.means}" for name, kind in KINDS.items())
            + ".",
        },
        "span_minutes": {
            "type": "number",
            "description": "For a span change: by how many minutes the span of service grows or shrinks. If it moves at both ends, add them.",
        },
        "existing_equipment": {
            "type": "boolean",
            "description": "Whether the sources say it can be done with existing equipment. Leave it out if they don't say.",
        },
        "within_budget": {
            "type": "boolean",
            "description": "Whether the sources say it fits within the adopted budget. Leave it out if they don't say.",
        },
        "significant_resource_effect": {
            "type": "boolean",
            "description": "Whether the sources say it will have a significant effect on resources, as Table 7's major "
            "changes do. Leave it out if they don't say.",
        },
    },
}


def tools(session: Any, study: str) -> list[LocalTool]:
    """The classify_service_change tool. It reads nothing from the service: the model gives it the change."""
    return [LocalTool("classify_service_change", DESCRIPTION, classify, PARAMETERS)]


def classify(
    changes: list[str] | None = None,
    span_minutes: float | None = None,
    existing_equipment: bool | None = None,
    within_budget: bool | None = None,
    significant_resource_effect: bool | None = None,
    **unknown: Any,
) -> dict[str, Any]:
    """A change's class, minor or major, with the rules it rests on and the steps it needs.

    The class is None when something is missing, Table 7 doesn't list the change, or a
    change of minor kinds needs more than existing equipment and the adopted budget: then
    the result says what to find, or what a planner must classify.
    """
    if unknown:
        raise ValueError(
            f"Unknown inputs: {', '.join(sorted(unknown))}. It takes changes, span_minutes, existing_equipment, "
            "within_budget and significant_resource_effect."
        )
    if changes is not None and (not isinstance(changes, list) or not all(isinstance(kind, str) for kind in changes)):
        raise ValueError(f"changes must be a list of kinds of change: {', '.join(KINDS)}.")
    kinds = list(dict.fromkeys(changes or []))
    strange = [kind for kind in kinds if kind not in KINDS]
    if strange:
        raise ValueError(f"Unknown kinds of change: {', '.join(map(str, strange))}. Use: {', '.join(KINDS)}.")
    if span_minutes is not None and (
        isinstance(span_minutes, bool)
        or not isinstance(span_minutes, (int, float))
        or not math.isfinite(span_minutes)
        or span_minutes < 0
    ):
        raise ValueError("span_minutes must be a number of minutes, 0 or more.")
    existing_equipment = flag(existing_equipment, "existing_equipment")
    within_budget = flag(within_budget, "within_budget")
    significant = flag(significant_resource_effect, "significant_resource_effect")

    major: list[dict[str, Any]] = []
    minor: list[dict[str, Any]] = []
    missing: list[str] = []
    unlisted: list[str] = []
    if not kinds:
        missing.append("changes: what kinds of change the proposal makes")
    for name in kinds:
        kind = KINDS[name]
        if name == "span":
            if span_minutes is None:
                missing.append("span_minutes: by how many minutes the span of service changes")
            elif span_minutes > MINOR_SPAN_MINUTES:
                unlisted.append(
                    f"a span change of {span_minutes:g} minutes: Table 7 lists span changes within {MINOR_SPAN_MINUTES} "
                    "minutes as minor, and lists no longer one"
                )
            else:
                minor.append({"change": name, "rule": kind.rule})
        elif kind.magnitude is None:
            unlisted.append("a change Table 7 doesn't list")
        else:
            (major if kind.magnitude == "major" else minor).append({"change": name, "rule": kind.rule})
    if significant:
        # Table 7's major changes are those with a significant effect on resources.
        major.append({"change": "resources", "rule": MAJOR_RESOURCES, "alsoSee": SUBSTANTIAL})

    if major:
        return result("major", major, unlisted=unlisted, kinds=kinds)
    # Table 7's minor changes are those existing equipment and the adopted budget cover.
    # Needing more doesn't make a change major by itself (MORE_RESOURCES): a planner classifies it.
    more_resources = existing_equipment is False or within_budget is False
    # Ask for everything at once: a span change missing its minutes may still be minor.
    could_be_minor = not more_resources and (bool(minor) or ("span" in kinds and span_minutes is None))
    if could_be_minor and (existing_equipment is None or within_budget is None):
        missing.append(
            "existing_equipment and within_budget: whether the sources say it can be done with existing equipment "
            "and within the adopted budget, as a minor change must be"
        )
    if missing or unlisted or more_resources:
        return result(None, minor, missing=missing, unlisted=unlisted, more_resources=more_resources, kinds=kinds)
    minor.append({"change": "resources", "rule": MINOR_RESOURCES})
    return result("minor", minor, kinds=kinds)


def flag(value: Any, name: str) -> bool | None:
    """True or false, or None when the sources don't say. Anything else is refused: the
    text "false" would read as true."""
    if value is None or isinstance(value, bool):
        return value
    raise ValueError(f"{name} must be true or false, or left out if the sources don't say.")


def result(
    magnitude: str | None,
    because: list[dict[str, Any]],
    *,
    missing: list[str] | None = None,
    unlisted: list[str] | None = None,
    more_resources: bool = False,
    kinds: list[str],
) -> dict[str, Any]:
    out: dict[str, Any] = {"class": magnitude, "because": because}
    if magnitude:
        out["steps"] = MAJOR_STEPS if magnitude == "major" else MINOR_STEPS
    if missing:
        out["missing"] = missing
    if unlisted and magnitude:
        out["note"] = f"Part of it isn't in Table 7 ({'; '.join(unlisted)}), but its major parts make it major."
    if not magnitude and (unlisted or more_resources):
        unsettled = [f"Table 7 doesn't classify {'; '.join(unlisted)}."] if unlisted else []
        if more_resources:
            unsettled.append(MORE_RESOURCES["question"])
            out["forPlannerCitations"] = MORE_RESOURCES["citations"]
        out["forPlanner"] = f"{' '.join(unsettled)} A planner must classify it."
    conditions = [citation for kind in kinds for citation in CONDITIONS.get(kind, [])]
    if conditions:
        out["conditions"] = list({c["quote"]: c for c in conditions}.values())
    if magnitude is None:
        out["note"] = "Not classified. Find what's missing in the sources, or say it's a gap; don't classify it yourself."
        if more_resources:
            out["note"] += " If the sources say it will have a significant effect on resources, give significant_resource_effect: Table 7 makes that major."
    return out
