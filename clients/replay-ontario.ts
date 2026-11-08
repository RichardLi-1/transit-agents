// The scripted run of the Ontario Line study. A planner asks what the extension
// would cost. The lead splits the study into four questions, one for each part of a
// business case, and a fifth on what people along the line need to see. A sub-agent
// answers each: it reads its pages, records figures or proposes engagement needs,
// and reports back with page numbers. The answer gives the precedent cost, then each
// gap with its next step and who to contact. Summaries and the answer quote the
// values the service recorded, so they always match the figures. Like replay.ts,
// it's a script that needs no model, and spends no tokens.
//
// Usage: node clients/replay-ontario.ts, or npm run replay for every study.
import type { Assumption, Citation, Figure, StudyView } from "@transit-agents/contracts";
import { ApiClient } from "./api.ts";
import { GAP, ONTARIO } from "./seed-ontario.ts";

type Value = (id: string) => number;

type Question = {
  sub: string;
  question: string;
  read: [contextId: string, page: number][];
  figures: string[];
  needs?: string[];
  summary: (value: Value) => string;
};

const IBC = "ontario-line-ibc-2019";
const PDBC = "ontario-line-pdbc-2020";
const MANUAL = "metrolinx-bcm-vol2";
const RIDERSHIP = "ttc-subway-ridership-2024-25";
const LENGTH = "ontario-north.length-km";

// The planner's question, which the run's answer at the hand-over answers.
export const QUESTION = "What would it cost to extend the Ontario Line up Don Mills to Sheppard?";

// The short names the chat gives the sources, as in (IBC p. 76).
const SHORT: Record<string, string> = { [IBC]: "IBC", [PDBC]: "PDBC", [MANUAL]: "BCM", [RIDERSHIP]: "TTC" };

const whole = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 0 });
const tenth = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 1 });
const millions = (n: number) => `$${whole(n)} M`;

// Values by figure id or assumption key, as the service holds them.
const lookup =
  (values: Map<string, number>): Value =>
  (key) => {
    const found = values.get(key);
    if (found === undefined) throw new Error(`No value for ${key}`);
    return found;
  };

// In the order they run: the economic case builds on the financial case's cost.
const QUESTIONS: Question[] = [
  {
    sub: "strategic",
    question: "Strategic case: how many riders, at the Ontario Line's density?",
    read: [
      [PDBC, 43],
      [PDBC, 78],
      [PDBC, 107],
      [RIDERSHIP, 1],
    ],
    figures: [
      "ol-daily-trips",
      "ol-length",
      "ol-stations",
      "ol-run-time",
      "ol-trips-per-km",
      "ext-daily-trips",
      "ext-run-time",
      "ol-station-spacing",
      "ext-station-spacing",
      "don-mills-usage",
      "line4-boardings",
    ],
    summary: (v) =>
      `${whole(v("ol-daily-trips"))} trips a day on ${tenth(v("ol-length"))} km of Ontario Line (PDBC pp. 43, 78): ${whole(v("ol-trips-per-km"))} a km. ` +
      `At that density, ${tenth(v(LENGTH))} km would carry ${whole(v("ext-daily-trips"))} trips a day: a precedent, not a forecast. ` +
      `The Ontario Line's own forecast came from Metrolinx's regional model, GGHMv4 (PDBC p. 107), and the sources have no run for this route. ` +
      `For scale, all of Line 4 had ${whole(v("line4-boardings"))} boardings a weekday in 2024-25, and Don Mills station, where the extension would end, ` +
      `${whole(v("don-mills-usage"))} customers (TTC p. 1).`,
  },
  {
    sub: "financial",
    question: "Financial case: what would it cost, at the Ontario Line's price?",
    read: [
      [IBC, 76],
      [IBC, 77],
    ],
    figures: ["ol-capital-cost", "ol-cost-per-km", "ol-contingency", "ext-capital-cost"],
    summary: (v) =>
      `${millions(v("ol-cost-per-km"))} per km, the Ontario Line's 2019 median: a Class 5 estimate on conceptual alignments, with ${whole(v("ol-contingency"))}% contingency already in (IBC pp. 76-77). ` +
      `For ${tenth(v(LENGTH))} km: ${millions(v("ext-capital-cost"))} before optimism bias, a precedent rather than an estimate.`,
  },
  {
    sub: "economic",
    question: "Economic case: which Metrolinx rules apply at this stage?",
    read: [
      [MANUAL, 102],
      [MANUAL, 103],
      [MANUAL, 179],
      [PDBC, 12],
    ],
    figures: ["ext-capital-cost-ob", "ol-time-saved", "ol-time-value-per-trip", "ol-bcr"],
    summary: (v) =>
      `Optimism bias goes on capital cost in the economic case only (BCM p. 102). With no cost-risk analysis, Table 5.6 adjusts the ` +
      `${whole(v("metrolinx.optimism-bias-ibc"))}% for the ${whole(v("ol-contingency"))}% contingency already in the cost: ${millions(v("ext-capital-cost-ob"))} in 2019 dollars (BCM p. 103). ` +
      `Its printed formula is inverted, so a planner confirms. The Ontario Line's expected benefit-cost ratio was ${v("ol-bcr")} (PDBC p. 12).`,
  },
  {
    sub: "deliverability",
    question: "Deliverability and operations: what helps or limits going north?",
    read: [
      [PDBC, 60],
      [IBC, 14],
      [IBC, 54],
      [IBC, 83],
      [PDBC, 134],
    ],
    figures: [],
    summary: () =>
      "Tail track north of Science Centre may protect for an extension (PDBC p. 60). Relief Line planning looked north to Sheppard (IBC p. 14). " +
      "Very deep stations could cost up to 15% of riders (IBC p. 54). " +
      "North of York Mills Road the route crosses the East Don valley, and the Ontario Line's own Don River crossing needed substantial further work (IBC p. 83). " +
      "Building along Don Mills Road could mean moving gas, hydro, telecom, water and sewer lines (PDBC p. 134). " +
      "No source surveys this route's ground, valley or utilities.",
  },
  {
    sub: "engagement",
    question: "Engagement: what do people along the line need to see?",
    read: [
      [PDBC, 60],
      [PDBC, 64],
      [IBC, 14],
    ],
    figures: [],
    needs: ["don-valley-viaduct", "lawrence-entrance"],
    summary: () =>
      "Thorncliffe Park: the line crosses the Don River and the Don Valley Parkway on a new bridge beside it (PDBC p. 60), and will give it new connections (PDBC p. 64). " +
      "Don Mills and Lawrence: going north, the line would need a station there. Tail track may protect for an extension (PDBC p. 60), toward Sheppard (IBC p. 14). " +
      "Proposed: a render of the viaduct over the parkway, and one of a station entrance at Don Mills and Lawrence.",
  },
];

const PLAN =
  "Four questions, one for each part of the business case, and one on what people along the line need to see. The extension is hypothetical, so every figure is the Ontario Line's own, a TTC count, or a formula over them with Metrolinx's rules and values planners set. Page numbers count the PDF's pages.";

// The answer: the precedent cost and its basis, then each gap on the card with its
// next step, who to contact and its page, as agents/skills/handover sets out. It
// opens with "ready for planners", the words that mark the replay's hand-over.
export function answer(value: Value, findings: { text: string; citation: Citation }[]): string {
  const gaps = findings.filter((finding) => GAP.test(finding.text));
  return [
    `First pass, ready for planners, not a final answer. At the Ontario Line's 2019 median of ${millions(value("ol-cost-per-km"))} a km, ` +
      `a Class 5 estimate with ${whole(value("ol-contingency"))}% contingency (IBC pp. 76-77), the ${tenth(value(LENGTH))} km up Don Mills Road would cost ` +
      `${millions(value("ext-capital-cost"))} in 2019 dollars, or ${millions(value("ext-capital-cost-ob"))} with optimism bias (BCM p. 103).`,
    [
      "Not known yet:",
      ...gaps.map(({ text, citation }) => `- ${text.replace(/\.$/, "")} (${SHORT[citation.contextId] ?? citation.contextId} p. ${citation.page}).`),
    ].join("\n"),
    "Before anyone relies on the cost, a planner confirms the optimism bias adjustment and rebases the dollars (BCM pp. 103, 179).",
  ].join("\n\n");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultGap = () => Number(process.env.REPLAY_GAP_MS ?? 900);

// Everything but the hand-over. The run stays open until handOverOntario.
export async function replayOntario(api = new ApiClient("agent"), gap = defaultGap(), planner = new ApiClient("planner")) {
  const id = ONTARIO.study.id;
  const activity = (body: unknown) => api.post(`/v1/studies/${id}/activity`, body);

  // Planners set the assumptions, so read them as the service holds them.
  const values = new Map((await api.get<Assumption[]>("/v1/assumptions")).map((a) => [a.key, a.value]));
  const value = lookup(values);
  const figures = new Map(ONTARIO.figures.map((f) => [f.id, f]));
  const needs = new Map(ONTARIO.needs.map((n) => [n.id, n]));

  await api.post("/v1/studies", ONTARIO.study);
  // A planner asks in the study's chat, with their own token.
  await planner.post(`/v1/studies/${id}/activity`, { kind: "message", text: QUESTION });
  await pause(gap);
  await activity({ kind: "run.started" });
  await activity({ kind: "message", text: ONTARIO.study.brief });
  await pause(gap);
  await activity({ kind: "message", text: PLAN });
  for (const step of QUESTIONS) await activity({ kind: "subagent.started", id: step.sub, question: step.question });
  await pause(gap);

  for (const step of QUESTIONS) {
    for (const [contextId, page] of step.read) {
      await activity({ kind: "reading", contextId, page });
      await pause(gap);
    }
    for (const figureId of step.figures) {
      const figure = figures.get(figureId);
      if (!figure) throw new Error(`Unknown figure ${figureId}`);
      figures.delete(figureId);
      const recorded = await api.post<Figure>(`/v1/studies/${id}/figures`, figure);
      values.set(figureId, recorded.value);
      await pause(gap / 3);
    }
    for (const needId of step.needs ?? []) {
      const need = needs.get(needId);
      if (!need) throw new Error(`Unknown need ${needId}`);
      needs.delete(needId);
      await api.post(`/v1/studies/${id}/needs`, need);
      await pause(gap / 3);
    }
    await activity({ kind: "subagent.finished", id: step.sub, summary: step.summary(value) });
    await pause(gap);
  }
  if (figures.size) throw new Error(`No question records ${[...figures.keys()].join(", ")}`);
  if (needs.size) throw new Error(`No question proposes ${[...needs.keys()].join(", ")}`);

  for (const finding of ONTARIO.findings) {
    await api.post(`/v1/studies/${id}/findings`, finding);
    await pause(gap / 3);
  }
}

// The lead answers the planner and hands the draft over. replay.ts does this after
// the other studies run, so the display ends on the lead study.
export async function handOverOntario(api = new ApiClient("agent"), gap = defaultGap()) {
  const id = ONTARIO.study.id;
  const activity = (body: unknown) => api.post(`/v1/studies/${id}/activity`, body);
  // The answer quotes the values and findings the service holds, as the summaries do.
  const [study, assumptions] = await Promise.all([api.get<StudyView>(`/v1/studies/${id}`), api.get<Assumption[]>("/v1/assumptions")]);
  const values = new Map([...assumptions.map((a) => [a.key, a.value] as const), ...study.figures.map((f) => [f.id, f.value] as const)]);
  await activity({ kind: "message", text: answer(lookup(values), study.findings) });
  await activity({ kind: "run.finished" });
  await pause(gap);
}

if (import.meta.main) {
  await replayOntario();
  await handOverOntario();
}
