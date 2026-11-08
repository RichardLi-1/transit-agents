// The scripted run of the Ontario Line study. The lead splits the study into four
// questions, one for each part of a business case, and a fifth on who needs to hear
// about it. A sub-agent answers each: it reads its pages, records figures or
// proposes engagement needs, and reports back with page numbers. Summaries
// quote the values the service recorded, so they always match the figures. Like
// replay.ts, it's a script that needs no model, and spends no tokens.
//
// Usage: node clients/replay-ontario.ts, or npm run replay for every study.
import type { Assumption, Figure } from "@transit-agents/contracts";
import { ApiClient } from "./api.ts";
import { ONTARIO } from "./seed-ontario.ts";

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
const ANP = "ttc-anp-2026";
const LENGTH = "ontario-north.length-km";

const whole = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 0 });
const tenth = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 1 });
const millions = (n: number) => `$${whole(n)} M`;

// In the order they run: the economic case builds on the financial case's cost.
const QUESTIONS: Question[] = [
  {
    sub: "strategic",
    question: "Strategic case: how many riders, at the Ontario Line's density?",
    read: [
      [PDBC, 43],
      [PDBC, 78],
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
      `${millions(v("ol-cost-per-km"))} per km, the Ontario Line's 2019 median estimate, with ${whole(v("ol-contingency"))}% contingency already in (IBC pp. 76-77). ` +
      `For ${tenth(v(LENGTH))} km: ${millions(v("ext-capital-cost"))} before optimism bias.`,
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
    ],
    figures: [],
    summary: () =>
      "Tail track north of Science Centre may protect for an extension (PDBC p. 60). Relief Line planning looked north to Sheppard (IBC p. 14). " +
      "Very deep stations could cost up to 15% of riders (IBC p. 54).",
  },
  {
    sub: "engagement",
    question: "Engagement: who along the line needs to hear about going north?",
    read: [
      [PDBC, 64],
      [ANP, 108],
      [ANP, 96],
    ],
    figures: [],
    needs: ["thorncliffe-poster", "fairview-video"],
    summary: () =>
      "Thorncliffe Park: the line will give it new connections (PDBC p. 64), and operators say the 100 Flemingdon Park bus is still crowded there (ANP p. 108). " +
      "Fairview Mall: the extension would end at its Don Mills station, where the TTC held a pop-up for the 2026 plan (ANP p. 96). " +
      "Proposed: a poster at Thorncliffe Park and a video at Fairview Mall.",
  },
];

const PLAN =
  "Four questions, one for each part of the business case, and one on who needs to hear about it. The extension is hypothetical, so every figure is the Ontario Line's own, a TTC count, or a formula over them with Metrolinx's rules and values planners set. Page numbers count the PDF's pages.";
const HANDOVER =
  "Draft ready for planners. Cost and riders are precedents, not estimates: the Initial Business Case needs an engineering estimate and a model run.";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultGap = () => Number(process.env.REPLAY_GAP_MS ?? 900);

// Everything but the hand-over. The run stays open until handOverOntario.
export async function replayOntario(api = new ApiClient("agent"), gap = defaultGap()) {
  const id = ONTARIO.study.id;
  const activity = (body: unknown) => api.post(`/v1/studies/${id}/activity`, body);

  // Planners set the assumptions, so read them as the service holds them.
  const values = new Map((await api.get<Assumption[]>("/v1/assumptions")).map((a) => [a.key, a.value]));
  const value: Value = (key) => {
    const found = values.get(key);
    if (found === undefined) throw new Error(`No value for ${key}`);
    return found;
  };
  const figures = new Map(ONTARIO.figures.map((f) => [f.id, f]));
  const needs = new Map(ONTARIO.needs.map((n) => [n.id, n]));

  await api.post("/v1/studies", ONTARIO.study);
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

// The lead hands the draft to planners. replay.ts does this after the other
// studies run, so the display ends on the lead study.
export async function handOverOntario(api = new ApiClient("agent"), gap = defaultGap()) {
  const activity = (body: unknown) => api.post(`/v1/studies/${ONTARIO.study.id}/activity`, body);
  await activity({ kind: "message", text: HANDOVER });
  await activity({ kind: "run.finished" });
  await pause(gap);
}

if (import.meta.main) {
  await replayOntario();
  await handOverOntario();
}
