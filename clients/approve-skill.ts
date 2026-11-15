// A planner approves a skill's content after reviewing it: the SHA-256 of its folder,
// which the agents' loader must match before it offers the skill. It runs with a
// planner's token, TRANSIT_TOKEN_PLANNER or the demo's, never an agent's.
//
// Usage: npm run approve-skill -- <name> [<hash>]
//   With the hash you reviewed, such as a candidate's from the evolver, it approves
//   only if the folder still hashes to it.
//        npm run approve-skill -- --all
//   Every skill on disk as it is now, as the demo's seed does.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "./api.ts";
import { liveSkills, SKILL_NAME, SKILLS_DIR, skillFiles, skillHash } from "./skill-hash.ts";

const [first, expected, ...rest] = process.argv.slice(2);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
if (!first || rest.length || (first === "--all" && expected)) fail("Usage: npm run approve-skill -- <name> [<hash>], or -- --all");
if (expected && !/^[0-9a-f]{64}$/.test(expected)) fail(`${expected} isn't a skill's hash: 64 lowercase hex digits.`);

const planner = new ApiClient("planner");
const me = await planner.get<{ role: string; name: string }>("/v1/me");
if (me.role !== "planner") fail(`This token is ${me.role}:${me.name}'s. Only a planner approves a skill: set TRANSIT_TOKEN_PLANNER to a planner's token.`);

const chosen =
  first === "--all"
    ? liveSkills()
    : (() => {
        const folder = join(SKILLS_DIR, first as string);
        if (!SKILL_NAME.test(first as string) || !existsSync(join(folder, "SKILL.md"))) fail(`No skill named ${first} in agents/skills.`);
        const hash = skillHash(folder);
        if (expected && hash !== expected) {
          fail(`agents/skills/${first} hashes to ${hash}, not the ${expected} you reviewed: it changed since. Review it again.`);
        }
        return [{ name: first as string, hash, files: skillFiles(folder) }];
      })();

for (const { name, hash, files } of chosen) {
  await planner.put(`/v1/skills/${name}`, { version: hash, description: `Approved by ${me.name} after review` });
  console.log(`Approved ${name} ${hash}: ${files.join(", ")}`);
}
