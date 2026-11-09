// Each study's latest agent run, as the agents panel shows it: the lead, each
// specialist it asked, what each is doing now, and what the run has spent. It
// comes from the log alone, as the rest of the display does.
import type { Activity, Context, LogEntry } from "@transit-agents/contracts";

// The latest thing an agent did: a page it read, or a figure recorded.
export type Doing = { kind: "reading"; contextId: string; page?: number } | { kind: "recorded"; label: string };

export type Specialist = {
  id: string;
  question: string;
  skill?: string;
  startedAt: string;
  finishedAt?: string;
  // false for one that stopped before answering.
  ok?: boolean;
  doing?: Doing;
  // Its own model calls' tokens, from usage that names it.
  tokens: number;
};

export type Run = {
  seq: number;
  studyId: string;
  // Started, or still going, since the display opened. An older run that finished
  // never shows.
  live: boolean;
  startedAt: string;
  finishedAt?: string;
  // The last entry in it, so one that went quiet can show as stale.
  lastAt: string;
  // What the lead did last, or a figure no one specialist can be named for.
  doing?: Doing;
  specialists: Specialist[];
  tokens: number;
  costUsd: number;
  calls: number;
  unpricedCalls: number;
};

export type Runs = Record<string, Run>;

// A run with no entry for this long has likely died: its agent went away without
// saying it finished.
export const STALE_MS = 10 * 60_000;

const field = (data: unknown, key: string) => {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
};

const begin = (entry: LogEntry, studyId: string, live: boolean): Run => ({
  seq: entry.seq,
  studyId,
  live,
  startedAt: entry.at,
  lastAt: entry.at,
  specialists: [],
  tokens: 0,
  costUsd: 0,
  calls: 0,
  unpricedCalls: 0,
});

const working = (run: Run) => run.specialists.filter((s) => !s.finishedAt);

// What one entry adds to the runs. `live` is false for entries the log held when
// the display opened.
export function track(runs: Runs, entry: LogEntry, live: boolean): Runs {
  const studyId = entry.studyId;
  if (!studyId) return runs;
  const current = runs[studyId];

  if (entry.type === "figure.recorded") {
    if (!current || current.finishedAt) return runs;
    const label = field(entry.data, "label");
    if (!label) return runs;
    const doing: Doing = { kind: "recorded", label };
    // Figures don't say who recorded them, so one goes on a specialist's row only
    // when it is the one at work.
    const busy = working(current);
    const run = { ...current, lastAt: entry.at };
    return {
      ...runs,
      [studyId]: busy.length === 1 ? { ...run, specialists: run.specialists.map((s) => (s === busy[0] ? { ...s, doing } : s)) } : { ...run, doing },
    };
  }
  if (entry.type !== "activity") return runs;

  const activity = entry.data as Activity;
  if (activity.kind === "run.started") return { ...runs, [studyId]: begin(entry, studyId, live) };
  if (activity.kind === "message") return runs;
  // Usage can come just after a run finishes, from a model call that was stopped.
  // Anything else counts only in a run still going, but a specialist with no
  // run.started before it, such as from an older agent, starts one.
  const active = current && (!current.finishedAt || activity.kind === "usage") ? current : undefined;
  if (!active && activity.kind !== "subagent.started") return runs;
  const run = { ...(active ?? begin(entry, studyId, live)), lastAt: active?.finishedAt ?? entry.at };
  if (live) run.live = true;
  const mine = (id: string | undefined, change: (s: Specialist) => Specialist): Run => {
    const index = id ? run.specialists.findIndex((s) => s.id === id) : -1;
    if (index < 0) return run;
    return { ...run, specialists: run.specialists.map((s, i) => (i === index ? change(s) : s)) };
  };

  switch (activity.kind) {
    case "run.finished":
      return { ...runs, [studyId]: { ...run, finishedAt: entry.at } };
    case "subagent.started": {
      const specialist: Specialist = { id: activity.id, question: activity.question, startedAt: entry.at, tokens: 0, ...(activity.skill ? { skill: activity.skill } : {}) };
      return { ...runs, [studyId]: { ...run, specialists: [...run.specialists.filter((s) => s.id !== activity.id), specialist] } };
    }
    case "subagent.finished":
      return { ...runs, [studyId]: mine(activity.id, (s) => ({ ...s, finishedAt: entry.at, ok: activity.ok !== false })) };
    case "reading": {
      const doing: Doing = { kind: "reading", contextId: activity.contextId, ...(activity.page ? { page: activity.page } : {}) };
      const owner = activity.subagentId && run.specialists.some((s) => s.id === activity.subagentId);
      return { ...runs, [studyId]: owner ? mine(activity.subagentId, (s) => ({ ...s, doing })) : { ...run, doing } };
    }
    case "usage": {
      const tokens = activity.inputTokens + activity.outputTokens;
      const counted = {
        ...run,
        tokens: run.tokens + tokens,
        costUsd: run.costUsd + (activity.costUsd ?? 0),
        calls: run.calls + 1,
        unpricedCalls: run.unpricedCalls + (activity.costUsd === undefined ? 1 : 0),
      };
      const owned = activity.subagentId ? { ...counted, specialists: mine(activity.subagentId, (s) => ({ ...s, tokens: s.tokens + tokens })).specialists } : counted;
      return { ...runs, [studyId]: owned };
    }
    case "tool.called":
    case "tool.finished":
      // Only that the run is still at work: the chat shows each step.
      return { ...runs, [studyId]: run };
    default:
      return runs;
  }
}

// A source's name, short enough for one line: its title up to a colon or dash, or its id.
export function shortName(contextId: string, contexts: Context[]): string {
  const title = contexts.find((c) => c.id === contextId)?.title;
  if (!title) return contextId;
  const short = title.split(/:|\s[–—-]\s|\s\(/)[0]?.trim() || title;
  return short.length > 40 ? `${short.slice(0, 39).trimEnd()}…` : short;
}

export function said(doing: Doing | undefined, contexts: Context[]): string | undefined {
  if (!doing) return undefined;
  if (doing.kind === "recorded") return `Recorded ${doing.label}`;
  return `Reading ${shortName(doing.contextId, contexts)}${doing.page ? ` p. ${doing.page}` : ""}`;
}

export type State = "working" | "done" | "stopped" | "stale";

// A run that went quiet for STALE_MS is stale, and so is any specialist left
// unfinished when its run ended or went quiet.
export function runState(run: Run, now: number): State {
  if (run.finishedAt) return "done";
  return now - Date.parse(run.lastAt) > STALE_MS ? "stale" : "working";
}

export function specialistState(specialist: Specialist, run: Run, now: number): State {
  if (specialist.finishedAt) return specialist.ok === false ? "stopped" : "done";
  return runState(run, now) === "working" ? "working" : "stale";
}

// Elapsed time as "45s", "3m 05s" or "1h 02m".
export function elapsed(from: string, to: string | number): string {
  const ms = Math.max(0, (typeof to === "number" ? to : Date.parse(to)) - Date.parse(from));
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
