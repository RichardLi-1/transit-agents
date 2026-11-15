// Loads the public source documents, as an agency system would, and the published
// rules and study assumptions, as a planner would. Then the planner approves the
// skills on disk, by their content hashes: agents load only approved ones.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "./api.ts";
import { RULES, SOURCES, STUDIES } from "./seed-data.ts";
import { liveSkills } from "./skill-hash.ts";

const integration = new ApiClient("integration");
const planner = new ApiClient("planner");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gap = Number(process.env.SEED_GAP_MS ?? 500);

for (const { pagesFile, ...source } of SOURCES) {
  const pages = pagesFile ? JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", pagesFile), "utf8")) : undefined;
  await integration.post("/v1/context", { ...source, ...(pages ? { pages } : {}) });
  console.log("context", source.id);
  await pause(gap);
}

for (const { key, ...rule } of [...RULES, ...STUDIES.flatMap((s) => s.assumptions)]) {
  await planner.put(`/v1/assumptions/${key}`, rule);
  console.log("assumption", key);
}

// A skill changed after this waits for a planner again: npm run approve-skill -- <name>.
for (const { name, hash } of liveSkills()) {
  await planner.put(`/v1/skills/${name}`, { version: hash, description: "Approved as the demo was seeded" });
  console.log("skill", name, hash.slice(0, 12));
}
