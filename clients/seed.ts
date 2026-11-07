// Loads the public source documents and published rules into the service, through
// the same API any agency system would use.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient } from "./api.ts";
import { RULES, SOURCES } from "./seed-data.ts";

const api = new ApiClient();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gap = Number(process.env.SEED_GAP_MS ?? 500);

for (const { pagesFile, ...source } of SOURCES) {
  const pages = pagesFile ? JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", pagesFile), "utf8")) : undefined;
  await api.post("/v1/context", { ...source, ...(pages ? { pages } : {}) });
  console.log("context", source.id);
  await pause(gap);
}

for (const { key, ...rule } of RULES) {
  await api.put(`/v1/assumptions/${key}`, rule);
  console.log("rule", key);
}
