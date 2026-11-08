// The microsimulation in apps/microsim-mock/index.html, run in Node: its model is a
// plain script with no page access, so it runs here as the page runs it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type Phase = { n: number; movements: string; green: number; amber: number; red: number };
type Plan = { name: string; phases: Phase[] };
type Group = { id: string; delay: number; queue: number; los: string };
type Results = { groups: Group[]; overall: { delay: number; los: string }; cycle: number };
type Model = {
  PLAN: Plan;
  cycle(plan: Plan): number;
  signal(plan: Plan, t: number, phase: number): "G" | "A" | "R";
  simulate(plan: Plan): { results: Results };
};

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
const script = html.match(/<script id="model">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "the page has its model in <script id=\"model\">");
const context: { SignalModel?: Model } = {};
vm.runInNewContext(`${script}\nthis.SignalModel = SignalModel;`, context);
const model = context.SignalModel as Model;

function withGreen(phase: number, green: number): Plan {
  const plan: Plan = structuredClone(model.PLAN);
  const target = plan.phases.find((p) => p.n === phase);
  assert.ok(target);
  target.green = green;
  return plan;
}

const run = (plan: Plan) => model.simulate(plan).results;
const northboundLeft = (results: Results) => results.groups.find((g) => g.id === "NB-L") as Group;

test("the AM peak plan's cycle is the sum of its greens, ambers and all-reds", () => {
  assert.equal(model.cycle(model.PLAN), 116);
  assert.equal(model.cycle(withGreen(2, 20)), 124);
  // Phase 1 runs first: green from 0 s, amber at 34 s, red from 38 s.
  assert.deepEqual([0, 33.9, 34, 37.9, 38, 116].map((t) => model.signal(model.PLAN, t, 1)), ["G", "G", "A", "A", "R", "G"]);
  assert.equal(model.signal(model.PLAN, 45, 2), "G");
});

test("a run is repeatable: the same plan and seed give the same results", () => {
  assert.deepEqual(run(model.PLAN), run(structuredClone(model.PLAN)));
});

test("lengthening phase 2's green from 12 to 20 s fixes the northbound left", () => {
  const before = run(model.PLAN);
  const after = run(withGreen(2, 20));
  // The sample data starts with a northbound left that is far over capacity.
  assert.equal(northboundLeft(before).los, "F");
  assert.ok(northboundLeft(before).delay > 120, `NB left delay ${northboundLeft(before).delay}`);
  assert.ok(["C", "D"].includes(northboundLeft(after).los), `NB left LOS ${northboundLeft(after).los}`);
  assert.ok(northboundLeft(after).queue < northboundLeft(before).queue);
  // Its queue no longer spills out of the bay into the through lane, so the intersection improves too.
  assert.ok(after.overall.delay < before.overall.delay - 10);
  assert.ok(after.overall.los < before.overall.los, `${before.overall.los} → ${after.overall.los}`);
});

test("a shorter phase 2 green makes the northbound left worse", () => {
  assert.ok(northboundLeft(run(withGreen(2, 8))).delay > northboundLeft(run(model.PLAN)).delay);
});
