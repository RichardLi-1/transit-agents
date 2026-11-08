// Whether the agent is at work on a study: a run has started, and nothing since
// has answered it. The last word after the start being the agent's is an answer,
// unless a sub-agent it started is still out.
type Item = { seq: number; from?: "agent" | "planner"; summary?: string };

export function typing(runStart: number | undefined, items: Item[]): boolean {
  if (runStart === undefined) return false;
  const after = items.filter((item) => item.seq > runStart).sort((a, b) => a.seq - b.seq);
  if (after.some((item) => !("from" in item) && item.summary === undefined)) return true;
  return after.at(-1)?.from !== "agent";
}

// Whether the chat is waiting on the agent: a run is at work, or the last word is
// a question asked since the page opened (after `since`), which nothing has
// answered yet. So a message shows the agent at work at once, before its run
// starts, but a question left unanswered long ago doesn't.
export function waiting(runStart: number | undefined, items: Item[], since: number | null): boolean {
  if (typing(runStart, items)) return true;
  const last = items.filter((item) => "from" in item).sort((a, b) => a.seq - b.seq).at(-1);
  return since !== null && last?.from === "planner" && last.seq > since;
}

// Where the log folds what it held when the page opened: at `since`, unless a
// run is still answering a question, which shows with the answer as it comes.
export function foldAt(since: number | null, runStart: number | undefined, items: Item[]): number {
  if (runStart === undefined) return since ?? Infinity;
  const asked = items.filter((item) => item.from === "planner" && item.seq < runStart).sort((a, b) => a.seq - b.seq).at(-1);
  return Math.min(since ?? Infinity, asked ? asked.seq - 1 : runStart - 1);
}
