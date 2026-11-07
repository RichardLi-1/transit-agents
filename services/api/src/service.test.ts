import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { NewAssumption, NewCheck, NewContext, NewDecision, NewFigure, NewFinding, NewStudy } from "@transit-agents/contracts";
import { ApiError, Service } from "./service.ts";

const PLAN = [
  "Service Productivity. This recommendation is anticipated to cost 25 weekly service hours and is forecasted to produce a weekly system ridership increase of 1,680 customers.",
  "This recommendation is predicted to gain 40 riders per $100 spent. Survey feedback was overwhelmingly positive.",
  "service changes are required to gain at least 11 new customers per $100 spent",
].map((text, i) => ({ page: i + 1, text }));

const cited = (id: string, value: number, page: number, quote: string, label = id) =>
  NewFigure.parse({ id, label, value, basis: { kind: "cited", citation: { contextId: "plan", page, quote } } });

function seed(service: Service) {
  service.addContext("integration:seed", NewContext.parse({ id: "plan", title: "2026 Plan", pages: PLAN }));
  service.openStudy("agent:lead", NewStudy.parse({ id: "lawrence", title: "Lawrence–Sunnybrook" }));
  service.addFinding("agent:lead", "lawrence", NewFinding.parse({ id: "survey", label: "Survey", text: "Positive", tone: "positive", citation: { contextId: "plan", page: 2, quote: "Survey feedback was overwhelmingly positive" } }));
  service.rateFinding("planner:ana", "lawrence", "survey", "positive");
  service.setAssumption("planner:ana", "min-riders-per-100", NewAssumption.parse({ value: 11, reason: "TTC standard", citation: { contextId: "plan", page: 3, quote: "gain at least 11 new customers per $100 spent" } }));
  service.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 1, reason: "Published forecast" }));
  service.addFigure("agent:lead", "lawrence", cited("riders", 1680, 1, "ridership increase of 1,680 customers"));
  service.addFigure("agent:lead", "lawrence", cited("hours", 25, 1, "cost 25 weekly service hours"));
  service.addFigure("agent:lead", "lawrence", cited("per-100-published", 40, 2, "gain 40 riders per $100 spent"));
  service.addFigure(
    "agent:lead",
    "lawrence",
    NewFigure.parse({
      id: "per-100",
      label: "Riders per $100",
      basis: { kind: "derived", formula: "published * realised", inputs: { published: { figure: "per-100-published" }, realised: { assumption: "ridership-realised" } } },
    }),
  );
  service.addCheck("agent:lead", "lawrence", NewCheck.parse({ id: "ridership-per-dollar", label: "Riders per $100", figure: "per-100", op: ">=", threshold: { assumption: "min-riders-per-100" } }));
}

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error) => error instanceof ApiError && error.code === code, code);

describe("Service", () => {
  let service: Service;
  beforeEach(() => {
    service = new Service(":memory:");
    seed(service);
  });

  describe("figures", () => {
    it("rejects a quote that is not on the page", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", cited("x", 2000, 1, "ridership increase of 2,000 customers")), "quote_not_found");
    });

    it("rejects a real quote on the wrong page", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", cited("x", 1680, 2, "ridership increase of 1,680 customers")), "quote_not_found");
    });

    it("rejects a true quote used for a different number", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", cited("x", 2000, 1, "ridership increase of 1,680 customers")), "value_not_in_quote");
    });

    it("rejects an unknown source and a page that does not exist", () => {
      const figure = (contextId: string, page: number) =>
        NewFigure.parse({ id: "x", label: "x", value: 25, basis: { kind: "cited", citation: { contextId, page, quote: "cost 25 weekly service hours" } } });
      rejects(() => service.addFigure("agent:a", "lawrence", figure("nope", 1)), "unknown_source");
      rejects(() => service.addFigure("agent:a", "lawrence", figure("plan", 99)), "page_not_found");
    });

    it("logs every rejection", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", cited("x", 2000, 1, "made up quote about ridership")), "quote_not_found");
      const entry = service.log.since(0).at(-1);
      assert.equal(entry?.type, "figure.rejected");
      assert.equal(service.state.studies.get("lawrence")?.figures.has("x"), false);
    });

    it("computes derived figures and rejects a claimed value that disagrees", () => {
      assert.equal(service.viewStudy("lawrence").figures.find((f) => f.id === "per-100")?.value, 40);
      const lie = NewFigure.parse({ id: "y", label: "y", value: 99, basis: { kind: "derived", formula: "a * 2", inputs: { a: { figure: "hours" } } } });
      rejects(() => service.addFigure("agent:a", "lawrence", lie), "value_mismatch");
    });

    it("rejects bad formulas, unbound names and self-reference", () => {
      const derived = (id: string, formula: string, inputs: object) => NewFigure.parse({ id, label: id, basis: { kind: "derived", formula, inputs } });
      rejects(() => service.addFigure("agent:a", "lawrence", derived("a", "process.exit()", {})), "bad_formula");
      rejects(() => service.addFigure("agent:a", "lawrence", derived("a", "b + 1", {})), "unbound_name");
      rejects(() => service.addFigure("agent:a", "lawrence", derived("a", "a + 1", { a: { figure: "a" } })), "unknown_input");
      rejects(() => service.addFigure("agent:a", "lawrence", derived("hours", "h + 1", { h: { figure: "hours" } })), "circular");
    });

    it("rejects a loop closed through another figure", () => {
      const derived = (id: string, formula: string, inputs: object) => NewFigure.parse({ id, label: id, basis: { kind: "derived", formula, inputs } });
      service.addFigure("agent:a", "lawrence", derived("double", "h * 2", { h: { figure: "hours" } }));
      rejects(() => service.addFigure("agent:a", "lawrence", derived("hours", "d / 2", { d: { figure: "double" } })), "circular");
      assert.equal(service.studies().length, 1);
    });

    it("refuses a citation to a document an agent added", () => {
      service.addContext("agent:lead", NewContext.parse({ id: "notes", title: "My notes", text: "ridership increase of 9,999 customers" }));
      const figure = NewFigure.parse({ id: "x", label: "x", value: 9999, basis: { kind: "cited", citation: { contextId: "notes", page: 1, quote: "ridership increase of 9,999 customers" } } });
      rejects(() => service.addFigure("agent:a", "lawrence", figure), "uncitable_source");
    });

    it("refuses a flipped sign that would turn a failing test into a pass", () => {
      service.addContext("integration:seed", NewContext.parse({ id: "hc", title: "Highland", text: "a net increase in weighted customer travel time of 18,940 weekly minutes" }));
      const flipped = NewFigure.parse({ id: "t", label: "t", value: -18940, basis: { kind: "cited", citation: { contextId: "hc", page: 1, quote: "a net increase in weighted customer travel time of 18,940 weekly minutes" } } });
      rejects(() => service.addFigure("agent:a", "lawrence", flipped), "value_not_in_quote");
    });
  });

  describe("assumptions", () => {
    it("flows through the graph and records every effect", () => {
      const { effects } = service.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 0.25, reason: "Stress test" }));
      assert.deepEqual(effects[0]?.figures, [{ id: "per-100", from: 40, to: 10 }]);
      assert.deepEqual(effects[0]?.checks, [{ id: "ridership-per-dollar", from: "pass", to: "fail" }]);
      // The test now fails but consultation was positive, so it needs judgement.
      assert.deepEqual(effects[0]?.analysis, { from: "pass", to: "mixed" });
      assert.equal(service.viewStudy("lawrence").analysis, "mixed");
    });

    it("keeps the old value", () => {
      service.setAssumption("planner:bo", "min-riders-per-100", NewAssumption.parse({ value: 45, reason: "Board raised the bar" }));
      const assumption = service.state.assumptions.get("min-riders-per-100");
      assert.equal(assumption?.value, 45);
      assert.equal(assumption?.owner, "planner:bo");
      assert.deepEqual(assumption?.history.map((h) => h.value), [11]);
    });

    it("previews a change without writing to the log", () => {
      const head = service.log.head().seq;
      const preview = service.viewStudy("lawrence", { assumptions: { "ridership-realised": 0.2 } });
      assert.equal(preview.checks.find((c) => c.id === "ridership-per-dollar")?.status, "fail");
      assert.equal(service.log.head().seq, head);
      assert.equal(service.viewStudy("lawrence").analysis, "pass");
    });
  });

  describe("computed figures", () => {
    const computed = NewFigure.parse({ id: "travel-time", label: "Travel time", value: 12, basis: { kind: "computed", skill: "travel-time-compare", version: "1.0.0", inputs: [{ assumption: "ridership-realised" }] } });
    const check = NewCheck.parse({ id: "tt", label: "Travel time", figure: "travel-time", op: "<", threshold: { assumption: "max-minutes" } });
    const approve = () => {
      service.registerSkill("planner:ana", "travel-time-compare", { version: "1.0.0", description: "r5py before and after" });
      service.setAssumption("planner:ana", "max-minutes", NewAssumption.parse({ value: 20, reason: "Target" }));
    };

    it("need an approved skill version", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", computed), "unregistered_skill");
    });

    it("can't pass a check until a planner accepts them", () => {
      approve();
      service.addFigure("agent:a", "lawrence", computed);
      service.addCheck("agent:a", "lawrence", check);
      assert.equal(service.viewStudy("lawrence").checks.find((c) => c.id === "tt")?.status, "unverified");
      assert.equal(service.viewStudy("lawrence").analysis, "incomplete");
      service.acceptFigure("planner:ana", "lawrence", "travel-time");
      assert.equal(service.viewStudy("lawrence").checks.find((c) => c.id === "tt")?.status, "pass");
    });

    it("are marked stale when an input changes, and need accepting again when resubmitted", () => {
      approve();
      service.addFigure("agent:a", "lawrence", computed);
      service.addCheck("agent:a", "lawrence", check);
      service.acceptFigure("planner:ana", "lawrence", "travel-time");
      service.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 0.9, reason: "Revised" }));
      const stale = service.viewStudy("lawrence");
      assert.equal(stale.figures.find((f) => f.id === "travel-time")?.stale, true);
      assert.equal(stale.checks.find((c) => c.id === "tt")?.status, "stale");
      service.addFigure("agent:a", "lawrence", computed);
      assert.equal(service.viewStudy("lawrence").checks.find((c) => c.id === "tt")?.status, "unverified");
      service.acceptFigure("planner:ana", "lawrence", "travel-time");
      assert.equal(service.viewStudy("lawrence").analysis, "pass");
    });
  });

  describe("findings", () => {
    it("count once a planner rates them, and a negative rating makes the analysis mixed", () => {
      service.addFinding("agent:a", "lawrence", NewFinding.parse({ id: "events", label: "Events", text: "Negative", tone: "positive", citation: { contextId: "plan", page: 2, quote: "Survey feedback was overwhelmingly positive" } }));
      const pending = service.viewStudy("lawrence");
      assert.equal(pending.findings.find((f) => f.id === "events")?.tone, "unrated");
      assert.equal(pending.findings.find((f) => f.id === "events")?.proposedTone, "positive");
      assert.equal(pending.analysis, "incomplete");
      service.rateFinding("planner:ana", "lawrence", "events", "negative");
      assert.equal(service.viewStudy("lawrence").analysis, "mixed");
    });

    it("leave a decision against mixed results unflagged, because that is judgement", () => {
      service.addFinding("agent:a", "lawrence", NewFinding.parse({ id: "events", label: "Events", text: "Negative", tone: "negative", citation: { contextId: "plan", page: 2, quote: "Survey feedback was overwhelmingly positive" } }));
      service.rateFinding("planner:ana", "lawrence", "events", "negative");
      const decision = service.recordDecision("planner:ana", "lawrence", NewDecision.parse({ outcome: "reject", reason: "Feedback", decidedBy: "Ana Ruiz" }));
      assert.equal(decision.analysis, "mixed");
      assert.equal(decision.override, false);
    });
  });

  describe("content removal", () => {
    it("removes a finding's words, keeps the chain, and logs the removal", () => {
      const seq = service.log.since(0).find((e) => e.type === "finding.recorded")?.seq as number;
      service.removeContent("planner:ana", seq, "Retention schedule");
      assert.equal(service.viewStudy("lawrence").findings.length, 0);
      assert.equal(service.log.verify().ok, true);
      assert.equal(service.log.since(0).at(-1)?.type, "content.removed");
    });

    it("refuses to remove anything results depend on", () => {
      const seq = service.log.since(0).find((e) => e.type === "figure.recorded")?.seq as number;
      rejects(() => service.removeContent("planner:ana", seq, "Because"), "not_removable");
    });
  });

  describe("decisions", () => {
    it("marks a decision against a clear analysis as an override", () => {
      const decision = service.recordDecision("planner:ana", "lawrence", NewDecision.parse({ outcome: "reject", reason: "Public feedback", decidedBy: "Ana Ruiz" }));
      assert.equal(decision.analysis, "pass");
      assert.equal(decision.override, true);
    });

    it("does not flag a decision that follows the analysis", () => {
      const decision = service.recordDecision("planner:ana", "lawrence", NewDecision.parse({ outcome: "adopt", reason: "Passes all tests", decidedBy: "Ana Ruiz" }));
      assert.equal(decision.override, false);
    });
  });

  describe("finding quotes", () => {
    it("need a quote that exists", () => {
      const finding = (quote: string) => NewFinding.parse({ id: "f", label: "Survey", text: "Positive", tone: "positive", citation: { contextId: "plan", page: 2, quote } });
      assert.equal(service.addFinding("agent:a", "lawrence", finding("Survey feedback was overwhelmingly positive")).id, "f");
      rejects(() => service.addFinding("agent:a", "lawrence", finding("Everyone hated this change")), "quote_not_found");
    });
  });

  describe("trace", () => {
    it("walks a figure back to its page and assumption", () => {
      const trace = service.trace("lawrence", "per-100");
      assert.equal(trace.value, 40);
      const [published, realised] = trace.inputs;
      assert.ok(published && "basis" in published);
      assert.equal(published.basis.kind === "cited" && published.basis.citation.page, 2);
      assert.ok(published.entry?.hash);
      assert.ok(realised && "assumption" in realised);
    });
  });

  describe("compare", () => {
    it("attributes a change to who made it, and the shares add up", () => {
      const from = service.log.head().seq;
      service.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 0.8, reason: "Slow recovery" }));
      service.setAssumption("planner:bo", "ridership-realised", NewAssumption.parse({ value: 0.5, reason: "Competing route" }));
      const { figures } = service.compare("lawrence", from, service.log.head().seq);
      const figure = figures.find((f) => f.id === "per-100");
      assert.equal(figure?.from, 40);
      assert.equal(figure?.to, 20);
      assert.deepEqual(figure?.causes.map((c) => [c.actor, c.reason, Math.round(c.share * 100)]), [
        ["planner:ana", "Slow recovery", 40],
        ["planner:bo", "Competing route", 60],
      ]);
    });
  });

  describe("usage", () => {
    it("adds up tokens and cost by study", () => {
      service.recordActivity("agent:a", "lawrence", { kind: "usage", model: "m", inputTokens: 1000, outputTokens: 200, costUsd: 0.5 });
      service.recordActivity("agent:a", "lawrence", { kind: "usage", model: "m", inputTokens: 500, outputTokens: 100, costUsd: 0.25 });
      const { total, byStudy } = service.usage();
      assert.equal(total.inputTokens, 1500);
      assert.equal(total.costUsd, 0.75);
      assert.equal(byStudy.lawrence?.calls, 2);
    });
  });

  describe("context", () => {
    it("treats the same document added twice as one", () => {
      const again = service.addContext("agent:a", NewContext.parse({ id: "plan", title: "2026 Plan", pages: PLAN }));
      assert.equal(again.addedBy, "integration:seed");
    });

    it("refuses different content under the same id", () => {
      rejects(() => service.addContext("agent:a", NewContext.parse({ id: "plan", title: "x", text: "changed" })), "context_conflict");
    });
  });
});

describe("restart", () => {
  it("rebuilds identical state from the log alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-agents-"));
    const path = join(dir, "log.db");
    try {
      const first = new Service(path);
      seed(first);
      first.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 0.25, reason: "Stress test" }));
      first.recordDecision("planner:ana", "lawrence", NewDecision.parse({ outcome: "adopt", reason: "Strategic", decidedBy: "Ana Ruiz" }));
      const before = first.viewStudy("lawrence");
      first.close();

      const second = new Service(path);
      assert.deepEqual(second.viewStudy("lawrence"), before);
      assert.equal(second.log.verify().ok, true);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
