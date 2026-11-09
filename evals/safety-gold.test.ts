// Every safety-audit and active-transportation case's gold value is what the
// service's tools give on the committed datasets, so a rebuilt dataset that moves an
// answer fails here first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { GOLD, gold, hotspotName } from "./safety-gold.ts";

type Case = { id: string; skill: string; split: string; review?: string; expect: { behaviour: string; value?: number; mentions?: string[] } };
const cases = readFileSync(join(import.meta.dirname, "cases.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case);
const SKILLS = ["safety-audit", "active-transportation"];
const ours = cases.filter((c) => SKILLS.includes(c.skill));

it("has at least 8 cases for each skill, in dev and test, with one to refuse or hand over, all awaiting a planner", () => {
  for (const skill of SKILLS) {
    const mine = ours.filter((c) => c.skill === skill);
    assert.ok(mine.length >= 8, skill);
    assert.ok(mine.some((c) => c.split === "dev") && mine.some((c) => c.split === "test"), skill);
    assert.ok(mine.some((c) => ["abstain", "refuse", "flag"].includes(c.expect.behaviour)), skill);
    assert.ok(mine.every((c) => c.review === "planner"), skill);
  }
});

it("gives each case's value from the service's tools", () => {
  const values = gold();
  const valued = ours.filter((c) => c.expect.value !== undefined);
  assert.deepEqual(valued.map((c) => c.id).sort(), Object.keys(GOLD).sort());
  for (const c of valued) assert.equal(c.expect.value, values[c.id], c.id);
});

it("names the busiest place on the 25 as the hot spot tool does", () => {
  const named = ours.find((c) => c.id === "safety-003");
  assert.ok(named?.expect.mentions?.every((word) => hotspotName().toLowerCase().includes(word.toLowerCase())));
});
