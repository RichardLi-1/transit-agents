// A skill's version: the SHA-256 of its folder, computed exactly as agents/skills.py
// computes it, so a planner here approves what the agents load there. Each file, in
// the order of its path's bytes, adds its path in the folder (with "/"), a NUL, its
// length in bytes, a NUL, then its bytes. __pycache__ folders, .pyc files and
// .DS_Store are left out: Python and Finder write them, and nobody reviews them.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKILLS_DIR = join(import.meta.dirname, "../agents/skills");

// A skill's name is its folder's: lowercase letters, numbers and dashes.
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const left = (name: string, folder: boolean) => (folder ? name === "__pycache__" : name === ".DS_Store" || name.endsWith(".pyc"));

// The folder's files that count, by path in the folder, in the order they're hashed.
// Links are followed, as the agents' loader follows them.
export function skillFiles(folder: string, under = ""): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(folder, under))) {
    const path = under ? `${under}/${name}` : name;
    const stat = statSync(join(folder, path));
    if (stat.isDirectory()) {
      if (!left(name, true)) files.push(...skillFiles(folder, path));
    } else if (stat.isFile() && !left(name, false)) {
      files.push(path);
    }
  }
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export function skillHash(folder: string): string {
  const hash = createHash("sha256");
  for (const path of skillFiles(folder)) {
    const bytes = readFileSync(join(folder, path));
    hash.update(Buffer.from(path, "utf8")).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

// The live skills, by name: each folder with a SKILL.md, and its hash now.
export function liveSkills(root = SKILLS_DIR): { name: string; hash: string; files: string[] }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => SKILL_NAME.test(name) && existsSync(join(root, name, "SKILL.md")))
    .sort()
    .map((name) => ({ name, hash: skillHash(join(root, name)), files: skillFiles(join(root, name)) }));
}

// The live skills whose hash now isn't their current approved version, from GET
// /v1/skills: agents won't load them.
export function waiting(current: Record<string, string>, root = SKILLS_DIR): string[] {
  return liveSkills(root)
    .filter(({ name, hash }) => current[name] !== hash)
    .map(({ name }) => name);
}
