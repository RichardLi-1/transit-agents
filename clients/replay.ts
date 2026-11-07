// Plays a scripted run of a study through the public API, with an agent's token.
// It stands in for a real agent until one is connected, and the log records the
// actor as agent:replay. It reports no tokens or cost, because it spends none.
// Its consultation findings are proposals: a planner rates them in decide.ts.
import { ApiClient } from "./api.ts";
import { LAWRENCE, ROSEDALE, type StudySeed } from "./seed-data.ts";

const api = new ApiClient("agent");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gap = Number(process.env.REPLAY_GAP_MS ?? 900);

async function run(seed: StudySeed, script: { sub: string; question: string; figures: string[]; read: string; summary: string }[]) {
  const id = seed.study.id;
  const activity = (body: unknown) => api.post(`/v1/studies/${id}/activity`, body);

  await api.post("/v1/studies", seed.study);
  await activity({ kind: "run.started" });
  await activity({ kind: "message", text: seed.study.brief });
  await pause(gap);

  const remaining = new Map(seed.figures.map((f) => [f.id, f]));
  for (const step of script) {
    await activity({ kind: "subagent.started", id: step.sub, question: step.question });
    await activity({ kind: "reading", contextId: step.read });
    await pause(gap);
    for (const figureId of step.figures) {
      const figure = remaining.get(figureId);
      if (!figure) throw new Error(`Unknown figure ${figureId}`);
      remaining.delete(figureId);
      await api.post(`/v1/studies/${id}/figures`, figure);
      await pause(gap / 3);
    }
    await activity({ kind: "subagent.finished", id: step.sub, summary: step.summary });
  }
  for (const figure of remaining.values()) await api.post(`/v1/studies/${id}/figures`, figure);
  for (const check of seed.checks) {
    await api.post(`/v1/studies/${id}/checks`, check);
    await pause(gap / 3);
  }
  for (const finding of seed.findings) await api.post(`/v1/studies/${id}/findings`, finding);
  await activity({ kind: "run.finished" });
  await pause(gap);
}

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
]);
