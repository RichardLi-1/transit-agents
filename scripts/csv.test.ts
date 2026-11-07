import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsvLine } from "./csv.ts";

describe("parseCsvLine", () => {
  it("reads quoted fields containing commas and quotes", () => {
    assert.deepEqual(parseCsvLine('1,"East - 52F Lawrence West, via ""Sunnybrook""",F'), ["1", 'East - 52F Lawrence West, via "Sunnybrook"', "F"]);
  });

  it("reads unquoted fields and empty cells", () => {
    assert.deepEqual(parseCsvLine("a,,c"), ["a", "", "c"]);
  });
});
