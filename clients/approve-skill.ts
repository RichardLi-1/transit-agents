// A planner approves a skill's content after reviewing it: the SHA-256 of its folder,
// which the agents' loader must match before it offers the skill. The approved hash
// becomes the skill's one current version, replacing the one before. It runs with a
// planner's token, TRANSIT_TOKEN_PLANNER or the demo's, never an agent's.
//
// Usage: npm run approve-skill -- <name> [<hash>]
//   With the hash you reviewed, such as a candidate's from the evolver, it approves
//   only if the folder still hashes to it. Rolling back is the same: restore the
//   parent's files, then approve the parent's hash.
//        npm run approve-skill -- --all
//   Every skill on disk as it is now, as the demo's seed does.
//        npm run approve-skill -- --revoke <name> <reason>
//   Withdraw a skill's current version: no agent loads it until one is approved again.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "./api.ts";
import { liveSkills, SKILL_NAME, SKILLS_DIR, skillFiles, skillHash } from "./skill-hash.ts";

const USAGE = "Usage: npm run approve-skill -- <name> [<hash>], -- --all, or -- --revoke <name> <reason>";
const args = process.argv.slice(2);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const short = (hash: string) => hash.slice(0, 12);

const planner = new ApiClient("planner");
const me = await planner.get<{ role: string; name: string }>("/v1/me");
if (me.role !== "planner") fail(`This token is ${me.role}:${me.name}'s. Only a planner approves a skill: set TRANSIT_TOKEN_PLANNER to a planner's token.`);

if (args[0] === "--revoke") {
  const [, name, ...words] = args;
  const reason = words.join(" ").trim();
  if (!name || !SKILL_NAME.test(name) || reason.length < 3) fail(USAGE);
  const { revoked } = await planner.post<{ revoked: string }>(`/v1/skills/${name}/revoke`, { reason });
  console.log(`Revoked ${name} ${revoked}: no agent loads it until a planner approves a version again.`);
  process.exit(0);
}

const [first, expected, ...rest] = args;
if (!first || rest.length || (first === "--all" && expected)) fail(USAGE);
if (expected && !/^[0-9a-f]{64}$/.test(expected)) fail(`${expected} isn't a skill's hash: 64 lowercase hex digits.`);

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
  const { previous } = await planner.put<{ previous: string | null }>(`/v1/skills/${name}`, {
    version: hash,
    description: `Approved by ${me.name} after review`,
  });
  const replaced = previous && previous !== hash ? `, in place of ${short(previous)}` : "";
  console.log(`Approved ${name} ${hash}${replaced}: ${files.join(", ")}`);
}
