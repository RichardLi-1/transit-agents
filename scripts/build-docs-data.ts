// Writes apps/display/public/docs/skills.json, which the docs' Skills page shows: each
// skill's name and description from its SKILL.md, how many tools its scripts give a
// specialist, and its eval cases by split, with the eval set's totals. npm run build
// runs it before vite.
//
// Tools are counted by loading each tools.py as a specialist would, with the agents'
// Python (AGENTS_PYTHON, or else agents/.venv). Without it, the counts already in
// skills.json are kept. Without the skills at all, as in the Docker build, the file is
// kept as committed; a test checks it is up to date.
//
// Usage: node scripts/build-docs-data.ts
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
export const SKILLS_DIR = join(root, "agents/skills");
export const CASES = join(root, "evals/cases.jsonl");
export const OUT = join(root, "apps/display/public/docs/skills.json");

type Split = "dev" | "test" | "future";
export type Case = { id: string; skill?: string; split: Split; perturbed?: boolean; review?: string };

export type SkillSource = { name: string; description: string; scripts: boolean };

export type DocsSkill = {
  name: string;
  // The SKILL.md's description, word for word.
  description: string;
  // The same, without the sentences that point the lead to another skill.
  summary: string;
  scripts: boolean;
  // The tools its scripts give a specialist; null without scripts, or when not counted.
  tools: number | null;
  cases: Record<Split, number>;
};

export type DocsData = {
  skills: DocsSkill[];
  evals: { cases: number; dev: number; test: number; future: number; review: number; changed: number };
};

// A SKILL.md's frontmatter fields, read as agents/skills.py reads them: `key: value`,
// indented lines continuing the field before, quotes and YAML block markers dropped.
export function frontmatter(text: string, path = "SKILL.md"): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error(`${path}: start with frontmatter between --- lines`);
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) throw new Error(`${path}: close the frontmatter with a --- line`);
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if ((line[0] === " " || line[0] === "\t") && key) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`${path}: write frontmatter as key: value, not ${JSON.stringify(line.trim())}`);
    key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ([">", "|", ">-", "|-"].includes(value)) value = "";
    else if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    fields[key] = value;
  }
  return fields;
}

// A description without its sentences that send the lead elsewhere ("For trips, headways
// and spans use gtfs-analyst; ..."): they choose between skills, and say nothing of this one.
export function summary(description: string): string {
  return description
    .split(/(?<=\.) (?=[A-Z])/)
    .filter((sentence) => !sentence.startsWith("For "))
    .join(" ");
}

export function readSkills(dir = SKILLS_DIR): SkillSource[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => {
      const path = join(dir, entry.name, "SKILL.md");
      const { name = "", description = "" } = frontmatter(readFileSync(path, "utf8"), path);
      if (name !== entry.name) throw new Error(`${path}: name is ${JSON.stringify(name)}, but the folder is ${entry.name}`);
      if (!description) throw new Error(`${path}: give a description in the frontmatter`);
      return { name, description, scripts: existsSync(join(dir, entry.name, "tools.py")) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readCases(path = CASES): Case[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Case);
}

// Everything the Skills and Models pages show. `tools` is each skill's tool count from
// its scripts, or null when they couldn't be loaded: then `previous` counts are kept.
export function docsData(skills: SkillSource[], cases: Case[], tools: Record<string, number> | null, previous?: DocsData): DocsData {
  const before = new Map(previous?.skills.map((skill) => [skill.name, skill.tools]));
  const count = (name: string) => {
    const mine = cases.filter((c) => c.skill === name);
    return { dev: mine.filter((c) => c.split === "dev").length, test: mine.filter((c) => c.split === "test").length, future: mine.filter((c) => c.split === "future").length };
  };
  return {
    skills: skills.map(({ name, description, scripts }) => ({
      name,
      description,
      summary: summary(description),
      scripts,
      tools: scripts ? (tools ? (tools[name] ?? null) : (before.get(name) ?? null)) : null,
      cases: count(name),
    })),
    evals: {
      cases: cases.length,
      dev: cases.filter((c) => c.split === "dev").length,
      test: cases.filter((c) => c.split === "test").length,
      future: cases.filter((c) => c.split === "future").length,
      review: cases.filter((c) => c.review === "planner").length,
      changed: cases.filter((c) => c.perturbed).length,
    },
  };
}

// Each skill's tool count from the agents' Python, or null without it.
function countTools(): Record<string, number> | null {
  const python = process.env.AGENTS_PYTHON || join(root, "agents/.venv/bin/python");
  if (!existsSync(python)) return null;
  try {
    const out = execFileSync(python, [join(root, "scripts/count-skill-tools.py")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    return JSON.parse(out.trim().split("\n").at(-1) ?? "null") as Record<string, number>;
  } catch (error) {
    console.warn(`docs: couldn't count the skills' tools with ${python}: ${(error as Error).message}`);
    return null;
  }
}

export function format(data: DocsData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

if (import.meta.main) {
  if (!existsSync(SKILLS_DIR)) {
    console.log("docs: no agents/skills here, so skills.json stays as committed");
  } else {
    const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as DocsData) : undefined;
    const tools = countTools();
    if (!tools) console.log("docs: no agents' Python (agents/.venv or AGENTS_PYTHON), so tool counts stay as they were");
    const text = format(docsData(readSkills(), readCases(), tools, previous));
    if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== text) writeFileSync(OUT, text);
    console.log(`docs: ${OUT.slice(root.length + 1)}`);
  }
}
