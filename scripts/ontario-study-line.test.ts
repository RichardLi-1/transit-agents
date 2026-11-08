import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ONTARIO_LINE, ontarioStudyLine } from "./ontario-study-line.ts";

const studies = JSON.parse(readFileSync(join(import.meta.dirname, "../apps/display/public/data/studies.json"), "utf8"));

describe("Ontario Line study line", () => {
  const line = ontarioStudyLine();

  it("is in the display's data as the geometry gives it", () => {
    assert.deepEqual(studies[ONTARIO_LINE], line);
  });

  it("draws the extension on from the end of the line, as proposed", () => {
    assert.deepEqual(line.proposed[0]?.[0], line.lines[0]?.at(-1));
    assert.ok(line.proposed[0]?.length);
  });

  it("credits OpenStreetMap", () => {
    assert.equal(line.credit.text, "© OpenStreetMap contributors");
    assert.equal(line.credit.url, "https://www.openstreetmap.org/copyright");
  });
});
