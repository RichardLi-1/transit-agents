import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUDGET_SPENT, NewStudy } from "@transit-agents/contracts";
import { VisitorBudget } from "./budget.ts";
import { ApiError, Service } from "./service.ts";

const visitor = (letter: string) => `guest:${letter.repeat(22)}`;
const A = visitor("a");
const B = visitor("b");

const usage = (costUsd?: number, tokens = { inputTokens: 1000, outputTokens: 200 }) => ({
  kind: "usage",
  model: "gemini-3-flash-preview",
  ...tokens,
  ...(costUsd === undefined ? {} : { costUsd }),
});

const entry = (at: string, data: object, audience: string | null = A, actor = "agent:lead", type = "activity") => ({
  type,
  actor,
  at,
  data,
  audience,
});

const NOON = "2026-11-08T17:00:00.000Z";

describe("VisitorBudget", () => {
  const budget = (at = NOON) => new VisitorBudget({ capUsd: 25, marginUsd: 2, shareUsd: 5, clock: () => new Date(at) });

  it("counts only the usage agents report for a visitor", () => {
    const b = budget();
    b.observe(entry(NOON, usage(1), null));
    b.observe(entry(NOON, usage(1), null, "planner:ana"));
    b.observe(entry(NOON, usage(1), A, "guest:aaaa"));
    b.observe(entry(NOON, usage(1), A, "integration:seed"));
    b.observe(entry(NOON, { kind: "message", text: "costUsd: 1" }));
    b.observe(entry(NOON, usage(1), A, "agent:lead", "figure.recorded"));
    b.observe(entry(NOON, { redacted: true }));
    assert.equal(b.left(A), 5);
    b.observe(entry(NOON, usage(1.5)));
    b.observe(entry(NOON, usage(0.5), A, "agent:media"));
    assert.equal(b.left(A), 3);
    assert.equal(b.left(B), 5);
  });

  it("counts a call reported without a cost at $20 per million tokens", () => {
    const b = budget();
    b.observe(entry(NOON, usage(undefined, { inputTokens: 40_000, outputTokens: 10_000 })));
    assert.equal(b.left(A), 4);
  });

  it("stops new work for every visitor at the cap less the margin", () => {
    const b = budget();
    for (const letter of "abcde") b.observe(entry(NOON, usage(4.5), visitor(letter)));
    const late = visitor("f");
    assert.equal(b.left(late), 0.5);
    assert.doesNotThrow(() => b.require(late, 0.1));
    assert.throws(
      () => b.require(late, 0.7),
      (error) => error instanceof ApiError && error.status === 429 && error.code === "budget_spent" && error.message === BUDGET_SPENT,
    );
    b.observe(entry(NOON, usage(0.75), late));
    assert.equal(b.left(late), -0.25);
    assert.deepEqual(b.view(late), { capped: true, capUsd: 25, leftUsd: 0 });
    assert.throws(() => b.require(late, 0), ApiError);
  });

  it("holds one visitor to their share while others still have budget", () => {
    const b = budget();
    b.observe(entry(NOON, usage(5)));
    assert.equal(b.left(A), 0);
    assert.throws(() => b.require(A, 0.1), ApiError);
    assert.equal(b.left(B), 5);
    assert.deepEqual(b.view(B), { capped: true, capUsd: 25, leftUsd: 5 });
  });

  it("starts a new day at midnight in Toronto", () => {
    // Toronto is UTC-5 in November, so its midnight is 05:00 UTC.
    let now = "2026-11-08T04:59:00.000Z";
    const b = new VisitorBudget({ capUsd: 25, marginUsd: 2, shareUsd: 5, clock: () => new Date(now) });
    b.observe(entry(now, usage(5)));
    assert.equal(b.left(A), 0);
    now = "2026-11-08T05:00:00.000Z";
    assert.equal(b.left(A), 5);
    b.observe(entry(now, usage(1)));
    // A call from yesterday reported late counts for yesterday, which is gone.
    b.observe(entry("2026-11-08T04:59:59.000Z", usage(1)));
    assert.equal(b.left(A), 4);
  });

  it("isn't a cap for planners or anyone without an audience", () => {
    const b = budget();
    b.observe(entry(NOON, usage(30)));
    assert.deepEqual(b.view(null), { capped: false });
  });
});

describe("VisitorBudget in a service", () => {
  it("counts a visitor's usage as it is written, and the same again from the log on restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-budget-"));
    const path = join(dir, "log.db");
    const clock = () => new Date(NOON);
    const spent = (costUsd: number) => ({ kind: "usage" as const, model: "m", inputTokens: 10, outputTokens: 1, costUsd });
    try {
      const counted = new VisitorBudget({ clock });
      const first = new Service(path, { clock, budget: counted });
      first.openStudy("agent:lead", NewStudy.parse({ id: "s", title: "S" }));
      first.viewFor(A).recordActivity("agent:lead", "s", spent(0.25));
      first.viewFor(B).recordActivity("agent:media", "s", spent(0.5));
      first.recordActivity("agent:lead", "s", spent(3));
      first.viewFor(A).recordActivity("guest:a", "s", { kind: "message", text: "Hi" });
      // Each pass gets $1 of the day's $10.
      assert.deepEqual([counted.left(A), counted.left(B)], [0.75, 0.5]);
      first.close();

      const recounted = new VisitorBudget({ clock });
      const second = new Service(path, { clock, budget: recounted });
      assert.deepEqual([recounted.left(A), recounted.left(B)], [0.75, 0.5]);
      assert.deepEqual(recounted.view(A), counted.view(A));
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
