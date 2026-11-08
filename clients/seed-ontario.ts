// The Ontario Line study: a hypothetical extension north from Eglinton up Don Mills
// Road to Sheppard. Nothing about the extension is published, so its figures come
// from the Ontario Line's own business cases and TTC counts, or from formulas over
// them and values a planner sets.
import type { NewAssumption, NewFigure } from "@transit-agents/contracts";
import { ONTARIO_NEEDS } from "./ontario-needs.ts";
import type { Source, StudySeed } from "./seed-data.ts";

const IBC = "ontario-line-ibc-2019";
const PDBC = "ontario-line-pdbc-2020";
const MANUAL = "metrolinx-bcm-vol2";
const RIDERSHIP = "ttc-subway-ridership-2024-25";

export const ONTARIO_SOURCES: Source[] = [
  {
    id: IBC,
    title: "Ontario Line Initial Business Case",
    folder: "Ontario Line",
    source: "Metrolinx",
    url: "https://assets.metrolinx.com/image/upload/v1661253822/Documents/Metrolinx/click-here-to-view-the-ontario-line-initial-business-case.pdf",
    pagesFile: `${IBC}.pages.json`,
  },
  {
    id: PDBC,
    title: "Ontario Line Preliminary Design Business Case",
    folder: "Ontario Line",
    source: "Metrolinx",
    url: "https://assets.metrolinx.com/image/upload/v1663237577/Documents/Metrolinx/2020-12-08-Ontario-Line-PDBC-Public-Final.pdf",
    pagesFile: `${PDBC}.pages.json`,
  },
  {
    id: MANUAL,
    title: "Business Case Manual Volume 2: Guidance",
    folder: "Metrolinx",
    source: "Metrolinx",
    url: "https://assets.metrolinx.com/image/upload/v1663237565/Documents/Metrolinx/Metrolinx-Business-Case-Guidance-Volume-2.pdf",
    pagesFile: `${MANUAL}.pages.json`,
  },
  {
    id: RIDERSHIP,
    title: "Subway Ridership, 2024-2025",
    folder: "Ridership",
    source: "TTC",
    url: "https://cdn.ttc.ca/-/media/Project/TTC/DevProto/Documents/Home/Transparency-and-accountability/Subway-Ridership-20242025.pdf",
    pagesFile: `${RIDERSHIP}.pages.json`,
  },
];

const cite = (contextId: string, page: number, quote: string) => ({ contextId, page, quote });

// Metrolinx's appraisal rules, from its Business Case Manual. Like the TTC's
// standards, planners set them, and every business case uses them.
export const METROLINX_RULES: (NewAssumption & { key: string })[] = [
  {
    key: "metrolinx.optimism-bias-ibc",
    label: "Capital cost optimism bias, Initial Business Case",
    value: 64,
    unit: "%",
    reason: "Published uplift at 0-10% design, for the economic case only",
    citation: cite(MANUAL, 103, "OB 64%"),
  },
  {
    key: "metrolinx.discount-rate",
    label: "Social discount rate",
    value: 3.5,
    unit: "%",
    reason: "Published standard",
    citation: cite(MANUAL, 179, "Discount Rate 3.5%"),
  },
  {
    key: "metrolinx.value-of-time",
    label: "Value of time",
    value: 18.79,
    unit: "$/hour (2021$)",
    reason:
      "Published standard, in 2021 dollars with no real growth. Table 5.35 prints no unit. Read as per hour, as the Ontario Line PDBC states its own value (p. 107: $18.42/hour).",
    citation: cite(MANUAL, 179, "Value of Time $18.79 (2021 $)"),
  },
  {
    key: "metrolinx.evaluation-period",
    label: "Evaluation period",
    value: 60,
    unit: "years",
    reason: "Top of the published range, as both Ontario Line business cases used",
    citation: cite(MANUAL, 179, "Evaluation Period 5 to 60 years (depending on project lifecycle/impacts)"),
  },
];

const LENGTH = "ontario-north.length-km";
const STATIONS = "ontario-north.new-stations";
const DEMAND = "ontario-north.demand-factor";

type Input = { figure: string } | { assumption: string };
const figure = (id: string): Input => ({ figure: id });
const assumption = (key: string): Input => ({ assumption: key });

const cited = (id: string, label: string, unit: string, value: number, contextId: string, page: number, quote: string): NewFigure => ({
  id,
  label,
  unit,
  value,
  basis: { kind: "cited", citation: cite(contextId, page, quote) },
});

const derived = (id: string, label: string, unit: string, formula: string, inputs: Record<string, Input>): NewFigure => ({
  id,
  label,
  unit,
  basis: { kind: "derived", formula, inputs },
});

// A gap as a finding's text: what's missing, then the next step, then who to
// contact, as agents/skills/handover sets out.
export const GAP = /^(.+?\.) Next: (.+?)\. Contact: (.+)\.$/;

// A feasibility study, so it has no tests and no decision: it waits for planners.
export const ONTARIO: StudySeed = {
  study: {
    id: "ontario-line-don-mills",
    title: "Ontario Line: Don Mills extension",
    brief:
      "The feasibility study for extending the Ontario Line north from Eglinton up Don Mills, toward Sheppard. Draft: an Initial Business Case in the four-part structure, every figure linked to its source.",
    line: "ontario-line-don-mills",
  },
  assumptions: [
    {
      key: LENGTH,
      label: "Extension length",
      value: 6,
      unit: "km",
      reason: "Measured on OpenStreetMap along Don Mills Road, from Don Valley station (Science Centre in the business cases) to Sheppard Avenue East: 6.02 km. A route, not a design.",
    },
    {
      key: STATIONS,
      label: "Extension stations",
      value: 3,
      unit: "stations",
      reason: "Lawrence, York Mills, and Don Mills on Line 4, where the main cross streets meet Don Mills Road. Illustrative sites.",
    },
    {
      key: DEMAND,
      label: "Riders against Ontario Line density",
      value: 1,
      unit: "share",
      reason: "Ontario Line density, unadjusted. Lower it for a suburban corridor until a model run gives a forecast.",
    },
  ],
  figures: [
    // Financial case: the Ontario Line's own cost is the precedent.
    cited("ol-capital-cost", "Ontario Line capital cost, median estimate, 2019$", "$M", 9504, IBC, 77, "Total Capital Costs $6,241 M $7,489 M $9,504 M"),
    cited("ol-cost-per-km", "Ontario Line capital cost per km, median estimate, 2019$", "$M/km", 613, IBC, 77, "Cost per km $832 M to $999 M $613 M"),
    cited("ol-contingency", "Contingency in the Ontario Line cost estimates", "%", 30, IBC, 76, "All cost estimates reflect 30% contingency to cover unknown risk events"),
    derived("ext-capital-cost", "Extension capital cost before optimism bias, 2019$", "$M", "cost_per_km * length", {
      cost_per_km: figure("ol-cost-per-km"),
      length: assumption(LENGTH),
    }),
    // Strategic case: riders at the precedent's density, beside today's counts.
    cited("ol-length", "Ontario Line length in revenue service", "km", 15.6, PDBC, 43, "15.6 km of revenue service"),
    cited("ol-stations", "Ontario Line stations", "stations", 15, PDBC, 43, "15 new stations"),
    cited("ol-run-time", "Ontario Line end-to-end run time, upper end", "minutes", 30, PDBC, 43, "26 to 30-minute end-to-end run-time"),
    cited("ol-daily-trips", "Ontario Line trips per day, 2041 forecast, refined concept", "trips/day", 374000, PDBC, 78, "374,000 daily trips"),
    cited("don-mills-usage", "Don Mills Station customers, typical weekday 2024-25", "customers/weekday", 26901, RIDERSHIP, 1, "Don Mills 26,901"),
    cited("line4-boardings", "Line 4 Sheppard boardings, typical weekday 2024-25", "boardings/weekday", 37300, RIDERSHIP, 1, "LINE 4 SHEPPARD 37,300"),
    derived("ol-trips-per-km", "Ontario Line trips per day per km", "trips/day/km", "trips / length", {
      trips: figure("ol-daily-trips"),
      length: figure("ol-length"),
    }),
    derived("ext-daily-trips", "Extension trips per day at Ontario Line density, a precedent, not a forecast", "trips/day", "trips_per_km * length * demand", {
      trips_per_km: figure("ol-trips-per-km"),
      length: assumption(LENGTH),
      demand: assumption(DEMAND),
    }),
    derived("ext-run-time", "Extension run time at Ontario Line speed", "minutes", "length * run_time / ol_length", {
      length: assumption(LENGTH),
      run_time: figure("ol-run-time"),
      ol_length: figure("ol-length"),
    }),
    // Spacing counts the gaps between stations. The extension starts at Don
    // Valley, which exists, so each new station adds one gap.
    derived("ol-station-spacing", "Ontario Line average distance between stations", "km", "length / (stations - 1)", {
      length: figure("ol-length"),
      stations: figure("ol-stations"),
    }),
    derived("ext-station-spacing", "Extension average distance between stations, Don Valley to Sheppard", "km", "length / new_stations", {
      length: assumption(LENGTH),
      new_stations: assumption(STATIONS),
    }),
    // Economic case: Metrolinx's rules applied to the precedent. Optimism bias
    // goes on capital cost in the economic case only. The estimate already holds
    // a 30% contingency and had no cost-risk analysis (QCRA), so Table 5.6 adjusts
    // the 64% to account for it: the total uplift matches the published 64%. The
    // table's printed adjustment formula is inverted, so a planner confirms.
    derived(
      "ext-capital-cost-ob",
      "Extension capital cost with optimism bias (BCM Table 5.6, no QCRA), 2019$",
      "$M",
      "cost_per_km * length * (1 + ob / 100) / (1 + contingency / 100)",
      {
        cost_per_km: figure("ol-cost-per-km"),
        length: assumption(LENGTH),
        ob: assumption("metrolinx.optimism-bias-ibc"),
        contingency: figure("ol-contingency"),
      },
    ),
    // A change in travel time, as the TTC's tests count it: a saving is negative.
    cited("ol-time-saved", "Ontario Line average change in travel time per trip, forecast", "minutes/trip", -7, PDBC, 12, "the Ontario Line will save travellers seven minutes per trip on average"),
    derived("ol-time-value-per-trip", "Value of the Ontario Line's average saving per trip, 2021$", "$/trip", "-change / 60 * vot", {
      change: figure("ol-time-saved"),
      vot: assumption("metrolinx.value-of-time"),
    }),
    cited("ol-bcr", "Ontario Line benefit-cost ratio, expected", "ratio", 1.05, PDBC, 12, "expected BCR of 1.05"),
  ],
  checks: [],
  // What a first pass can't know. Each gap says what's missing, then the next step,
  // then who to contact, an organisation or team, and cites the page that shows it.
  // The last two are for a planner to confirm. The deliverability summary in the
  // chat also gives the Relief Line's northward planning (IBC p. 14) and deep
  // stations' cost in riders (IBC p. 54).
  findings: [
    {
      id: "cost-precedent",
      label: "Cost",
      text: "Cost is a precedent, not an estimate. Next: a survey and an engineering estimate. Contact: Metrolinx engineering.",
      tone: "neutral",
      citation: cite(IBC, 76, "Cost estimates were prepared on a top-down, factor-based parametric approach and should be considered Class 5 estimates"),
    },
    {
      id: "riders-model",
      label: "Riders",
      text: "Riders are a precedent, not a forecast. Next: a regional model run. Contact: Metrolinx planning.",
      tone: "neutral",
      citation: cite(PDBC, 107, "The GGHMv4 considers changes in land use patterns and the transportation network to estimate peak ridership with a forecast horizon of 2041"),
    },
    // On OpenStreetMap, the route crosses the East Don north of York Mills Road. No
    // source covers the extension, so the page is the Ontario Line's own crossing.
    {
      id: "east-don-crossing",
      label: "East Don crossing",
      text: "Crossing the East Don is unstudied. Next: a geotechnical investigation and a valley works permit. Contact: Toronto and Region Conservation Authority.",
      tone: "neutral",
      citation: cite(
        IBC,
        83,
        "The northern crossing of the Don River at Overlea Boulevard requires substantial further work in order to ensure that a new structure minimizes impacts on the natural environment and fits into the neighbourhood character",
      ),
    },
    {
      id: "don-mills-road",
      label: "Don Mills Road",
      text: "What's under Don Mills Road is unsurveyed. Next: utility and road surveys. Contact: City of Toronto Engineering & Construction Services.",
      tone: "neutral",
      citation: cite(
        PDBC,
        134,
        "third party utilities (for example: gas, hydro and telecommunications) and city infrastructure (for example: water, sanitary sewer and stormwater) may need to be relocated",
      ),
    },
    {
      id: "tail-track",
      label: "Future extension",
      text: "Tail track may protect for going north. Next: request its current design. Contact: Metrolinx engineering.",
      tone: "positive",
      citation: cite(PDBC, 60, "Tail track may be provided for reversing and storing trains north of Science Centre station, aligned to protect for a possible northward future extension"),
    },
    {
      id: "optimism-bias",
      label: "Optimism bias",
      text: "A planner confirms how the 64% optimism bias is adjusted for contingency.",
      tone: "neutral",
      citation: cite(MANUAL, 103, "to adjust OB uplift and Stdev, given a contingency uplift is applied on capital costs, the following approach should be used"),
    },
    {
      id: "dollar-basis",
      label: "Dollars",
      text: "Costs are in 2019 dollars and the value of time in 2021: both need rebasing.",
      tone: "neutral",
      citation: cite(MANUAL, 179, "Dollar Value Real, year of evaluation"),
    },
  ],
  // Renders of the line's viaduct over the Don Valley Parkway, and of a station
  // entrance on the extension, each pinned to a point on the line.
  needs: ONTARIO_NEEDS,
};
