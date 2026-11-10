// Every equity-analysis, economic-development and stop-accessibility case's gold value
// is what the service's GIS tools give on the committed datasets, so a rebuilt dataset
// that moves an answer fails here first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { GOLD, gold } from "./gis-skills-gold.ts";

const SKILLS = ["equity-analysis", "economic-development", "stop-accessibility"];
type Case = { id: string; skill: string; split: string; review?: string; goldFrom?: string; expect: { behaviour: string; value?: number } };
const cases = readFileSync(join(import.meta.dirname, "cases.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)
  .filter((c) => SKILLS.includes(c.skill));

it("gives each skill at least 8 cases, in dev and test, with one to refuse or hand over, all awaiting a planner", () => {
  for (const skill of SKILLS) {
    const own = cases.filter((c) => c.skill === skill);
    assert.ok(own.length >= 8, skill);
    assert.ok(own.some((c) => c.split === "dev") && own.some((c) => c.split === "test"), skill);
    assert.ok(own.some((c) => ["refuse", "flag"].includes(c.expect.behaviour)), skill);
    assert.ok(own.every((c) => c.review === "planner"), skill);
  }
});

it("gives each case's value from the GIS tools", () => {
  const values = gold();
  const valued = cases.filter((c) => c.expect.value !== undefined);
  assert.deepEqual(valued.map((c) => c.id).sort(), Object.keys(GOLD).sort());
  for (const c of valued) {
    assert.equal(c.expect.value, values[c.id], c.id);
    assert.match(c.goldFrom ?? "", /gis-skills-gold\.ts/, c.id);
  }
});
