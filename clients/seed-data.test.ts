import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NewContext, NewNeed, NewStudy } from "@transit-agents/contracts";
import { Service } from "../services/api/src/service.ts";
import { ONTARIO_NEEDS } from "./ontario-needs.ts";
import { SOURCES, STUDIES } from "./seed-data.ts";
import { ONTARIO } from "./seed-ontario.ts";

const data = join(import.meta.dirname, "../apps/display/public/data");
const { origin } = JSON.parse(readFileSync(join(data, "network.json"), "utf8")) as { origin: { lat: number; lon: number } };
const studyLines = JSON.parse(readFileSync(join(data, "studies.json"), "utf8")) as Record<string, { lines: [number, number][][]; proposed?: [number, number][][] }>;

// Metres from the map's origin, as scripts/build-transit-data.ts places every stop
// and shape.
const project = (lon: number, lat: number): [number, number] => [
  (lon - origin.lon) * 111_320 * Math.cos((origin.lat * Math.PI) / 180),
  (lat - origin.lat) * 110_574,
];

function distanceToLine([x, y]: [number, number], line: [number, number][]): number {
  let nearest = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1] as [number, number];
    const [bx, by] = line[i] as [number, number];
    const length = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = length ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length)) : 0;
    nearest = Math.min(nearest, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return nearest;
}

describe("the replay's engagement needs", () => {
  it("give each study one or two", () => {
    for (const { study, needs } of STUDIES) assert.ok(needs.length >= 1 && needs.length <= 2, study.id);
  });

  it("each name the transit infrastructure their render shows: for bus routes, the stop and its bus", () => {
    // Without one, the media agent falls back to a station entrance for a line,
    // wherever the need is.
    for (const { study, needs, outcome } of STUDIES) {
      for (const need of [...needs, ...(outcome?.needs ?? [])]) {
        const { subject } = NewNeed.parse(need);
        assert.ok(subject, need.id);
        if (study.routes?.length) assert.equal(subject, "bus-stop", need.id);
      }
    }
  });

  it("ask the Ontario Line for its viaduct over the parkway, and a station entrance on the extension, saying which rendering is missing", () => {
    assert.equal(ONTARIO.needs, ONTARIO_NEEDS);
    assert.deepEqual(
      ONTARIO_NEEDS.map((need) => [need.id, need.title, NewNeed.parse(need).subject, need.kinds]),
      [
        ["don-valley-viaduct", "Viaduct rendering missing", "guideway", ["image", "video"]],
        ["lawrence-entrance", "Station rendering missing", "station-entrance", ["image", "video"]],
      ],
    );
  });

  it("sit on their study's line, or its proposed part", () => {
    for (const { study, needs, outcome } of STUDIES) {
      const lines = [...(studyLines[study.id]?.lines ?? []), ...(studyLines[study.id]?.proposed ?? [])];
      for (const need of [...needs, ...(outcome?.needs ?? [])]) {
        const metres = Math.min(...lines.map((line) => distanceToLine(project(need.lon, need.lat), line)));
        assert.ok(metres < 1, `${need.id} is ${metres.toFixed(1)} m from the ${study.id} line`);
      }
    }
  });

  it("cite pages that say what they claim", () => {
    const service = new Service(":memory:");
    for (const { pagesFile, ...source } of SOURCES) {
      const pages = pagesFile ? JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", pagesFile), "utf8")) : undefined;
      service.addContext("integration:seed", NewContext.parse({ ...source, ...(pages ? { pages } : {}) }));
    }
    for (const { study, needs, outcome } of STUDIES) {
      service.openStudy("agent:replay", NewStudy.parse(study));
      for (const need of needs) assert.equal(service.addNeed("agent:replay", study.id, NewNeed.parse(need)).status, "needed");
      for (const need of outcome?.dismiss ?? []) service.dismissNeed("planner:demo", study.id, need, { reason: outcome?.reason ?? "" });
      for (const need of outcome?.needs ?? []) assert.equal(service.addNeed("planner:demo", study.id, NewNeed.parse(need)).status, "needed");
    }
    service.close();
  });
});
