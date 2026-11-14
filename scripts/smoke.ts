// Asks the live site one question, as a visitor would, and waits for an agent's answer:
// the one check that the deployed agents, their model and their key all work together.
// Unit tests can't see that, as they never call a real model.
//
//   npm run smoke                                   the public demo
//   npm run smoke -- http://127.0.0.1:4100          another
//
// Exits 0 with the answer's first line, or 1 with why not. With DISCORD_WEBHOOK_URL set,
// as in the scheduled GitHub check, a failure is posted there too. A run costs a few US
// cents of Gemini, from visitors' daily budget.
import { fileURLToPath } from "node:url";
import { NO_ANSWER } from "@transit-agents/contracts";

export const QUESTION = "What is a Class 5 estimate?";
export const STUDY = "ontario-line-don-mills";
const WAIT_MS = 5 * 60_000;

export type Entry = { seq: number; actor?: string; studyId?: string; data?: { kind?: string; text?: string } };
export type Outcome = { answered: true; text: string } | { answered: false; why: string } | null;

// How the run went, from the log's entries after the question: an agent's message,
// unless it's one of the words a run ends with when it has no answer; or null, still
// working. Only an agent's entries count: the question itself is the visitor's.
export function outcome(entries: Entry[], studyId: string = STUDY): Outcome {
  for (const entry of entries) {
    if (entry.studyId !== studyId || !entry.actor?.startsWith("agent:")) continue;
    const { kind, text } = entry.data ?? {};
    if (kind === "message" && text) return NO_ANSWER.test(text) ? { answered: false, why: `The agent answered: ${text}` } : { answered: true, text };
    if (kind === "run.finished") return { answered: false, why: "The run finished without a message" };
  }
  return null;
}

export async function smoke(base: string, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Outcome> {
  const pass = await fetch(`${base}/v1/guests`, { method: "POST" });
  if (!pass.ok) return { answered: false, why: `No guest pass: ${pass.status}` };
  const auth = { authorization: `Bearer ${((await pass.json()) as { token: string }).token}` };
  const head = ((await (await fetch(`${base}/v1/log/head`, { headers: auth })).json()) as { seq: number }).seq;
  const asked = await fetch(`${base}/v1/studies/${STUDY}/activity`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ kind: "message", text: QUESTION }),
  });
  if (!asked.ok) return { answered: false, why: `The question wasn't taken: ${asked.status} ${await asked.text()}` };
  const seen: Entry[] = [];
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await wait(5_000);
    const after = seen.at(-1)?.seq ?? head;
    const response = await fetch(`${base}/v1/log?after=${after}`, { headers: auth });
    if (response.ok) seen.push(...((await response.json()) as Entry[]));
    const result = outcome(seen);
    if (result) return result;
  }
  const working = seen.some((entry) => entry.actor?.startsWith("agent:"));
  return { answered: false, why: working ? "The agents started but gave no answer in 5 minutes" : "No agent picked the question up in 5 minutes" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = (process.argv[2] ?? "https://transit-agents.fly.dev").replace(/\/$/, "");
  const started = Date.now();
  const result = await smoke(base).catch((error: unknown) => ({ answered: false as const, why: `The site can't be reached: ${error instanceof Error ? error.message : error}` }));
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result?.answered) {
    console.log(`Answered in ${seconds}s: ${result.text.split("\n")[0]?.slice(0, 160)}`);
  } else {
    const why = result?.why ?? "No answer";
    console.error(`Not answered (${seconds}s): ${why}`);
    if (process.env.DISCORD_WEBHOOK_URL) {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `🚨 [transit-agents] The live check got no answer from ${base}: ${why}`, allowed_mentions: { parse: [] } }),
      }).catch(() => undefined);
    }
    process.exitCode = 1;
  }
}
