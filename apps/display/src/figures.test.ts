import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Assumption, FigureView } from "@transit-agents/contracts";
import { amount, citesAPage, otherFigures, quantity, trialDays } from "./figures.ts";

const figure = (id: string, basis: FigureView["basis"]): FigureView => ({
  id,
  studyId: "s",
  label: id,
  unit: "",
  value: 1,
  basis,
  accepted: true,
  recordedBy: "agent:lead",
  recordedAt: "2026-11-08T00:00:00.000Z",
  seq: 1,
  hash: "",
  stale: false,
});
const assumption = (key: string, cited: boolean): Assumption => ({
  key,
  label: key,
  value: 1,
  unit: "",
  reason: "Set",
  owner: "planner:demo",
  setAt: "2026-11-08T00:00:00.000Z",
  history: [],
  ...(cited ? { citation: { contextId: "plan", page: 1, quote: "one" } } : {}),
});

describe("citesAPage", () => {
  const figures = [
    figure("cited", { kind: "cited", citation: { contextId: "plan", page: 1, quote: "one" } }),
    figure("from-cited", { kind: "derived", formula: "a * 2", inputs: { a: { figure: "cited" } } }),
    figure("from-rule", { kind: "derived", formula: "a * 2", inputs: { a: { assumption: "rule" } } }),
    figure("planner-only", { kind: "derived", formula: "a / b", inputs: { a: { assumption: "length" }, b: { assumption: "stations" } } }),
  ];
  const assumptions = [assumption("rule", true), assumption("length", false), assumption("stations", false)];

  it("follows a figure's inputs to a page", () => {
    assert.deepEqual(
      figures.map((f) => citesAPage(f.id, figures, assumptions)),
      [true, true, true, false],
    );
  });

  it("is false for a figure it can't find", () => {
    assert.equal(citesAPage("missing", figures, assumptions), false);
  });
});

describe("amount", () => {
  it("rounds as a planner quotes, with the unit where it reads as part of the number", () => {
    assert.deepEqual(
      [amount({ value: 4639.94, unit: "$M" }), amount({ value: 11.54, unit: "minutes" }), amount({ value: 30, unit: "%" }), amount({ value: 143846.15, unit: "trips/day" })],
      ["$4,640 M", "11.5 min", "30%", "143,846"],
    );
    assert.equal(amount({ value: -7, unit: "minutes/trip" }), "\u22127");
  });

  it("adds any unit amount leaves out", () => {
    assert.deepEqual([quantity(143846.15, "trips/day"), quantity(6, "km"), quantity(613, "$M/km"), quantity(1, "")], ["143,846 trips/day", "6 km", "613 $M/km", "1"]);
  });
});

describe("otherFigures", () => {
  it("leaves out the figures shown already, and groups the rest by who recorded them", () => {
    const at = (id: string, seq: number, recordedBy: string): FigureView => ({ ...figure(id, { kind: "cited", citation: { contextId: "plan", page: 1, quote: "one" } }), seq, recordedBy });
    const figures = [at("b", 3, "agent:lead"), at("headline", 1, "agent:replay"), at("a", 2, "agent:replay"), at("c", 4, "agent:replay")];
    assert.deepEqual(
      otherFigures(figures, ["headline"]).map(({ by, figures }) => [by, figures.map((f) => f.id)]),
      [
        ["agent:replay", ["a", "c"]],
        ["agent:lead", ["b"]],
      ],
    );
  });
});

describe("trialDays", () => {
  const day = (date: string, departures: number) => ({ date, departures, onTimeStandard: departures, onTimeReported: departures, scheduled: departures });
  const days = [day("2026-10-31", 40), day("2026-11-01", 40), day("2026-11-02", 20)];

  it("counts only the trial's days on a trial, as the agent's skill does", () => {
    assert.deepEqual(trialDays(days, "2026-11-01").map((d) => d.date), ["2026-11-01", "2026-11-02"]);
  });

  it("counts every measured day without a trial", () => {
    assert.equal(trialDays(days, undefined).length, 3);
  });
});
