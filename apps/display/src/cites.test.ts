import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withCites } from "./cites.ts";

describe("withCites", () => {
  const ids = ["ttc-anp-2026", "ontario-line-pdbc-2020", "ttc-standards-2024"];

  it("splits out each page a known source is cited at", () => {
    assert.deepEqual(withCites("1,680 a week (ttc-anp-2026 p. 118), and 388,000 trips (ontario-line-pdbc-2020 pp. 78-79).", ids), [
      "1,680 a week (",
      { contextId: "ttc-anp-2026", page: 118, text: "ttc-anp-2026 p. 118" },
      "), and 388,000 trips (",
      { contextId: "ontario-line-pdbc-2020", page: 78, text: "ontario-line-pdbc-2020 pp. 78" },
      "-79).",
    ]);
  });

  it("leaves text alone that names no known source", () => {
    assert.deepEqual(withCites("Tail track (PDBC p. 60), and (other-doc p. 3).", ids), ["Tail track (PDBC p. 60), and (other-doc p. 3)."]);
    assert.deepEqual(withCites("Nothing cited.", []), ["Nothing cited."]);
  });

  it("matches a whole id, not one inside another word", () => {
    assert.deepEqual(withCites("(xttc-anp-2026 p. 1)", ids), ["(xttc-anp-2026 p. 1)"]);
  });
});
