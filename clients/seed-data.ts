// The two real studies from the TTC 2026 Annual Network Plan. Every figure carries
// the exact words it came from, and the service checks them against the page.
import type { NewAssumption, NewCheck, NewContext, NewDecision, NewFigure, NewFinding, NewNeed, NewStudy } from "@transit-agents/contracts";
import { METROLINX_RULES, ONTARIO, ONTARIO_SOURCES } from "./seed-ontario.ts";

const PLAN = "ttc-anp-2026";
const STANDARDS = "ttc-standards-2024";

export type Source = NewContext & { id: string; pagesFile?: string };

// The lead study's sources come first, so its folders do too.
export const SOURCES: Source[] = [
  ...ONTARIO_SOURCES,
  {
    id: STANDARDS,
    title: "Service Standards",
    folder: "Standards",
    source: "TTC",
    url: "https://cdn.ttc.ca/-/media/Project/TTC/DevProto/Documents/Home/About-the-TTC/Projects-Landing-Page/Transit-Planning/Service-Standards_May-2024.pdf?rev=6c96a85cc0a64147ad424f949dabce64",
    pagesFile: `${STANDARDS}.pages.json`,
  },
  {
    id: PLAN,
    title: "2026 Annual Network Plan",
    folder: "2026 Plan",
    source: "TTC",
    url: "https://www.toronto.ca/legdocs/mmis/2025/ttc/bgrd/backgroundfile-259547.pdf",
    pagesFile: `${PLAN}.pages.json`,
  },
  {
    id: "ttc-schedule",
    title: "Routes and schedules",
    folder: "Schedule",
    source: "City of Toronto Open Data",
    url: "https://open.toronto.ca/dataset/ttc-routes-and-schedules/",
  },
  {
    id: "ttc-vehicles",
    title: "Live vehicle positions",
    folder: "Live",
    source: "City of Toronto Open Data",
    url: "https://open.toronto.ca/dataset/ttc-gtfs-realtime-gtfs-rt/",
  },
];

const cite = (page: number, quote: string, contextId = PLAN) => ({ contextId, page, quote });

export const RULES: (NewAssumption & { key: string })[] = [
  {
    key: "ttc.min-riders-per-100",
    label: "Riders per $100, minimum",
    value: 11,
    unit: "riders",
    reason: "Published standard",
    citation: cite(115, "gain at least 11 new customers per $100 spent"),
  },
  {
    key: "ttc.max-customer-minutes",
    label: "Change in weighted customer travel time, maximum",
    value: 0,
    unit: "minutes/week",
    reason: "A change passes when customers save time overall",
    citation: cite(114, "Comparison of effect on customers is evaluated based on net change of weighted customer travel time"),
  },
  {
    key: "ttc.min-boardings-local-peak",
    label: "Boardings per hour, local bus peak minimum",
    value: 20,
    unit: "boardings/hour",
    reason: "Published standard",
    citation: cite(115, "Peak Periods 95 50 75 20"),
  },
  ...METROLINX_RULES,
];

export type StudySeed = {
  study: NewStudy & { id: string };
  assumptions: (NewAssumption & { key: string })[];
  figures: NewFigure[];
  checks: NewCheck[];
  findings: NewFinding[];
  // What people near the line need to hear about. Each is pinned to a point on the
  // study's line, as apps/display/public/data/studies.json draws it.
  needs: (NewNeed & { id: string })[];
  decision?: NewDecision;
  // What a planner does with the needs once the decision is in. A change that won't
  // go ahead leaves nothing to consult on, but the people who took part need to
  // hear how it ended.
  outcome?: { dismiss: string[]; reason: string; needs: (NewNeed & { id: string })[] };
};

const figure = (id: string, label: string, unit: string, value: number, page: number, quote: string): NewFigure => ({
  id,
  label,
  unit,
  value,
  basis: { kind: "cited", citation: cite(page, quote) },
});

const derived = (id: string, label: string, unit: string, formula: string, inputs: Record<string, { figure: string } | { assumption: string }>): NewFigure => ({
  id,
  label,
  unit,
  basis: { kind: "derived", formula, inputs },
});

const RIDERS = "lawrence.riders-realised";
const HOURS = "lawrence.hours-realised";

export const LAWRENCE: StudySeed = {
  study: {
    id: "lawrence-sunnybrook",
    title: "Lawrence–Sunnybrook",
    brief: "Extend the 52F to Sunnybrook Hospital and the 11B to Lawrence Station, replacing the 124 Sunnybrook.",
    routes: ["52", "11"],
    line: "lawrence-sunnybrook",
    trial: { startedOn: "2026-11-01", reviewOn: "2027-11-01" },
    watch: ["52F", "11B"],
    project: ["riders", "hours", "time-saved"],
  },
  assumptions: [
    { key: RIDERS, label: "Ridership against forecast", value: 1, unit: "share", reason: "Published forecast, unadjusted" },
    { key: HOURS, label: "Service hours against forecast", value: 1, unit: "share", reason: "Published forecast, unadjusted" },
  ],
  figures: [
    figure("riders-forecast", "System riders gained per week, forecast", "riders/week", 1680, 118, "weekly system ridership increase of 1,680 customers"),
    figure("hours-forecast", "Weekly service hours, forecast", "hours/week", 25, 118, "cost 25 weekly service hours"),
    figure("per-100-forecast", "Riders per $100, forecast", "riders", 40, 118, "gain 40 riders per $100 spent"),
    figure("net-cost", "Net cost per passenger", "$", 1.29, 118, "net cost per passenger gained of $1.29"),
    figure("time-saved", "Weekly travel time", "minutes/week", -50470, 117, "net savings in weighted customer travel time of 50,470 weekly minutes"),
    derived("riders", "System riders gained per week", "riders/week", "forecast * realised", { forecast: { figure: "riders-forecast" }, realised: { assumption: RIDERS } }),
    derived("hours", "Weekly service hours", "hours/week", "forecast * realised", { forecast: { figure: "hours-forecast" }, realised: { assumption: HOURS } }),
    derived("boardings-per-hour", "Boardings per hour", "boardings/hour", "riders / hours", { riders: { figure: "riders" }, hours: { figure: "hours" } }),
    derived("riders-per-100", "Riders per $100", "riders", "forecast * riders / hours", {
      forecast: { figure: "per-100-forecast" },
      riders: { assumption: RIDERS },
      hours: { assumption: HOURS },
    }),
  ],
  checks: [
    { id: "customer-time", label: "Customer time", figure: "time-saved", op: "<", threshold: { assumption: "ttc.max-customer-minutes" } },
    {
      id: "productivity",
      label: "Boardings per hour",
      figure: "boardings-per-hour",
      op: ">=",
      threshold: { assumption: "ttc.min-boardings-local-peak" },
      rule: cite(115, "Peak Periods 95 50 75 20"),
    },
    {
      id: "riders-per-dollar",
      label: "Riders per $100",
      figure: "riders-per-100",
      op: ">=",
      threshold: { assumption: "ttc.min-riders-per-100" },
      rule: cite(115, "gain at least 11 new customers per $100 spent"),
    },
  ],
  findings: [
    {
      id: "survey",
      label: "Survey",
      text: "More than half supportive, less than a fifth opposed.",
      tone: "positive",
      citation: cite(118, "more than half of respondents being supportive of the change, and less than a fifth being opposed"),
    },
    {
      id: "reliability-risk",
      label: "Risk",
      text: "Reliability issues on the 52 could spread to Sunnybrook.",
      tone: "neutral",
      citation: cite(117, "service reliability issues on the 52 Lawrence West could be expanded to affect customers travelling to Sunnybrook Hospital"),
    },
  ],
  needs: [
    {
      id: "sunnybrook-poster",
      title: "Engagement poster",
      place: "Sunnybrook Hospital",
      // The loop at the hospital, where the 52F and 11B now stop.
      lon: -79.375262,
      lat: 43.722663,
      kinds: ["image"],
      reason: "Riders who had to change to the 124 can now ride the 52F or 11B straight to the hospital.",
      citations: [
        cite(116, "service on the 52F Lawrence West (Lawrence Station-Royal York) would be extended to Sunnybrook Hospital"),
        cite(116, "a new 11B Bayview branch would provide new continuous service between Davisville Station and Lawrence Station, via Bayview Ave and Sunnybrook Hospital"),
        cite(116, "customers following these travel patterns would be saved a transfer"),
      ],
    },
  ],
  decision: {
    outcome: "adopt",
    reason: "Passes the tests, and feedback was positive.",
    decidedBy: "TTC staff recommendation, 2026 Annual Network Plan",
    citation: cite(118, "The final recommendation is to formally adopt this as part of the TTC network"),
  },
};

export const ROSEDALE: StudySeed = {
  study: {
    id: "sherbourne-castle-frank",
    title: "Sherbourne–Castle Frank",
    brief: "End the 75 Sherbourne at Castle Frank Station and extend the 82 Rosedale to keep coverage.",
    routes: ["75", "82"],
    line: "sherbourne-castle-frank",
  },
  assumptions: [],
  figures: [
    figure("time-saved", "Weekly travel time", "minutes/week", -25270, 127, "net reduction in weighted customer travel time of 25,270 weekly minutes"),
    figure("riders", "System riders gained per week", "riders/week", 560, 128, "weekly system ridership increase of 560 customers"),
    figure("net-cost", "Net cost per passenger", "$", -1.2, 128, "net cost per passenger gained of ($1.20)"),
  ],
  checks: [
    { id: "customer-time", label: "Customer time", figure: "time-saved", op: "<", threshold: { assumption: "ttc.max-customer-minutes" } },
  ],
  findings: [
    {
      id: "events",
      label: "Events",
      text: "Largely negative.",
      tone: "negative",
      citation: cite(127, "Feedback received at the events was largely negative"),
    },
    {
      id: "survey",
      label: "Survey",
      text: "Nearly half supportive, under a quarter opposed.",
      tone: "positive",
      citation: cite(128, "nearly half of respondents being supportive of the change, and less than quarter being opposed"),
    },
  ],
  needs: [
    {
      id: "rosedale-explainer",
      title: "Consultation explainer",
      place: "Rosedale",
      // Sherbourne Station, at the foot of Rosedale, where the 75 ends for now.
      lon: -79.376758,
      lat: 43.672114,
      kinds: ["image", "video"],
      reason: "Feedback at the events was largely negative but the survey was more positive, so residents need a clear picture of what would change.",
      citations: [
        cite(126, "service on the 75 Sherbourne would be removed from the Rosedale neighbourhood north of Bloor St East"),
        cite(127, "Feedback received at the events was largely negative"),
        cite(128, "Survey feedback was significantly more positive"),
      ],
    },
  ],
  decision: {
    outcome: "reject",
    reason: "Public engagement results.",
    decidedBy: "TTC staff recommendation, 2026 Annual Network Plan",
    citation: cite(128, "public engagement results has led to the conclusion that this service change should not move forward"),
  },
  outcome: {
    dismiss: ["rosedale-explainer"],
    reason: "The change won't go ahead.",
    needs: [
      {
        id: "rosedale-outcome",
        title: "Outcome explainer",
        place: "Rosedale",
        lon: -79.376758,
        lat: 43.672114,
        kinds: ["image", "video"],
        reason: "The change won't go ahead, so residents who gave feedback need to hear how it ended.",
        citations: [cite(128, "public engagement results has led to the conclusion that this service change should not move forward")],
      },
    ],
  },
};

export const STUDIES = [ONTARIO, LAWRENCE, ROSEDALE];
