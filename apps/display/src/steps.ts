// The chat's steps, as Waypoint shows an agent at work: the lead's words, each
// specialist it asked with the tools that specialist called under it, and the
// lead's own tool calls, each with how it went. All from the log.

// One tool call: tool.called, then tool.finished once it's back.
export type ToolStep = {
  seq: number;
  id: string;
  studyId: string | null;
  name: string;
  // The specialist that called it. The lead's have none.
  subagentId?: string;
  // What it was called with, and what came back, in a line each.
  summary?: string;
  result?: string;
  // Unset until it's back.
  ok?: boolean;
  ms?: number;
  replay: boolean;
};

export type StepState = "running" | "done" | "failed" | "stopped";

// A call is running until it's back. One never back once its run has ended stopped.
export function stepState(step: Pick<ToolStep, "ok">, runOpen: boolean): StepState {
  if (step.ok === undefined) return runOpen ? "running" : "stopped";
  return step.ok ? "done" : "failed";
}

// The names the chat gives the service's and the agents' tools; any other is its
// own name in words, as "list_rules" reads "List rules".
const NAMES: Record<string, string> = {
  get_study: "Read the study",
  read_page: "Read page",
  search_sources: "Search sources",
  list_sources: "List sources",
  record_figure: "Record figure",
  record_finding: "Record finding",
  record_check: "Record check",
  trace_figure: "Trace figure",
  preview_change: "Preview a change",
  propose_alignment: "Propose alignment",
  create_document: "Make a document",
  add_engagement_need: "Propose engagement need",
  list_skills: "List skills",
  read_skill: "Read skill",
  add_map_layer: "Add map layer",
};

export function stepName(name: string): string {
  const known = NAMES[name];
  if (known) return known;
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}

// How long a call took: "120 ms", "3.4 s", "1 min 05 s".
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

// A specialist and the calls it made, in the order it made them.
export type Grouped<S> = S & { tools: ToolStep[] };

// Items in log order, each specialist holding its own tool calls, and every other
// call standing alone where the log has it. A call whose specialist isn't shown,
// such as one folded away, stands alone too.
export function grouped<I extends { seq: number }, S extends { seq: number; id: string }>(
  items: I[],
  specialists: S[],
  tools: ToolStep[],
): (I | Grouped<S> | ToolStep)[] {
  const mine = new Map<string, ToolStep[]>(specialists.map((s) => [s.id, []]));
  const alone: ToolStep[] = [];
  for (const tool of tools) {
    const list = tool.subagentId ? mine.get(tool.subagentId) : undefined;
    if (list) list.push(tool);
    else alone.push(tool);
  }
  const held = specialists.map((s) => ({ ...s, tools: (mine.get(s.id) ?? []).sort((a, b) => a.seq - b.seq) }));
  return [...items, ...held, ...alone].sort((a, b) => a.seq - b.seq);
}

// A planner's words that ask about the map, which bring it into view.
export const wantsMap = (text: string) => /\b(maps?|layers?|buffer|geojson|on the map|show me where)\b/i.test(text);

// The lead's plan as a numbered list, when its message has one: its lines "1. …",
// "2. …", with the words before and after. A line that isn't numbered carries on
// the step above it, until a blank line ends the list. Null without two steps.
export function planOf(text: string): { lead: string; steps: string[]; after: string } | null {
  const lines = text.split("\n").map((line) => line.trim());
  const first = lines.findIndex((line) => /^1[.)]\s/.test(line));
  if (first < 0) return null;
  const steps: string[] = [];
  let end = lines.length;
  for (let i = first; i < lines.length; i++) {
    const line = lines[i] as string;
    const step = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (step && Number(step[1]) === steps.length + 1) steps.push(step[2] as string);
    else if (line && steps.length) steps[steps.length - 1] += ` ${line}`;
    else {
      end = i;
      break;
    }
  }
  if (steps.length < 2) return null;
  return { lead: lines.slice(0, first).join("\n").trim(), steps, after: lines.slice(end).join("\n").trim() };
}

// Calls standing alone side by side, as the lead's own often are, folded into one
// row, so the chat shows a run of them once. A call alone stays as it is.
export type ToolRun = { run: ToolStep[] };

export function foldRuns<I>(items: (I | ToolStep)[], isTool: (item: I | ToolStep) => item is ToolStep): (I | ToolStep | ToolRun)[] {
  const out: (I | ToolStep | ToolRun)[] = [];
  let run: ToolStep[] = [];
  const close = () => {
    if (run.length === 1) out.push(run[0] as ToolStep);
    else if (run.length > 1) out.push({ run });
    run = [];
  };
  for (const item of items) {
    if (isTool(item)) run.push(item);
    else {
      close();
      out.push(item);
    }
  }
  close();
  return out;
}

// How a run of calls went, taken together: working while any is, failed if any
// failed, stopped if any was left unanswered, and complete once all are back well.
export function togetherState(states: StepState[]): StepState {
  for (const state of ["running", "failed", "stopped"] as const) if (states.includes(state)) return state;
  return "done";
}
