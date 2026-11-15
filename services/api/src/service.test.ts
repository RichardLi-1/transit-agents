import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NewAssumption, NewCheck, NewContext, NewDecision, NewFigure, NewFinding, NewMedia, NewNeed, NewStudy, type Usage } from "@transit-agents/contracts";
import { GEMINI_PROMPT } from "./footprint.ts";
import { padded, SAMPLE } from "./sample-media.ts";
import { ApiError, CLAIM_MS, Service } from "./service.ts";

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

const need = (id: string, title = "Engagement poster") =>
  NewNeed.parse({
    id,
    title,
    place: "Sunnybrook Hospital",
    lon: -79.375262,
    lat: 43.722663,
    kinds: ["image"],
    reason: "Riders can now reach the hospital without a transfer.",
    citations: [{ contextId: "plan", page: 1, quote: "ridership increase of 1,680 customers" }],
  });

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

    it("rejects a quote that cuts the page's number in half", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", cited("x", 1, 1, "weekly system ridership increase of 1")), "quote_not_found");
      rejects(() => service.addFigure("agent:a", "lawrence", cited("x", 680, 1, "680 customers")), "quote_not_found");
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
    const version = createHash("sha256").update("travel-time-compare's folder").digest("hex");
    const computed = NewFigure.parse({ id: "travel-time", label: "Travel time", value: 12, basis: { kind: "computed", skill: "travel-time-compare", version, inputs: [{ assumption: "ridership-realised" }] } });
    const check = NewCheck.parse({ id: "tt", label: "Travel time", figure: "travel-time", op: "<", threshold: { assumption: "max-minutes" } });
    const approve = () => {
      service.registerSkill("planner:ana", "travel-time-compare", { version, description: "r5py before and after" });
      service.setAssumption("planner:ana", "max-minutes", NewAssumption.parse({ value: 20, reason: "Target" }));
    };

    it("need an approved skill version", () => {
      rejects(() => service.addFigure("agent:a", "lawrence", computed), "unregistered_skill");
    });

    it("need the content hash approved for that skill, never a label or another skill's", () => {
      // A self-reported version string isn't a content hash, so it never reaches the check.
      assert.equal(NewFigure.safeParse({ ...computed, basis: { ...computed.basis, version: "1.0.0" } }).success, false);
      assert.equal(NewFigure.safeParse({ ...computed, basis: { ...computed.basis, version: version.slice(0, 12) } }).success, false);
      service.registerSkill("planner:ana", "other-skill", { version, description: "Another skill" });
      rejects(() => service.addFigure("agent:a", "lawrence", computed), "unregistered_skill");
      service.registerSkill("planner:ana", "travel-time-compare", { version: "f".repeat(64), description: "Another version" });
      rejects(() => service.addFigure("agent:a", "lawrence", computed), "unregistered_skill");
      approve();
      assert.equal(service.addFigure("agent:a", "lawrence", computed).value, 12);
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
      assert.equal(total.unpricedCalls, 0);
    });

    it("counts calls reported without a cost, which the cost leaves out", () => {
      service.recordActivity("agent:a", "lawrence", { kind: "usage", model: "m", inputTokens: 1000, outputTokens: 200, costUsd: 0.5 });
      service.recordActivity("agent:a", "lawrence", { kind: "usage", model: "unpriced", inputTokens: 500, outputTokens: 100 });
      const { total, byStudy } = service.usage();
      assert.equal(total.costUsd, 0.5);
      assert.equal(total.calls, 2);
      assert.equal(total.unpricedCalls, 1);
      assert.equal(byStudy.lawrence?.unpricedCalls, 1);
    });

    it("estimates at least the energy, CO2e and water of each call, in total and by study", () => {
      service.openStudy("agent:lead", NewStudy.parse({ id: "sherbourne", title: "Sherbourne–Castle Frank" }));
      // A call without a cost still used energy.
      for (let i = 0; i < 11; i++) service.recordActivity("agent:a", "lawrence", { kind: "usage", model: "m", inputTokens: 1000, outputTokens: 200 });
      service.recordActivity("agent:a", "sherbourne", { kind: "usage", model: "m", inputTokens: 1000, outputTokens: 200, costUsd: 0.5 });
      const { total, byStudy } = service.usage();
      const amounts = (usage?: Usage) => {
        const { atLeast, energyWh, co2eGrams, waterMl } = usage?.estimate ?? {};
        return { atLeast, energyWh, co2eGrams, waterMl };
      };
      // 11 calls are 2.64 Wh, without floating-point noise such as 2.6399999999999997.
      assert.deepEqual(amounts(byStudy.lawrence), { atLeast: true, energyWh: 2.64, co2eGrams: 0.33, waterMl: 2.86 });
      assert.deepEqual(amounts(byStudy.sherbourne), { atLeast: true, energyWh: 0.24, co2eGrams: 0.03, waterMl: 0.26 });
      assert.deepEqual(amounts(total), { atLeast: true, energyWh: 2.88, co2eGrams: 0.36, waterMl: 3.12 });
    });

    it("estimates nothing before any call", () => {
      assert.deepEqual(service.usage().total.estimate, { atLeast: true, energyWh: 0, co2eGrams: 0, waterMl: 0, basis: GEMINI_PROMPT });
    });

    it("cites the per-prompt figures it counts each call as, word for word", () => {
      const basis = service.usage().total.estimate?.basis;
      assert.deepEqual(basis?.source, {
        title: "Measuring the environmental impact of delivering AI at Google Scale",
        url: "https://arxiv.org/abs/2508.15734",
        date: "2025-08-21",
        quote: "For Google’s Gemini Apps products, a median text prompt consumes 0.24 Wh of energy, generates 0.03 gCO2e, and consumes 0.26 mL of water.",
      });
      assert.equal(basis?.co2e, "market-based");
      // Each figure the estimate uses is in the quote.
      for (const figure of [`${basis?.perCallWh} Wh`, `${basis?.perCallCo2eGrams} gCO2e`, `${basis?.perCallWaterMl} mL`]) {
        assert.ok(basis?.source.quote.includes(figure), figure);
      }
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

    it("leaves no pages behind when it can't add a context, so the id stays free", () => {
      const input = NewContext.parse({ id: "two", title: "Two pages", pages: [{ page: 1, text: "first" }, { page: 2, text: "second" }] });
      assert.throws(() => service.addContext("planner:ana", { ...input, pages: [{ page: 1, text: "first" }, { page: 1, text: "again" }] }));
      // Pages left by an attempt that never reached the log.
      service.log.db.prepare("INSERT INTO context_pages (context_id, page, text) VALUES (?, ?, ?)").run("two", 2, "stray");
      assert.equal(service.addContext("planner:ana", input).pageCount, 2);
      assert.equal(service.contextPage("two", 2), "second");
    });
  });
});

// The media agent's claim on a request, sent with each file and any failure.
const CLAIM = "claim-of-the-media-agent";

describe("engagement", () => {
  let dir: string;
  let service: Service;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-media-"));
    service = new Service(":memory:", { mediaDir: join(dir, "media") });
    seed(service);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const need = (overrides: object = {}) =>
    NewNeed.parse({
      id: "poster",
      title: "Engagement poster",
      place: "Sunnybrook Hospital",
      lon: -79.375262,
      lat: 43.722663,
      kinds: ["image"],
      reason: "Riders can now reach the hospital without a transfer.",
      citations: [{ contextId: "plan", page: 1, quote: "ridership increase of 1,680 customers" }],
      ...overrides,
    });
  const media = (overrides: object = {}) =>
    NewMedia.parse({ needId: "poster", claim: CLAIM, kind: "image", model: "gemini-3.1-flash-image", prompt: "A poster", inputs: [{ figure: "riders" }], ...overrides });
  const claim = (needId = "poster", on = service) => on.claimCreation("agent:media", "lawrence", needId, { claim: CLAIM });
  const requested = (overrides: object = {}) => {
    service.addNeed("agent:lead", "lawrence", need(overrides));
    service.requestCreation("planner:ana", "lawrence", "poster");
    claim();
  };
  const attach = (file: Uint8Array, overrides: object = {}, type?: string) =>
    service.addMedia("agent:media", "lawrence", media(overrides), { bytes: file, ...(type ? { type } : {}) });

  it("starts as needed, in the study, once its citations hold", () => {
    const added = service.addNeed("agent:lead", "lawrence", need());
    assert.equal(added.status, "needed");
    assert.deepEqual(service.viewStudy("lawrence").needs, [added]);
    rejects(() => service.addNeed("agent:lead", "lawrence", need({ id: "x", citations: [{ contextId: "plan", page: 1, quote: "nobody wants this" }] })), "quote_not_found");
    rejects(() => service.addNeed("agent:lead", "lawrence", need()), "need_exists");
    rejects(() => service.addNeed("agent:lead", "nope", need()), "not_found");
  });

  it("is made only once a planner asks, and asking again changes nothing", () => {
    service.addNeed("agent:lead", "lawrence", need());
    rejects(() => attach(SAMPLE.png), "not_requested");
    assert.equal(service.requestCreation("planner:ana", "lawrence", "poster").status, "creating");
    const head = service.log.head().seq;
    const again = service.requestCreation("planner:bo", "lawrence", "poster");
    assert.equal(again.requestedBy, "planner:ana");
    assert.equal(service.log.head().seq, head);
    rejects(() => service.requestCreation("planner:ana", "lawrence", "nope"), "not_found");
  });

  it("fails when an agent says so, and nothing more is made until a planner asks again", () => {
    const failure = { reason: "image: the image model made no image: IMAGE_SAFETY", claim: CLAIM };
    service.addNeed("agent:lead", "lawrence", need());
    rejects(() => service.failCreation("agent:media", "lawrence", "poster", failure), "not_requested");
    service.requestCreation("planner:ana", "lawrence", "poster");
    claim();
    const failed = service.failCreation("agent:media", "lawrence", "poster", failure);
    assert.deepEqual([failed.status, failed.failure, failed.failedBy], ["failed", failure.reason, "agent:media"]);
    rejects(() => service.failCreation("agent:media", "lawrence", "poster", failure), "not_requested");
    rejects(() => attach(SAMPLE.png), "not_requested");

    const head = service.log.head().seq;
    const again = service.requestCreation("planner:bo", "lawrence", "poster");
    assert.deepEqual([again.status, again.requestedBy, again.failure], ["creating", "planner:bo", undefined]);
    assert.equal(service.log.head().seq, head + 1);
    rejects(() => attach(SAMPLE.png), "not_claimed");
    claim();
    assert.equal(attach(SAMPLE.png).addedBy, "agent:media");
    assert.equal(service.viewStudy("lawrence").needs[0]?.status, "ready");
  });

  it("lets one agent at a time take on a request, until its claim lapses", () => {
    let now = new Date("2026-11-08T12:00:00.000Z");
    const timed = new Service(":memory:", { mediaDir: join(dir, "media"), clock: () => now });
    seed(timed);
    timed.addNeed("agent:lead", "lawrence", need());
    const other = { claim: "claim-of-another-agent" };
    rejects(() => timed.claimCreation("agent:media", "lawrence", "poster", { claim: CLAIM }), "not_requested");
    timed.requestCreation("planner:ana", "lawrence", "poster");
    assert.equal(timed.viewStudy("lawrence").needs[0]?.claimedBy, undefined);
    const claimed = claim("poster", timed);
    assert.deepEqual([claimed.status, claimed.claimedBy, claimed.claimedAt], ["creating", "agent:media", now.toISOString()]);
    // The log keeps the claim's hash, never the claim.
    const entry = timed.log.since(0).at(-1);
    assert.equal(entry?.type, "need.create.claimed");
    assert.deepEqual(entry?.data, { need: "poster", claim: createHash("sha256").update(CLAIM).digest("hex") });
    const head = timed.log.head().seq;
    claim("poster", timed);
    assert.equal(timed.log.head().seq, head);
    rejects(() => timed.claimCreation("agent:media", "lawrence", "poster", other), "claimed");
    rejects(() => timed.claimCreation("agent:lead", "lawrence", "poster", other), "claimed");
    rejects(() => timed.claimCreation("agent:lead", "lawrence", "poster", { claim: CLAIM }), "claimed");
    rejects(() => timed.addMedia("agent:lead", "lawrence", media(), { bytes: SAMPLE.png }), "not_claimed");
    rejects(() => timed.addMedia("agent:media", "lawrence", media({ claim: other.claim }), { bytes: SAMPLE.png }), "not_claimed");
    rejects(() => timed.failCreation("agent:lead", "lawrence", "poster", { reason: "blocked", claim: CLAIM }), "not_claimed");

    now = new Date(now.getTime() + CLAIM_MS);
    assert.equal(timed.claimCreation("agent:lead", "lawrence", "poster", other).claimedBy, "agent:lead");
    rejects(() => timed.addMedia("agent:media", "lawrence", media(), { bytes: SAMPLE.png }), "not_claimed");
    assert.equal(timed.addMedia("agent:lead", "lawrence", media({ claim: other.claim }), { bytes: SAMPLE.png }).addedBy, "agent:lead");
    // Made, so there is nothing left to claim.
    rejects(() => timed.claimCreation("agent:media", "lawrence", "poster", { claim: CLAIM }), "not_requested");
    timed.close();
  });

  it("keeps the file by its hash, outside the log, and is ready once it's attached", () => {
    requested();
    const attached = attach(SAMPLE.png, {}, "image/png");
    const sha256 = attached.id;
    assert.match(sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, "media", sha256))), SAMPLE.png);
    const entry = service.log.since(0).at(-1);
    assert.equal(entry?.type, "media.added");
    assert.deepEqual(entry?.data, {
      need: "poster",
      sha256,
      kind: "image",
      type: "image/png",
      size: SAMPLE.png.length,
      model: "gemini-3.1-flash-image",
      prompt: "A poster",
      inputs: [{ figure: "riders" }],
      label: "Illustrative",
    });
    const [ready] = service.viewStudy("lawrence").needs;
    assert.equal(ready?.status, "ready");
    assert.deepEqual(ready?.media, [attached]);
    assert.equal(attached.url, `/v1/media/${sha256}`);
    assert.equal(attached.label, "Illustrative");
    assert.deepEqual(service.mediaFile(sha256), { id: sha256, path: join(dir, "media", sha256), type: "image/png", size: SAMPLE.png.length, private: false, filename: "poster-illustrative.png" });
  });

  it("attaches the same file once", () => {
    requested();
    attach(SAMPLE.png);
    const head = service.log.head().seq;
    attach(SAMPLE.png);
    assert.equal(service.log.head().seq, head);
    assert.equal(service.viewStudy("lawrence").needs[0]?.media.length, 1);
  });

  it("tells what a file is by its bytes, not by what the upload says", () => {
    requested();
    for (const file of [SAMPLE.svg, SAMPLE.html, SAMPLE.gif, SAMPLE.heic, new Uint8Array()]) rejects(() => attach(file, {}, "image/png"), "unsupported_media");
    rejects(() => attach(SAMPLE.svg, {}, "image/svg+xml"), "unsupported_media");
    rejects(() => attach(SAMPLE.jpeg, {}, "image/png"), "type_mismatch");
    assert.equal(attach(SAMPLE.jpeg, {}, "application/octet-stream").type, "image/jpeg");
    service.addNeed("agent:lead", "lawrence", need({ id: "other" }));
    service.requestCreation("planner:ana", "lawrence", "other");
    claim("other");
    assert.equal(attach(SAMPLE.webp, { needId: "other" }, "text/plain").type, "image/webp");
    assert.equal(readdirSync(join(dir, "media")).length, 2);
  });

  it("refuses an image over 10 MB and a video over 40 MB", () => {
    requested({ kinds: ["image", "video"] });
    rejects(() => attach(padded(SAMPLE.png, 10 * 1024 * 1024 + 1)), "too_large");
    rejects(() => attach(padded(SAMPLE.mp4, 40 * 1024 * 1024 + 1), { kind: "video" }), "too_large");
    assert.equal(attach(padded(SAMPLE.mp4, 10 * 1024 * 1024 + 1), { kind: "video" }).size, 10 * 1024 * 1024 + 1);
    assert.equal(attach(padded(SAMPLE.png, 10 * 1024 * 1024)).size, 10 * 1024 * 1024);
  });

  it("attaches one file of each kind, and only from the agent holding the claim", () => {
    requested({ kinds: ["image", "video"] });
    const image = attach(SAMPLE.png);
    rejects(() => attach(SAMPLE.jpeg), "already_made");
    assert.deepEqual(attach(SAMPLE.png), image);
    rejects(() => service.addMedia("agent:replay", "lawrence", media({ kind: "video" }), { bytes: SAMPLE.mp4 }), "not_claimed");
    assert.equal(attach(SAMPLE.mp4, { kind: "video" }).kind, "video");
    rejects(() => service.addMedia("planner:ana", "lawrence", media(), { bytes: SAMPLE.jpeg }), "not_claimed");
    assert.deepEqual(service.viewStudy("lawrence").needs[0]?.media.map((m) => m.kind), ["image", "video"]);
    assert.equal(readdirSync(join(dir, "media")).length, 2);
  });

  it("refuses a kind the need didn't ask for, or a file of the other kind", () => {
    requested();
    rejects(() => attach(SAMPLE.mp4, { kind: "video" }), "kind_not_needed");
    service.addNeed("agent:lead", "lawrence", need({ id: "both", kinds: ["image", "video"] }));
    service.requestCreation("planner:ana", "lawrence", "both");
    claim("both");
    rejects(() => attach(SAMPLE.mp4, { needId: "both", kind: "image" }), "kind_mismatch");
    rejects(() => attach(SAMPLE.png, { needId: "both", kind: "video" }), "kind_mismatch");
    rejects(() => attach(SAMPLE.png, { needId: "nope" }), "unknown_need");
  });

  it("refuses inputs that aren't in the study or on the page", () => {
    requested();
    rejects(() => attach(SAMPLE.png, { inputs: [{ figure: "nope" }] }), "unknown_input");
    rejects(() => attach(SAMPLE.png, { inputs: [{ citation: { contextId: "plan", page: 1, quote: "a made-up line" } }] }), "quote_not_found");
    const cited = { citation: { contextId: "plan", page: 2, quote: "Survey feedback was overwhelmingly positive" } };
    assert.deepEqual(attach(SAMPLE.png, { inputs: [cited, { figure: "hours" }] }).inputs, [cited, { figure: "hours" }]);
  });

  it("takes no file, a planner's included, that no open request asked for", () => {
    service.addNeed("agent:lead", "lawrence", need());
    rejects(() => service.addMedia("planner:ana", "lawrence", media(), { bytes: SAMPLE.png }), "not_requested");
    service.requestCreation("planner:ana", "lawrence", "poster");
    claim();
    service.failCreation("agent:media", "lawrence", "poster", { reason: "image: blocked", claim: CLAIM });
    rejects(() => service.addMedia("planner:ana", "lawrence", media(), { bytes: SAMPLE.png }), "not_requested");
    assert.equal(service.viewStudy("lawrence").needs[0]?.status, "failed");
  });

  it("lets a planner take a file down or drop a need, and serves neither file after", () => {
    requested({ kinds: ["image", "video"] });
    const image = attach(SAMPLE.png);
    const video = attach(SAMPLE.mp4, { kind: "video" });
    const reason = { reason: "Shows a route number the plan never gives" };
    rejects(() => service.withdrawMedia("planner:ana", "lawrence", "poster", "f".repeat(64), reason), "not_found");
    const withdrawn = service.withdrawMedia("planner:ana", "lawrence", "poster", image.id, reason);
    assert.deepEqual([withdrawn.status, withdrawn.media.map((m) => m.kind), withdrawn.requestedBy], ["needed", ["video"], undefined]);
    rejects(() => service.mediaFile(image.id), "not_found");
    assert.deepEqual(readdirSync(join(dir, "media")), [video.id]);
    assert.equal(service.log.since(0).at(-1)?.type, "media.withdrawn");

    service.dismissNeed("planner:ana", "lawrence", "poster", { reason: "The change won't go ahead" });
    assert.deepEqual(service.viewStudy("lawrence").needs, []);
    rejects(() => service.mediaFile(video.id), "not_found");
    assert.deepEqual(readdirSync(join(dir, "media")), []);
    rejects(() => service.dismissNeed("planner:ana", "lawrence", "poster", reason), "not_found");
    rejects(() => service.requestCreation("planner:ana", "lawrence", "poster"), "not_found");
  });

  it("serves only files the log names", () => {
    requested();
    const { id } = attach(SAMPLE.png);
    rejects(() => service.mediaFile("f".repeat(64)), "not_found");
    rejects(() => service.mediaFile("../log.db"), "not_found");
    rmSync(join(dir, "media", id));
    rejects(() => service.mediaFile(id), "not_found");
  });

  it("keeps nothing without somewhere to keep it", () => {
    const bare = new Service(":memory:");
    seed(bare);
    bare.addNeed("agent:lead", "lawrence", need());
    bare.requestCreation("planner:ana", "lawrence", "poster");
    claim("poster", bare);
    rejects(() => bare.addMedia("agent:media", "lawrence", media(), { bytes: SAMPLE.png }), "no_media_store");
    assert.equal(bare.log.since(0).some((entry) => entry.type === "media.added"), false);
  });
});

describe("visitors", () => {
  const A = `guest:${"a".repeat(22)}`;
  const B = `guest:${"b".repeat(22)}`;
  const CANARY = "canary-7f3a9c";
  let dir: string;
  let root: Service;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-visitors-"));
    root = new Service(":memory:", { mediaDir: join(dir, "media") });
    seed(root);
    root.addNeed("agent:lead", "lawrence", need("poster"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // What a visitor does, and what the agents do for them.
  function work(view: Service, text = CANARY, file = SAMPLE.png) {
    view.recordActivity("guest:a", "lawrence", { kind: "message", text });
    view.setAssumption("guest:a", "ridership-realised", NewAssumption.parse({ value: 0.25, reason: text }));
    view.rateFinding("guest:a", "lawrence", "survey", "negative");
    view.addFigure("agent:lead", "lawrence", cited("mine", 25, 1, "cost 25 weekly service hours", text));
    view.addNeed("agent:lead", "lawrence", need("mine", text));
    view.requestCreation("guest:a", "lawrence", "poster");
    view.claimCreation("agent:media", "lawrence", "poster", { claim: CLAIM });
    view.recordActivity("agent:lead", "lawrence", { kind: "usage", model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    return view.addMedia("agent:media", "lawrence", NewMedia.parse({ needId: "poster", claim: CLAIM, kind: "image", model: "m", prompt: text }), { bytes: file });
  }

  it("never change the shared record", () => {
    const state = structuredClone(root.state);
    const studies = root.studies();
    const usage = structuredClone(root.usage());
    const head = root.log.head().seq;
    const { id } = work(root.viewFor(A));
    assert.deepEqual(root.state, state);
    assert.deepEqual(root.studies(), studies);
    // Only its spend counts, added to everyone's.
    assert.equal(root.usage().total.costUsd, usage.total.costUsd + 0.5);
    assert.equal(root.state.assumptions.get("ridership-realised")?.value, 1);
    assert.equal(root.log.since(0).length, head);
    assert.ok(root.log.since(head, 1000, A).every((entry) => entry.audience === A));
    assert.equal(root.mediaFile(id).private, true);

    const mine = root.viewFor(A);
    const lawrence = mine.viewStudy("lawrence");
    assert.ok(lawrence.figures.some((f) => f.id === "mine" && f.label === CANARY));
    assert.deepEqual(lawrence.needs.map((n) => [n.id, n.status]), [["poster", "ready"], ["mine", "needed"]]);
    assert.equal(lawrence.findings[0]?.tone, "negative");
    assert.equal(mine.state.assumptions.get("ridership-realised")?.reason, CANARY);
    assert.deepEqual(mine.usage(), root.usage());
    assert.ok(mine.state.media.has(id));
  });

  it("keep one visitor's work from another", () => {
    const { id } = work(root.viewFor(A));
    assert.deepEqual(root.viewFor(B).state, root.state);
    const theirs = work(root.viewFor(B), "theirs", SAMPLE.jpeg);
    const other = root.viewFor(B);
    const seen = JSON.stringify([...other.studies(), [...other.state.assumptions.values()], other.usage()]);
    assert.equal(seen.includes(CANARY), false);
    assert.equal(seen.includes(id), false);
    assert.ok(seen.includes("theirs") && seen.includes(theirs.id));
    assert.equal(other.state.media.has(id), false);
    assert.deepEqual(other.viewStudy("lawrence").needs[0]?.media.map((m) => m.id), [theirs.id]);
    assert.deepEqual(other.usage(), root.usage());
    assert.equal(root.viewFor(null), root);
    assert.equal(other.viewFor(null), root);
  });

  it("let a visitor use ids another visitor used, but not twice in their own sandbox", () => {
    const a = root.viewFor(A);
    const b = root.viewFor(B);
    for (const view of [a, b]) {
      view.addNeed("agent:lead", "lawrence", need("mine"));
      view.addFigure("agent:lead", "lawrence", cited("mine", 25, 1, "cost 25 weekly service hours"));
      view.addFinding("agent:lead", "lawrence", NewFinding.parse({ id: "mine", label: "Mine", text: "Mine", tone: "positive", citation: { contextId: "plan", page: 2, quote: "Survey feedback was overwhelmingly positive" } }));
    }
    rejects(() => root.viewFor(A).addNeed("agent:lead", "lawrence", need("mine")), "need_exists");
    assert.doesNotThrow(() => root.addNeed("agent:lead", "lawrence", need("mine")));
  });

  it("compare a visitor's changes with the shared record's, never another visitor's", () => {
    const from = root.log.head().seq;
    root.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 0.75, reason: "Planner's change" }));
    root.viewFor(A).setAssumption("guest:a", "ridership-realised", NewAssumption.parse({ value: 0.5, reason: "A's change" }));
    root.viewFor(B).setAssumption("guest:b", "ridership-realised", NewAssumption.parse({ value: 0.25, reason: "B's change" }));
    const to = root.log.head().seq;
    const causes = (view: Service) => {
      const [figure] = view.compare("lawrence", from, to).figures;
      return [figure?.from, figure?.to, figure?.causes.map((c) => c.reason)];
    };
    assert.deepEqual(causes(root), [40, 30, ["Planner's change"]]);
    assert.deepEqual(causes(root.viewFor(A)), [40, 20, ["Planner's change", "A's change"]]);
    assert.deepEqual(causes(root.viewFor(B)), [40, 10, ["Planner's change", "B's change"]]);
  });

  it("can't open a study, add a source, approve a skill, remove content, drop a need or take a file down", () => {
    const view = root.viewFor(A);
    const { seq } = view.recordActivity("guest:a", "lawrence", { kind: "message", text: CANARY });
    const head = root.log.head().seq;
    rejects(() => view.openStudy("guest:a", NewStudy.parse({ id: "mine", title: "Mine" })), "shared_only");
    rejects(() => view.addContext("agent:lead", NewContext.parse({ id: "mine", title: "Mine", text: CANARY })), "shared_only");
    rejects(() => view.registerSkill("agent:lead", "mine", { version: "a".repeat(64), description: "Mine" }), "shared_only");
    rejects(() => view.removeContent("agent:lead", seq, "Mine"), "shared_only");
    rejects(() => view.dismissNeed("guest:a", "lawrence", "poster", { reason: "Not wanted" }), "shared_only");
    rejects(() => view.withdrawMedia("guest:a", "lawrence", "poster", "f".repeat(64), { reason: "Not wanted" }), "shared_only");
    assert.equal(root.log.head().seq, head);
    assert.equal(root.state.contexts.has("mine"), false);
    // The shared record can't reach a visitor's entry either.
    rejects(() => root.removeContent("planner:ana", seq, "Privacy"), "not_found");
    assert.equal((root.log.get(seq, A)?.data as { text: string }).text, CANARY);
  });

  it("let a planner remove what a visitor wrote, given their audience, and show only them the removal", () => {
    const { seq } = root.viewFor(A).recordActivity("guest:a", "lawrence", { kind: "message", text: CANARY });
    const state = structuredClone(root.state);
    const shared = root.log.since(0, 1000, null).length;
    // Without their audience, or with another visitor's, it is as if nobody wrote there.
    for (const audience of [null, B]) rejects(() => root.removeContent("planner:ana", seq, "Privacy", audience), "not_found");
    const removal = root.removeContent("planner:ana", seq, "Privacy", A);
    assert.equal(removal.audience, A);
    assert.deepEqual(root.log.get(seq, A)?.data, { redacted: true });
    assert.equal(JSON.stringify(root.log.since(0, 1000, A)).includes(CANARY), false);
    assert.equal(root.log.since(0, 1000, A).at(-1)?.type, "content.removed");
    assert.equal(root.log.since(0, 1000, null).length, shared);
    assert.equal(root.log.since(0, 1000, B).some((entry) => entry.type === "content.removed"), false);
    assert.deepEqual(root.state, state);
    assert.equal(root.log.verify().ok, true);
    rejects(() => root.removeContent("planner:ana", seq, "Again", A), "already_removed");
  });

  it("skip an entry of a visitor's that the shared record doesn't allow", () => {
    const spent = root.usage().total.costUsd;
    root.log.append({ actor: "agent:lead", type: "figure.recorded", studyId: "gone", data: { id: "x" }, audience: A });
    root.viewFor(A).recordActivity("agent:lead", "lawrence", { kind: "usage", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
    const view = root.viewFor(A);
    assert.equal(view.state.studies.has("gone"), false);
    assert.equal(view.usage().total.costUsd, spent + 0.25);
  });

  it("count what agents spend for every visitor in everyone's total, added up, never by study, and the same again on restart", () => {
    const path = join(dir, "log.db");
    const first = new Service(path);
    seed(first);
    const spend = (view: Service, model: string, costUsd: number) =>
      view.recordActivity("agent:lead", "lawrence", { kind: "usage", model, inputTokens: 100, outputTokens: 10, costUsd });
    spend(first, "shared", 1);
    spend(first.viewFor(A), CANARY, 0.25);
    spend(first.viewFor(B), "theirs", 0.5);
    first.viewFor(A).recordActivity("guest:a", "lawrence", { kind: "message", text: CANARY });

    // The same totals for everyone, a visitor or not, with no visitor's apart.
    const usage = first.usage();
    for (const view of [first.viewFor(A), first.viewFor(B)]) assert.deepEqual(view.usage(), usage);
    assert.deepEqual(Object.keys(usage), ["total", "byStudy"]);
    assert.deepEqual(Object.keys(usage.byStudy), ["lawrence"]);
    const counted = ({ inputTokens, outputTokens, costUsd, calls }: Usage) => [inputTokens, outputTokens, costUsd, calls];
    assert.deepEqual(counted(usage.total), [300, 30, 1.75, 3]);
    // By study, only the shared record's call: visitors' would show where they work.
    assert.deepEqual(counted(usage.byStudy.lawrence as Usage), [100, 10, 1, 1]);
    const text = JSON.stringify(usage);
    for (const secret of [CANARY, "theirs", A, B]) assert.equal(text.includes(secret), false, secret);
    first.close();

    const second = new Service(path);
    assert.deepEqual(second.usage(), usage);
    second.close();
  });

  it("lose the files made for a need a planner drops, but keep theirs when a planner takes a shared file down", () => {
    root.addNeed("agent:lead", "lawrence", need("leaflet"));
    root.requestCreation("planner:ana", "lawrence", "leaflet");
    root.claimCreation("agent:media", "lawrence", "leaflet", { claim: CLAIM });
    const shared = root.addMedia("agent:media", "lawrence", NewMedia.parse({ needId: "leaflet", claim: CLAIM, kind: "image", model: "m", prompt: "p" }), { bytes: SAMPLE.jpeg });
    const theirs = work(root.viewFor(A), CANARY, SAMPLE.webp);
    assert.deepEqual(root.viewFor(A).viewStudy("lawrence").needs.find((n) => n.id === "poster")?.media.map((m) => m.id), [theirs.id]);

    // The shared leaflet's file goes, and the visitor's poster stays theirs.
    root.withdrawMedia("planner:ana", "lawrence", "leaflet", shared.id, { reason: "Not right" });
    rejects(() => root.mediaFile(shared.id), "not_found");
    assert.equal(root.mediaFile(theirs.id).private, true);

    // Dropping the poster drops it from the visitor's sandbox too, with their file.
    root.dismissNeed("planner:ana", "lawrence", "poster", { reason: "The change won't go ahead" });
    assert.equal(root.viewFor(A).viewStudy("lawrence").needs.some((n) => n.id === "poster"), false);
    rejects(() => root.mediaFile(theirs.id), "not_found");
    assert.deepEqual(readdirSync(join(dir, "media")), []);
  });

  it("are rebuilt from the log on restart, with the media each one made", () => {
    const path = join(dir, "log.db");
    const options = { mediaDir: join(dir, "media") };
    const first = new Service(path, options);
    seed(first);
    first.addNeed("agent:lead", "lawrence", need("poster"));
    first.addNeed("agent:lead", "lawrence", need("shared"));
    first.requestCreation("planner:ana", "lawrence", "shared");
    first.claimCreation("agent:media", "lawrence", "shared", { claim: CLAIM });
    const shared = first.addMedia("agent:media", "lawrence", NewMedia.parse({ needId: "shared", claim: CLAIM, kind: "image", model: "m", prompt: "p" }), { bytes: SAMPLE.jpeg });
    const { id } = work(first.viewFor(A));
    const state = structuredClone(first.state);
    const mine = first.viewFor(A).viewStudy("lawrence");
    first.close();

    const second = new Service(path, options);
    assert.deepEqual(second.state, state);
    assert.deepEqual(second.viewFor(A).viewStudy("lawrence"), mine);
    assert.deepEqual([second.mediaFile(id).private, second.mediaFile(shared.id).private], [true, false]);
    assert.equal(second.log.verify().ok, true);
    second.close();
  });
});

describe("restart", () => {
  it("rebuilds identical state from the log alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-agents-"));
    const path = join(dir, "log.db");
    const options = { mediaDir: join(dir, "media") };
    try {
      const first = new Service(path, options);
      seed(first);
      first.setAssumption("planner:ana", "ridership-realised", NewAssumption.parse({ value: 0.25, reason: "Stress test" }));
      first.recordDecision("planner:ana", "lawrence", NewDecision.parse({ outcome: "adopt", reason: "Strategic", decidedBy: "Ana Ruiz" }));
      const need = { title: "Engagement poster", place: "Sunnybrook Hospital", lon: -79.375262, lat: 43.722663, kinds: ["image"], reason: "Riders can now ride straight to the hospital." };
      first.addNeed("agent:lead", "lawrence", NewNeed.parse({ id: "poster", ...need }));
      first.addNeed("agent:lead", "lawrence", NewNeed.parse({ id: "asked", ...need }));
      first.addNeed("agent:lead", "lawrence", NewNeed.parse({ id: "later", ...need }));
      first.addNeed("agent:lead", "lawrence", NewNeed.parse({ id: "refused", ...need }));
      first.addNeed("agent:lead", "lawrence", NewNeed.parse({ id: "dropped", ...need }));
      first.dismissNeed("planner:ana", "lawrence", "dropped", { reason: "Not needed after all" });
      first.requestCreation("planner:ana", "lawrence", "poster");
      first.requestCreation("planner:ana", "lawrence", "asked");
      first.requestCreation("planner:ana", "lawrence", "refused");
      for (const id of ["poster", "asked", "refused"]) first.claimCreation("agent:media", "lawrence", id, { claim: CLAIM });
      first.failCreation("agent:media", "lawrence", "refused", { reason: "image: blocked", claim: CLAIM });
      const { id } = first.addMedia("agent:media", "lawrence", NewMedia.parse({ needId: "poster", claim: CLAIM, kind: "image", model: "m", prompt: "p" }), { bytes: SAMPLE.png });
      const before = first.viewStudy("lawrence");
      assert.deepEqual(before.needs.map((n) => n.status), ["ready", "creating", "needed", "failed"]);
      first.close();

      const second = new Service(path, options);
      assert.deepEqual(second.viewStudy("lawrence"), before);
      assert.equal(second.mediaFile(id).size, SAMPLE.png.length);
      assert.equal(second.log.verify().ok, true);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes twice without an error, as a service told to stop twice does", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-agents-"));
    try {
      const service = new Service(join(dir, "log.db"));
      service.close();
      assert.doesNotThrow(() => service.close());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
