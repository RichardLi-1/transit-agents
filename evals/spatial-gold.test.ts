// Every spatial case's gold value is what the service's GIS tools give on the
// committed datasets, so a rebuilt dataset that moves an answer fails here first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { GOLD, gold } from "./spatial-gold.ts";

const cases = readFileSync(join(import.meta.dirname, "cases.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { id: string; capability: string; skill: string; split: string; expect: { behaviour: string; value?: number } });
// gis-analyst's: the skills built on it check their own, in gis-skills-gold.test.ts.
const spatial = cases.filter((c) => c.capability === "spatial" && c.skill === "gis-analyst");

it("has at least 8 spatial cases, in dev and test, with one it must not answer", () => {
  assert.ok(spatial.length >= 8);
  assert.ok(spatial.some((c) => c.split === "dev") && spatial.some((c) => c.split === "test"));
  assert.ok(spatial.some((c) => ["abstain", "refuse"].includes(c.expect.behaviour)));
});

it("gives each spatial case's value from the GIS tools", () => {
  const values = gold();
  const valued = spatial.filter((c) => c.expect.value !== undefined);
  assert.deepEqual(valued.map((c) => c.id).sort(), Object.keys(GOLD).sort());
  for (const c of valued) assert.equal(c.expect.value, values[c.id], c.id);
});
