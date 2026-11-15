// The private test split: cases kept outside the repo, in EVAL_PRIVATE_DIR/cases.jsonl,
// never committed. The committed test split is public, and may be in models' training
// data; a private one isn't, as long as nothing of it leaks. Each private case is a test
// case with a canary: a string unique to the private set, which marks its files, so a
// copy of them can be found.
//
// checkPrivate scans what agents and the evolver read for anything of a private case:
// the skills, the skill candidates and the eval runs. Run it with npm run eval:check-private.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { EvalCase } from "./score.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const PRIVATE = "EVAL_PRIVATE_DIR";
// A canary at least this long is unique enough to search for.
export const CANARY_CHARS = 20;

export type PrivateCase = EvalCase & { canary: string };

// What agents and the evolver read, where a private case must never be.
export const SCANNED = ["agents/skills", "agents/skill-candidates", "evals/runs"];

// The private split's folder, or undefined when EVAL_PRIVATE_DIR isn't set. It must be
// outside the repo, so nothing in it is committed.
export function privateDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const text = env[PRIVATE]?.trim();
  if (!text) return undefined;
  const folder = resolve(text);
  if (folder === ROOT || folder.startsWith(`${ROOT}/`)) throw new Error(`${PRIVATE} must be outside the repo, not ${folder}: nothing private may be committed.`);
  if (!existsSync(join(folder, "cases.jsonl"))) throw new Error(`${PRIVATE} is ${folder}, which has no cases.jsonl.`);
  return folder;
}

// The private cases, checked: each a test case with a canary, its id not a committed case's.
export function readPrivateCases(folder: string, publicIds: Iterable<string> = []): PrivateCase[] {
  const taken = new Set(publicIds);
  const cases: PrivateCase[] = [];
  readFileSync(join(folder, "cases.jsonl"), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${PRIVATE}/cases.jsonl, line ${i + 1}`;
      const c = JSON.parse(line) as PrivateCase;
      if (typeof c.canary !== "string" || c.canary.trim().length < CANARY_CHARS) {
        throw new Error(`${where}: give each private case a canary of ${CANARY_CHARS} characters or more.`);
      }
      if (c.split !== "test") throw new Error(`${where}: a private case is a test case, with split "test".`);
      if (taken.has(c.id)) throw new Error(`${where}: ${c.id} is already a case's id.`);
      taken.add(c.id);
      cases.push(c);
    });
  return cases;
}

// Non-ASCII written as \uXXXX, as Python's json.dumps writes it by default.
const asciiOnly = (text: string) => text.replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const squeezed = (text: string) => text.replace(/\s+/g, "");
const words = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// What of a private case would show it leaked: its canary; its gold answer as the case
// gives it, the expect object as JSON, however it is spaced and in either escaping; and
// its required wording, each term of three words or more. A bare number can't be
// searched for, so a value is found only in its case's own JSON.
export function fingerprints(c: PrivateCase): { canary: string; gold: string[]; wording: string[] } {
  const json = squeezed(JSON.stringify(c.expect));
  const wording = (c.expect.mentions ?? []).filter((term) => term.trim().split(/\s+/).length >= 3).map(words);
  return { canary: c.canary, gold: [...new Set([json, asciiOnly(json)])], wording };
}

export type Leak = { file: string; case: string; what: "canary" | "gold answer" | "required wording" | "answer to a private case" };

function* files(folder: string): Generator<string> {
  if (!existsSync(folder)) return;
  for (const name of readdirSync(folder)) {
    if (name === "__pycache__" || name.endsWith(".pyc") || name === ".DS_Store") continue;
    const path = join(folder, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* files(path);
    else if (stat.isFile() && stat.size <= 64 * 1024 * 1024) yield path;
  }
}

// A run file's case ids, and a case log's: an answer to a private case in a folder the
// evolver reads.
function answered(path: string, text: string): string[] {
  const log = /([^/]+)\.log\.jsonl$/.exec(path);
  if (log?.[1]) return [log[1]];
  if (!path.endsWith(".jsonl")) return [];
  return text.split("\n").flatMap((line) => {
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    } catch {
      return [];
    }
  });
}

// Every leak of a private case into the folders agents and the evolver read.
export function checkPrivate(cases: PrivateCase[], roots: string[] = SCANNED.map((path) => join(ROOT, path)), base = ROOT): Leak[] {
  const leaks: Leak[] = [];
  const marks = cases.map((c) => ({ id: c.id, ...fingerprints(c) }));
  const ids = new Set(cases.map((c) => c.id));
  for (const root of roots) {
    for (const path of files(root)) {
      const text = readFileSync(path, "utf8");
      const flat = squeezed(text);
      const plain = words(text);
      const file = relative(base, path);
      for (const mark of marks) {
        if (text.includes(mark.canary)) leaks.push({ file, case: mark.id, what: "canary" });
        if (mark.gold.some((gold) => flat.includes(gold))) leaks.push({ file, case: mark.id, what: "gold answer" });
        if (mark.wording.some((term) => plain.includes(term))) leaks.push({ file, case: mark.id, what: "required wording" });
      }
      for (const id of new Set(answered(path, text))) if (ids.has(id)) leaks.push({ file, case: id, what: "answer to a private case" });
    }
  }
  return leaks;
}
