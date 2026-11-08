// Plays the seed data through the service, as seed.ts, replay.ts and decide.ts do
// over HTTP. A quote that drifts from its page, or a value its quote doesn't hold,
// fails here rather than in a demo.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Citation, NewAssumption, NewCheck, NewContext, NewDecision, NewFigure, NewFinding, NewStudy } from "@transit-agents/contracts";
import { RULES, SOURCES, STUDIES } from "../clients/seed-data.ts";
import { GAP, METROLINX_RULES, ONTARIO } from "../clients/seed-ontario.ts";
import { Service } from "../services/api/src/service.ts";
import { citedQuotes } from "./cited-pages.ts";

const root = join(import.meta.dirname, "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("seed data", () => {
  const service = new Service(":memory:");
  for (const { pagesFile, ...source } of SOURCES) {
    const pages = pagesFile ? read(`clients/fixtures/${pagesFile}`) : undefined;
    service.addContext("integration:seed", NewContext.parse({ ...source, ...(pages ? { pages } : {}) }));
  }
  for (const { key, ...rule } of [...RULES, ...STUDIES.flatMap((s) => s.assumptions)]) {
    service.setAssumption("planner:demo", key, NewAssumption.parse(rule));
  }

  for (const seed of STUDIES) {
    it(`${seed.study.id}: every figure, check and finding passes the service's checks`, () => {
      const id = seed.study.id;
      service.openStudy("agent:replay", NewStudy.parse(seed.study));
      for (const figure of seed.figures) service.addFigure("agent:replay", id, NewFigure.parse(figure));
      for (const check of seed.checks) service.addCheck("agent:replay", id, NewCheck.parse(check));
      for (const finding of seed.findings) service.addFinding("agent:replay", id, NewFinding.parse(finding));
      if (seed.decision) {
        for (const finding of seed.findings) service.rateFinding("planner:demo", id, finding.id, finding.tone);
        service.recordDecision("planner:demo", id, NewDecision.parse(seed.decision));
      }
      const view = service.viewStudy(id);
      assert.equal(view.figures.length, seed.figures.length);
      for (const figure of view.figures) assert.ok(Number.isFinite(figure.value), `${figure.id} is ${figure.value}`);
    });
  }

  it("leaves the Ontario Line study to planners", () => {
    const view = service.viewStudy(ONTARIO.study.id);
    assert.equal(view.decision, undefined);
    assert.ok(view.findings.every((f) => f.tone === "unrated"));
  });

  it("flags the Ontario Line's gaps as what's missing, then the next step, then who to contact", () => {
    const gaps = ONTARIO.findings.filter((finding) => GAP.test(finding.text)).map((finding) => finding.id);
    for (const gap of ["cost-precedent", "riders-model", "east-don-crossing", "don-mills-road"]) assert.ok(gaps.includes(gap), gap);
  });

  it("puts optimism bias in place of the contingency, as Table 5.6 does without a cost-risk analysis", () => {
    const view = service.viewStudy(ONTARIO.study.id);
    const value = (id: string) => view.figures.find((f) => f.id === id)?.value ?? NaN;
    // $613 M a km for 6 km holds a 30% contingency; the 64% replaces it, not adds to it.
    assert.equal(value("ext-capital-cost-ob").toFixed(2), ((613 * 6 * 1.64) / 1.3).toFixed(2));
  });

  it("boxes the number of every Ontario Line figure and rule on its page", () => {
    const highlights = read("apps/display/public/sources/highlights.json") as Record<string, { cell?: unknown }>;
    const valued: Citation[] = [
      ...METROLINX_RULES.flatMap((rule) => (rule.citation ? [rule.citation] : [])),
      ...ONTARIO.figures.flatMap((figure) => (figure.basis.kind === "cited" ? [figure.basis.citation] : [])),
    ];
    for (const { contextId, page, quote } of valued) assert.ok(highlights[`${contextId}|${page}|${quote}`]?.cell, `${contextId} p. ${page}: ${quote}`);
  });

  // So a cited page opens as the page itself, never as its text.
  it("has a page image and highlight for every quote a rule, figure, check, finding, decision, need or hand-over cites", () => {
    const highlights = read("apps/display/public/sources/highlights.json") as Record<string, { boxes: unknown[] }>;
    const cited = citedQuotes();
    const needs = STUDIES.flatMap((seed) => [...seed.needs, ...(seed.outcome?.needs ?? [])]);
    for (const { contextId, page, quote } of needs.flatMap((need) => need.citations ?? [])) {
      assert.ok(cited.some((c) => c.contextId === contextId && c.page === page && c.quote === quote), `${contextId} p. ${page}: ${quote}`);
    }
    assert.ok(cited.some((c) => c.contextId === "ttc-anp-2026" && c.page === 115 && c.quote.includes("discretionary recommendations")));
    for (const { contextId, page, quote } of cited) {
      assert.ok(existsSync(join(root, `apps/display/public/sources/${contextId}/p${page}.webp`)), `${contextId} p. ${page}`);
      assert.ok(highlights[`${contextId}|${page}|${quote}`]?.boxes.length, `${contextId} p. ${page}: ${quote}`);
    }
  });
});
