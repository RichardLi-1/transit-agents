"""metrolinx-bca's script: a benefit-cost analysis by Metrolinx's Business Case Manual.

The model finds a project's own yearly benefits and costs in the sources; this discounts
them to present values and gives the NPV, the benefit-cost ratio and the NPV per dollar
of capital, with optimism bias on capital cost by the level of design. Costs whose
estimates leave escalation out grow at the manual's 1% a year, to 30 years from the base
year. Every constant names the page it comes from (metrolinx-bcm-vol2, in read_page's
numbering), and each result lists them.

It never fills in an input. Without one, it computes nothing and names what's missing.
Planners set the appraisal rules, so it reads them first, and computes nothing while one
differs from the manual's value it uses.

Some of the manual's tables print a row beside another column, so a row's words don't
all run on: a citation quotes words that run on the page, and gives such a row's full
words as its row, for reading. The service would refuse a row as a quote, so a model
cites the quote.
"""

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from core import LocalTool, call

MANUAL = "metrolinx-bcm-vol2"
IBC = "ontario-line-ibc-2019"
PDBC = "ontario-line-pdbc-2020"


def cite(page: int, quote: str, source: str = MANUAL, row: str | None = None) -> dict[str, Any]:
    """Where a rule is: a source, its page, words exactly on the page and, for a table row, the row's words."""
    return {"source": source, "page": page, "quote": quote, **({"row": row} if row else {})}


DISCOUNT_RATE = 3.5  # % a year, real
OPERATING_YEARS = 60
VALUE_OF_TIME = 18.79  # $ an hour of weighted travel time
VALUE_OF_TIME_DOLLARS = 2021
GROWTH_CAP_YEARS = 30
# Table 5.35's real growth in capital and in operating and maintenance costs, % a year,
# for cost estimates that leave escalation out, to GROWTH_CAP_YEARS from the base year.
COST_GROWTH = 1.0
# Table 5.5: the uplift on capital cost, in %, up to each level of design complete, and its stage.
OPTIMISM_BIAS = (
    (10, 64.0, "Initial Business Case"),
    (20, 18.0, "Preliminary Design Business Case"),
    (30, 9.0, "Preliminary Design Business Case"),
    (100, 4.0, "Full Business Case"),
)
SMALL_SCALE, LARGE_SCALE = 50, 500  # $M of capital

# The planners' rules for the same values, which this script won't contradict.
RULES = {
    "metrolinx.discount-rate": DISCOUNT_RATE,
    "metrolinx.evaluation-period": OPERATING_YEARS,
    "metrolinx.value-of-time": VALUE_OF_TIME,
    "metrolinx.optimism-bias-ibc": OPTIMISM_BIAS[0][1],
}

# Table 5.5's rows: the level of design, the uplift, and the business case at each.
DESIGN = [
    cite(103, "Level of Design Completion 0-10% 11-20% 21-30% 31-100%"),
    cite(103, "OB 64% OB 18% OB 9% OB 4%"),
    cite(103, "IBC PDBC PDBC FBC"),
]

PARAMETERS_CITED = {
    "discountRate": {
        "value": DISCOUNT_RATE,
        "unit": "% a year, on real values",
        "citations": [
            cite(179, "Discount Rate 3.5%"),
            cite(93, "Discounting is to be applied after prices", row="Discounting is to be applied after prices have been adjusted to real terms."),
        ],
    },
    "evaluationPeriod": {
        "value": OPERATING_YEARS,
        "unit": "years of operation, after the years from the base year to opening, as both Ontario Line business cases count it",
        "citations": [
            cite(179, "Evaluation Period 5 to 60 years (depending on project lifecycle/impacts)"),
            cite(67, "60 years of operation (2028-2088) for Ontario Line", IBC),
            cite(107, "70 years (Includes construction period and 60 years of operation)", PDBC),
        ],
    },
    "valueOfTime": {
        "value": VALUE_OF_TIME,
        "unit": "$ an hour of weighted travel time, in 2021 dollars, with no real growth. Table 5.35 prints no unit; the Ontario Line PDBC states its own value an hour",
        "citations": [cite(179, "Value of Time $18.79 (2021 $)"), cite(179, "Value of Time Growth Rate 0% (real)"), cite(107, "$18.42/hour", PDBC)],
    },
    "optimismBias": {
        "value": {"0-10%": 64, "11-20%": 18, "21-30%": 9, "31-100%": 4},
        "unit": "% uplift on capital cost by level of design complete, in the economic case only",
        "citations": [
            *DESIGN,
            cite(101, "Metrolinx only adjusts capital costs for optimism bias."),
            cite(99, "it is only intended for economic project appraisal in the Economic Case."),
        ],
    },
    "dollars": {"value": "real dollars of the base year, the year of evaluation", "citations": [cite(179, "Dollar Value Real, year of evaluation")]},
    "growthCap": {
        "value": GROWTH_CAP_YEARS,
        "unit": "years from the base year, after which inputs stop growing",
        "citations": [cite(179, "Growth Cap 30 years from the base year of project evaluation")],
    },
    "costGrowth": {
        "value": {"capitalCosts": COST_GROWTH, "operatingCosts": COST_GROWTH},
        "unit": "% a year, real, from the base year to 30 years after it, on cost estimates that leave escalation out",
        "citations": [
            cite(179, "Capital Cost Growth Rate 1% (real)"),
            cite(179, "Operating and Maintenance Cost Growth 1% Rate (real)"),
            cite(93, "considered when developing estimates", row="Escalation should be considered when developing estimates for capital and operating costs."),
            cite(
                93,
                "absence of sufficient data to estimate escalation, an assumed rate of 1%",
                row="In the absence of sufficient data to estimate escalation, an assumed rate of 1% may be used until 30 years from the base year of project evaluation.",
            ),
        ],
    },
}

FORMULAS = {
    "presentValue": {
        "rule": "Year 0, the base year, is not discounted; each later year t is divided by (1 + 3.5%)^t, and the years are added up.",
        "citations": [cite(93, "Equation 5.1: Discounting Equation"), cite(172, "discounted to the present year.")],
    },
    "npv": {
        "rule": "PV of benefits - PV of costs",
        "citations": [cite(173, "Conventional NPV = PV User Impacts + PV External Impacts - PV Costs"), cite(95, "NPV = PVB – PVC")],
    },
    "bcr": {"rule": "PV of benefits / PV of costs", "citations": [cite(173, "Conventional BCR = (PV User Impacts + PV External Impacts) / (PV Costs)")]},
    "npvPerCapitalCost": {
        "rule": "NPV / PV of capital costs",
        "citations": [cite(173, "= Conventional NPV / PV Capital Costs"), cite(94, "divided by capital costs (NPV/k)")],
    },
    "expanded": {
        "rule": "As above, with wider economic impacts added to the benefits",
        "citations": [
            cite(173, "Expanded NPV = PV User Impacts + PV External Impacts + PV WEIs - PV Costs"),
            cite(173, "Expanded BCR = (PV User Impacts + PV External Impacts + PV WEIs) / (PV Costs)"),
            cite(173, "Expanded Capital Utilization = Expanded NPV / PV Capital Costs"),
        ],
    },
    "negativeRatios": {
        "rule": "Where benefits are negative, report All Loss, -PVB / PVC; where costs are negative and benefits positive, All Gain, PVB / -PVC, never a negative BCR.",
        "citations": [
            cite(95, '"All Loss" should be reported', row='When a project generates negative benefits, "All Loss" should be reported instead of a negative BCR.'),
            cite(
                95,
                '"All Gain" should be reported instead of a negative BCR.',
                row='When a project generates positive benefits, but there are also cost savings generated over the life of the project, "All Gain" should be reported instead of a negative BCR.',
            ),
        ],
    },
    "rounding": {
        "rule": "Report present values and the NPV to two significant digits, and ratios to two decimal places.",
        "citations": [
            cite(
                172,
                "NPV metric should be reported to",
                row="All impacts estimated in the Economic Case including costs, user and external impacts, CBA adjustments and the NPV metric should be reported to two significant digits.",
            ),
            cite(172, "Ratios including BCR and ROI should be reported to two decimal places"),
        ],
    },
}

# Table 5.6: how optimism bias goes on a cost estimate that already holds a contingency.
QCRA = cite(103, "Contingency Supported by QCRA (1+64%) (1+18%) (1+9%) (1+4%)")
NO_QCRA = cite(103, "Absence of a QCRA", row="(Point Estimate+% contingency uplift) * (1+18%)")
ADJUSTED = [
    cite(103, "OB uplift must", row="OB uplift must be adjusted to account for the contingency uplift to derive OB uplift and Stdev to match DfT guidelines."),
    cite(103, "Adjusted OB Uplift % = (1+Contingency Uplift %)/(1+Project Stage OB Uplift)-1"),
]
SUNK = cite(112, "The analyst should ensure sunk costs are", row="The analyst should ensure sunk costs are not included in the appraisal.")
SCALE = {
    "small": cite(102, "Small Scale Projects (<$50 million)", row="Small scale projects are not required to include an OB uplift at this time."),
    "large": cite(
        102,
        "Large Scale Projects (>$500 million)",
        row="Large scale projects will report costs as range estimates with an OB uplift and stdev processed through a Monte Carlo simulation",
    ),
}

DESCRIPTION = (
    "A benefit-cost analysis by Metrolinx's Business Case Manual, on a project's own yearly benefits and costs from "
    "the sources: present values at the manual's discount rate over 60 years of operation, optimism bias on capital "
    "cost by level of design, the NPV and the benefit-cost ratio, each constant cited. Leave out any input the "
    "sources don't give: it never fills one in, computes nothing, and names what's missing. To cite a constant, use "
    "its quote, which is word for word on its page, never its row: a row's full words don't run on the page, and the "
    "service refuses them."
)


def spans(what: str) -> dict[str, Any]:
    return {
        "type": "array",
        "description": f"{what} One entry for each run of years with the same yearly amount; amounts in overlapping runs add up.",
        "items": {
            "type": "object",
            "properties": {
                "from": {"type": "integer", "description": "The first year, such as 2027."},
                "to": {"type": "integer", "description": "The last year, included."},
                "amount": {"type": "number", "description": "The amount in each of those years."},
            },
            "required": ["from", "to", "amount"],
        },
    }


PARAMETERS = {
    "type": "object",
    "properties": {
        "base_year": {
            "type": "integer",
            "description": "The year the appraisal begins, year 0: every amount is in real dollars of this year, and is discounted to it.",
        },
        "opening_year": {"type": "integer", "description": "The first year of operation. The appraisal runs to the 60th year of operation."},
        "design_completion": {
            "type": "number",
            "description": "Percent of design complete, 0 to 100, as the sources state it. It sets the optimism bias.",
        },
        "contingency": {
            "type": "string",
            "enum": ["qcra", "percent"],
            "description": "How the capital cost's contingency was set: qcra, by a quantitative cost risk analysis, or percent, as a percent uplift. Needed at 0-10% design.",
        },
        "contingency_percent": {
            "type": "number",
            "description": "The percent contingency already in the capital cost, when contingency is percent.",
        },
        "capital_costs": spans(
            "Capital costs by year, in $M real of the base year, before optimism bias, over business as usual. Leave out costs already paid."
        ),
        "operating_costs": spans("Operating and maintenance costs by year over business as usual, in $M real of the base year. A saving is negative."),
        "costs_escalated": {
            "type": "boolean",
            "description": "Whether the sources say the capital and operating costs already include escalation, the real "
            "growth in costs beyond inflation. With false, the tool grows them by the manual's 1% a year, to 30 years "
            "from the base year. Leave it out if the sources don't say.",
        },
        "benefits": spans(
            "Benefits by year over business as usual, in $M real of the base year: user and external impacts, as the project's own analysis gives them. "
            "Not time savings given as hours_saved, nor wider economic impacts."
        ),
        "hours_saved": spans(
            "Hours of weighted travel time saved a year, from the project's own model, valued at the manual's value of time. Only with base_year 2021, the value's dollars."
        ),
        "wider_impacts": spans("Wider economic impacts by year, in $M real of the base year, when the sources give them. They give the expanded NPV and BCR."),
    },
}


def tools(session: Any, study: str) -> list[LocalTool]:
    """The metrolinx_bca tool, for a specialist working on this study."""

    async def metrolinx_bca(**arguments: Any) -> dict[str, Any]:
        differ = differing(await call(session, "list_rules"))
        if differ:
            return {
                "computed": False,
                "rulesDiffer": differ,
                "note": "Nothing was computed. Planners have set an appraisal rule to a value other than the manual's, "
                "which this tool uses. A planner must confirm which applies.",
            }
        return appraise(**arguments)

    return [LocalTool("metrolinx_bca", DESCRIPTION, metrolinx_bca, PARAMETERS)]


def differing(rules: Any) -> list[str]:
    """The planners' rules that hold another value than the manual's one this script uses."""
    found = []
    for rule in rules if isinstance(rules, list) else []:
        if not isinstance(rule, dict):
            continue
        key, value = rule.get("key"), rule.get("value")
        if key in RULES and isinstance(value, (int, float)) and not math.isclose(value, RULES[key]):
            found.append(f"{key} is {value:g} {rule.get('unit', '')}".strip() + f"; the manual's is {RULES[key]:g}")
    return found


def appraise(
    base_year: Any = None,
    opening_year: Any = None,
    design_completion: Any = None,
    contingency: Any = None,
    contingency_percent: Any = None,
    capital_costs: Any = None,
    operating_costs: Any = None,
    costs_escalated: Any = None,
    benefits: Any = None,
    hours_saved: Any = None,
    wider_impacts: Any = None,
    **unknown: Any,
) -> dict[str, Any]:
    """The present values, NPV and BCR, or, while any input is missing, what is."""
    if unknown:
        raise ValueError(
            f"Unknown inputs: {', '.join(sorted(unknown))}. The discount rate, evaluation period, value of time, "
            f"optimism bias and cost growth are the manual's, cited, and can't be set here. It takes: {', '.join(PARAMETERS['properties'])}."
        )
    escalated = boolean(costs_escalated, "costs_escalated")
    base = whole(base_year, "base_year")
    opening = whole(opening_year, "opening_year")
    if base is not None and opening is not None and opening < base:
        raise ValueError(f"opening_year, {opening}, is before base_year, {base}: the appraisal begins by the opening.")
    design = number(design_completion, "design_completion")
    if design is not None and not 0 <= design <= 100:
        raise ValueError("design_completion is a percent, from 0 to 100.")
    if contingency is not None and contingency not in ("qcra", "percent"):
        raise ValueError("contingency is qcra or percent.")
    held = number(contingency_percent, "contingency_percent")
    if held is not None and held < 0:
        raise ValueError("contingency_percent can't be negative.")

    missing = []
    if base is None:
        missing.append("base_year: the year the appraisal begins, whose real dollars every amount is in")
    if opening is None:
        missing.append("opening_year: the first year of operation, which starts the 60 years of operation")
    if not capital_costs:
        missing.append("capital_costs: the project's own capital cost by year, from an engineering estimate")
    if not operating_costs:
        missing.append("operating_costs: the project's own operating and maintenance costs by year")
    if escalated is None:
        missing.append(
            "costs_escalated: whether the sources say the capital and operating costs already include escalation, the "
            "real growth in costs beyond inflation, which the Economic Case should capture (metrolinx-bcm-vol2 p. 93). "
            "If they say the costs leave it out, give false: the tool applies the manual's 1% a year, to 30 years from "
            "the base year (metrolinx-bcm-vol2 p. 179)"
        )
    if not benefits and not hours_saved:
        missing.append("benefits or hours_saved: the project's own benefits by year, from its own demand model run")
    if design is None:
        missing.append("design_completion: the percent of design complete, which sets the optimism bias (Table 5.5)")
    elif design <= OPTIMISM_BIAS[0][0]:
        if contingency is None:
            missing.append(
                "contingency: whether the capital cost's contingency comes from a quantitative cost risk analysis (qcra) "
                "or is a percent uplift (percent), which Table 5.6 treats differently at 0-10% design"
            )
        elif contingency == "percent" and held is None:
            missing.append("contingency_percent: the percent contingency already in the capital cost")
    if hours_saved and base is not None and base != VALUE_OF_TIME_DOLLARS:
        missing.append(
            f"a value of time in {base} dollars: the manual's is $18.79 in {VALUE_OF_TIME_DOLLARS} dollars, and rebasing "
            "it needs a price index the sources don't give. Value hours_saved only with base_year 2021"
        )
    if missing:
        return {
            "computed": False,
            "missing": missing,
            "note": "Nothing was computed. It never fills in an input: find each in the sources, or report it as a "
            "gap and name the data needed. Don't estimate one.",
        }
    assert base is not None and opening is not None and design is not None
    last = opening + OPERATING_YEARS - 1
    given = {
        name: spread(name, runs, base, last)
        for name, runs in (
            ("capital_costs", capital_costs),
            ("operating_costs", operating_costs),
            ("benefits", benefits),
            ("hours_saved", hours_saved),
            ("wider_impacts", wider_impacts),
        )
        if runs
    }
    # Costs whose estimates leave escalation out grow at Table 5.35's rate, to the growth cap.
    streams = given if escalated else {name: escalate(amounts, base) if name in COSTS else amounts for name, amounts in given.items()}

    def pv(name: str) -> float:
        return sum(amount / (1 + DISCOUNT_RATE / 100) ** (year - base) for year, amount in streams.get(name, {}).items())

    uplift, bias = optimism_bias(design, contingency, held)
    capital = pv("capital_costs")
    capital_with_bias = capital * (1 + uplift / 100)
    operating = pv("operating_costs")
    time_savings = pv("hours_saved") * VALUE_OF_TIME / 1e6  # hours to $M
    benefit = pv("benefits") + time_savings
    costs = capital_with_bias + operating
    npv = benefit - costs

    present = {"benefits": pv("benefits")}
    if "hours_saved" in streams:
        present["timeSavings"] = time_savings
    present.update(
        userAndExternalImpacts=benefit,
        capitalCosts=capital_with_bias,
        capitalCostsWithoutOptimismBias=capital,
        operatingCosts=operating,
        costs=costs,
    )
    out: dict[str, Any] = {
        "computed": True,
        "unit": f"$M, real {base} dollars, discounted to {base}",
        "years": {"base": base, "opening": opening, "last": last, "ofOperation": OPERATING_YEARS},
        "presentValues": {key: round(value, 2) for key, value in present.items()},
        "npv": round(npv, 2),
        **ratio(benefit, costs),
        "npvPerCapitalCost": round(npv / capital_with_bias, 2) if capital_with_bias > 0 else None,
        "withoutOptimismBias": {"npv": round(benefit - capital - operating, 2), **ratio(benefit, capital + operating)},
        "optimismBias": bias,
        "costEscalation": cost_escalation(escalated, base),
    }
    if "wider_impacts" in streams:
        wider = pv("wider_impacts")
        out["presentValues"]["widerImpacts"] = round(wider, 2)
        out["expanded"] = {
            "npv": round(npv + wider, 2),
            **ratio(benefit + wider, costs),
            "npvPerCapitalCost": round((npv + wider) / capital_with_bias, 2) if capital_with_bias > 0 else None,
        }
    out["asReported"] = {
        "npv": two_significant(npv),
        "benefits": two_significant(benefit),
        "costs": two_significant(costs),
        **{key: value for key, value in ratio(benefit, costs).items() if key != "note"},
    }
    out["notes"] = notes(streams, base, last, capital_total=sum(given["capital_costs"].values()))
    out["parameters"] = PARAMETERS_CITED
    out["formulas"] = FORMULAS
    return out


# The streams escalation applies to.
COSTS = ("capital_costs", "operating_costs")


def escalate(amounts: dict[int, float], base: int) -> dict[int, float]:
    """A cost stream grown at COST_GROWTH a year from the base year, level after the growth cap."""
    return {year: amount * (1 + COST_GROWTH / 100) ** min(year - base, GROWTH_CAP_YEARS) for year, amount in amounts.items()}


def cost_escalation(escalated: bool, base: int) -> dict[str, Any]:
    """Whether the tool grew the costs, and the rule, cited."""
    if escalated:
        return {"applied": False, "rule": "The sources' costs already include escalation, so they are used as given."}
    return {
        "applied": True,
        "rule": f"The sources' costs leave escalation out, so capital and operating costs grow {COST_GROWTH:g}% a year "
        f"in real terms from {base} to {base + GROWTH_CAP_YEARS}, 30 years from the base year, and stay level after.",
        "citations": PARAMETERS_CITED["costGrowth"]["citations"] + PARAMETERS_CITED["growthCap"]["citations"],
    }


def optimism_bias(design: float, contingency: str | None, held: float | None) -> tuple[float, dict[str, Any]]:
    """The uplift on capital cost for this level of design, in %, by Tables 5.5 and 5.6, and how it was set."""
    published, stage = next((ob, stage) for top, ob, stage in OPTIMISM_BIAS if design <= top)
    out: dict[str, Any] = {"designCompletion": design, "stage": stage, "published": published}
    if design <= OPTIMISM_BIAS[0][0] and contingency == "percent":
        assert held is not None
        # Table 5.6 adjusts the uplift so contingency and uplift together come to the
        # published one. Its printed formula reads inverted: as printed, a contingency
        # under the uplift would lower the cost.
        adjusted = ((1 + published / 100) / (1 + held / 100) - 1) * 100
        printed = ((1 + held / 100) / (1 + published / 100) - 1) * 100
        out.update(
            uplift=round(adjusted, 2),
            rule=f"The capital cost already holds {held:g}% contingency, with no QCRA: the uplift is adjusted so the "
            f"two together come to the published {published:g}%: (1 + {published:g}%) / (1 + {held:g}%) - 1.",
            citations=ADJUSTED,
            toConfirm=f"Table 5.6's printed formula reads inverted: as printed it gives {printed:.2f}%, which would lower "
            "the cost. This reading keeps the total at the published uplift. A planner must confirm it before the result is used.",
        )
        return adjusted, out
    # Past 10% design, Table 5.6 puts the whole uplift on the estimate, whether or not a QCRA set its contingency.
    rows = {"qcra": [QCRA], "percent": [NO_QCRA]}.get(contingency or "", [QCRA, NO_QCRA])
    out.update(
        uplift=published,
        rule=f"At {design:g}% design, the uplift is {published:g}% on the capital cost (Tables 5.5 and 5.6).",
        citations=DESIGN + rows,
    )
    return published, out


def ratio(benefits: float, costs: float) -> dict[str, Any]:
    """The BCR, or the manual's All Loss or All Gain where a plain ratio would be negative."""
    if costs > 0 and benefits >= 0:
        return {"bcr": round(benefits / costs, 2)}
    if costs > 0:
        return {"bcr": None, "allLoss": round(-benefits / costs, 2)}
    if costs < 0 and benefits > 0:
        return {"bcr": None, "allGain": round(benefits / -costs, 2)}
    return {"bcr": None, "note": "With no costs, or with costs and benefits both negative, the manual gives no ratio: report the NPV."}


def notes(streams: dict[str, dict[int, float]], base: int, last: int, capital_total: float) -> list[str]:
    """What to say beside the numbers: the project's scale, and streams that stop early or grow past the cap."""
    found = []
    if capital_total < SMALL_SCALE:
        found.append(
            f"Capital of ${capital_total:,.2f}M is small scale, under $50M: such projects needn't include optimism bias "
            "(metrolinx-bcm-vol2 p. 102), so give the result without it too."
        )
    elif capital_total > LARGE_SCALE:
        found.append(
            f"Capital of ${capital_total:,.2f}M is large scale, over $500M: the manual asks for a range from a Monte Carlo "
            "simulation with the uplift's standard deviation (metrolinx-bcm-vol2 p. 102). This is a point estimate at the mean uplift."
        )
    cap = base + GROWTH_CAP_YEARS
    for name in ("benefits", "hours_saved", "wider_impacts"):
        amounts = streams.get(name)
        if not amounts:
            continue
        years = sorted(year for year, amount in amounts.items() if amount)
        if years and years[-1] < last:
            found.append(f"{name} stop after {years[-1]}, though the appraisal runs to {last}: say so, or give the later years.")
        grows = [y for y in range(cap + 1, last + 1) if amounts.get(y, 0) > amounts.get(y - 1, 0) > 0]
        if grows:
            found.append(
                f"{name} still grow after {cap}, 30 years from the base year, when the manual caps growth "
                f"(metrolinx-bcm-vol2 p. 179): from {grows[0]}. Check the source caps them."
            )
    return found


def spread(name: str, given: Any, first: int, last: int) -> dict[int, float]:
    """A stream's amount in each year, from its runs of years."""
    if not isinstance(given, list):
        raise ValueError(f"{name}: give a list of runs of years, each with from, to and amount.")
    years: dict[int, float] = {}
    for run in given:
        if not isinstance(run, dict):
            raise ValueError(f"{name}: each run of years has from, to and amount.")
        start, end = whole(run.get("from"), f"{name} from"), whole(run.get("to"), f"{name} to")
        amount = number(run.get("amount"), f"{name} amount")
        if start is None or end is None or amount is None:
            raise ValueError(f"{name}: each run of years has from, to and amount.")
        if end < start:
            raise ValueError(f"{name}: a run from {start} to {end} runs backwards.")
        if start < first:
            raise ValueError(
                f"{name}: {start} is before the base year, {first}. Years are calendar years. The appraisal begins in "
                "the base year, and leaves out costs already paid, which are sunk (metrolinx-bcm-vol2 p. 112)."
            )
        if end > last:
            raise ValueError(f"{name}: {end} is after {last}, the 60th year of operation, where the appraisal ends.")
        for year in range(start, end + 1):
            years[year] = years.get(year, 0.0) + amount
    return years


def whole(value: Any, name: str) -> int | None:
    """A whole number such as a year, or None when not given."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value != int(value):
        raise ValueError(f"{name} must be a whole number, such as a year.")
    return int(value)


def number(value: Any, name: str) -> float | None:
    """A finite number, or None when not given."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a number.")
    return float(value)


def boolean(value: Any, name: str) -> bool | None:
    """True or false, or None when not given. The text "false" would read as true, so it's refused."""
    if value is None or isinstance(value, bool):
        return value
    raise ValueError(f"{name} must be true or false, or left out if the sources don't say.")


def two_significant(value: float) -> float:
    """Rounded to two significant digits, halves away from zero, as the manual reports present values and the NPV."""
    if value == 0:
        return 0.0
    places = 1 - math.floor(math.log10(abs(value)))
    return float(Decimal(repr(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))
