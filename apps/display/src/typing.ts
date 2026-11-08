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
