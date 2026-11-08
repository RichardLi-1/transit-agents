// Plays a scripted run of each study through the public API, with an agent's
// token: a demo that needs no model. The log records the actor as agent:replay,
// and the display marks its work as a replay. The Gemini agents in agents/ do the
// real work. It reports no tokens or cost, because it spends none.
// Its consultation findings are proposals: a planner rates them in decide.ts.
// Its engagement needs are proposals too: nothing is made until a planner asks.
import { ApiClient } from "./api.ts";
import { handOverOntario, replayOntario } from "./replay-ontario.ts";
import { LAWRENCE, ROSEDALE, type StudySeed } from "./seed-data.ts";

const api = new ApiClient("agent");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gap = Number(process.env.REPLAY_GAP_MS ?? 900);

type Step = { sub: string; question: string; read: string; figures?: string[]; needs?: string[]; summary: string };

// Takes each item a step names from what is left, so each is sent once.
function take<T extends { id: string }>(remaining: Map<string, T>, ids: string[] = []): T[] {
  return ids.map((id) => {
    const item = remaining.get(id);
    if (!item) throw new Error(`Unknown or repeated ${id}`);
    remaining.delete(id);
    return item;
  });
}

async function run(seed: StudySeed, script: Step[]) {
  const id = seed.study.id;
  const activity = (body: unknown) => api.post(`/v1/studies/${id}/activity`, body);

  await api.post("/v1/studies", seed.study);
  await activity({ kind: "run.started" });
  await activity({ kind: "message", text: seed.study.brief });
  await pause(gap);

  const figures = new Map(seed.figures.map((f) => [f.id, f]));
  const needs = new Map(seed.needs.map((n) => [n.id, n]));
  for (const step of script) {
    await activity({ kind: "subagent.started", id: step.sub, question: step.question });
    await activity({ kind: "reading", contextId: step.read });
    await pause(gap);
    for (const figure of take(figures, step.figures)) {
      await api.post(`/v1/studies/${id}/figures`, figure);
      await pause(gap / 3);
    }
    for (const need of take(needs, step.needs)) {
      await api.post(`/v1/studies/${id}/needs`, need);
      await pause(gap / 3);
    }
    await activity({ kind: "subagent.finished", id: step.sub, summary: step.summary });
  }
  for (const figure of figures.values()) await api.post(`/v1/studies/${id}/figures`, figure);
  for (const need of needs.values()) await api.post(`/v1/studies/${id}/needs`, need);
  for (const check of seed.checks) {
    await api.post(`/v1/studies/${id}/checks`, check);
    await pause(gap / 3);
  }
  for (const finding of seed.findings) await api.post(`/v1/studies/${id}/findings`, finding);
  await activity({ kind: "run.finished" });
  await pause(gap);
}

await replayOntario(api, gap);

await run(LAWRENCE, [
  {
    sub: "riders",
    question: "How many riders?",
    read: "ttc-anp-2026",
    figures: ["riders-forecast", "hours-forecast", "per-100-forecast"],
    summary: "1,680 riders a week for 25 service hours.",
  },
  {
    sub: "time",
    question: "Do customers save time?",
    read: "ttc-anp-2026",
    figures: ["time-saved", "net-cost"],
    summary: "50,470 weighted minutes saved each week.",
  },
  {
    sub: "rules",
    question: "Which rules apply?",
    read: "ttc-standards-2024",
    figures: [],
    summary: "Local bus minimum of 20 boardings an hour, and 11 riders per $100.",
  },
  {
    sub: "engagement",
    question: "Who needs to hear about it?",
    read: "ttc-anp-2026",
    needs: ["sunnybrook-poster"],
    summary: "Riders at Sunnybrook Hospital, about the direct service.",
  },
]);

await run(ROSEDALE, [
  {
    sub: "effects",
    question: "What changes for riders?",
    read: "ttc-anp-2026",
    figures: ["time-saved", "riders", "net-cost"],
    summary: "560 more riders a week at no service-hour cost.",
  },
  {
    sub: "feedback",
    question: "What did people say?",
    read: "ttc-anp-2026",
    figures: [],
    summary: "Events were largely negative. The survey was more positive.",
  },
  {
    sub: "engagement",
    question: "Who needs to hear about it?",
    read: "ttc-anp-2026",
    needs: ["rosedale-explainer"],
    summary: "Rosedale residents, where views were split.",
  },
]);

await handOverOntario(api, gap);
