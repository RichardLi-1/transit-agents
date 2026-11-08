import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NewAlignment, NewAssumption, NewContext, NewFigure, NewFinding, NewStudy } from "@transit-agents/contracts";
import { RULES, SOURCES } from "../../../clients/seed-data.ts";
import { ONTARIO } from "../../../clients/seed-ontario.ts";
import { cachedNetwork, snapAlignment, START } from "./alignment.ts";
import { Service } from "./service.ts";

// The Ontario Line study as the seed records it.
function seedService() {
  const service = new Service(":memory:");
  const root = join(import.meta.dirname, "../../..");
  for (const { pagesFile, ...source } of SOURCES) {
    const pages = pagesFile ? JSON.parse(readFileSync(join(root, "clients/fixtures", pagesFile), "utf8")) : undefined;
    service.addContext("integration:seed", NewContext.parse({ ...source, ...(pages ? { pages } : {}) }));
  }
  for (const { key, ...rule } of [...RULES, ...ONTARIO.assumptions]) service.setAssumption("planner:demo", key, NewAssumption.parse(rule));
  service.openStudy("agent:replay", NewStudy.parse(ONTARIO.study));
  for (const figure of ONTARIO.figures) service.addFigure("agent:replay", ONTARIO.study.id, NewFigure.parse(figure));
  for (const finding of ONTARIO.findings) service.addFinding("agent:replay", ONTARIO.study.id, NewFinding.parse(finding));
  return service;
}

const network = cachedNetwork();

describe("alignments", () => {
  it("snaps each to the route shapes along its streets, from Don Valley station to its terminus", () => {
    const cases: [string[], string, number][] = [
      [["Don Mills Road"], "Don Mills station", 6.1],
      [["Eglinton Avenue East", "Leslie Street"], "Leslie station", 7.4],
      [["Don Mills Road"], "Lawrence and Don Mills", 1.6],
      [["Don Mills Road"], "Fairview Mall", 6.4],
      [["Don Mills Road", "Sheppard Avenue East"], "Sheppard and Victoria Park", 8.3],
    ];
    for (const [corridor, terminus, km] of cases) {
      const alignment = snapAlignment(network, corridor, terminus);
      assert.equal(alignment.lengthKm, km, terminus);
      assert.deepEqual(alignment.line[0], START);
      assert.deepEqual(alignment.line.at(-1), alignment.terminus.at);
    }
  });

  it("refuses a street with no route shape, a street that misses the start, a turn where shapes don't meet, and a terminus off the line", () => {
    assert.throws(() => snapAlignment(network, ["Bayview Avenue"], "Leslie station"), /No route shape runs along "Bayview Avenue"/);
    assert.throws(() => snapAlignment(network, ["Leslie Street"], "Leslie station"), /doesn't pass Don Valley station/);
    assert.throws(() => snapAlignment(network, ["Don Mills Road", "Victoria Park Avenue"], "Leslie station"), /isn't on Victoria Park Avenue|don't meet/);
    assert.throws(() => snapAlignment(network, ["Don Mills Road"], "Leslie station"), /Leslie station isn't on Don Mills Road/);
    assert.throws(() => snapAlignment(network, ["Don Mills Road"], "Union station"), /not a station or interchange/);
  });

  it("costs one by the study's cost per km, optimism bias and contingency, and spaces its stations as planners set", () => {
    const service = seedService();
    const option = service.proposeAlignment(
      "agent:lead",
      ONTARIO.study.id,
      NewAlignment.parse({ terminus: "Lawrence and Don Mills", corridor: ["Don Mills Road"], note: "A short first stage, meeting the 54 Lawrence East." }),
    );
    assert.equal(option.option?.lengthKm, 1.6);
    assert.equal(option.option?.costM, Math.round((613 * 1.6 * 1.64) / 1.3));
    assert.equal(option.option?.stations, 1);
    assert.deepEqual(
      option.option?.costCitations.map((c) => [c.contextId, c.page]),
      [
        ["ontario-line-ibc-2019", 77],
        ["metrolinx-bcm-vol2", 103],
      ],
    );
    assert.match(option.text, /^Alignment option C · Don Mills Rd to Lawrence and Don Mills · 1\.6 km · about \$1\.2 B \(draft\)\. Draft options for planners\./);
    assert.throws(
      () => service.proposeAlignment("agent:lead", ONTARIO.study.id, NewAlignment.parse({ terminus: "Leslie station", corridor: ["Bayview Avenue"], note: "No bus" })),
      (error: { status?: number }) => error.status === 422,
    );
  });
});
