import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plain } from "./plain.ts";

describe("plain", () => {
  it("drops Markdown's bold and headings, and turns list stars into bullets", () => {
    const answer =
      "## Riders\nAccording to the **Ontario Line Preliminary Design Business Case**, the figures are:\n\n* **388,000 daily trips** (ontario-line-pdbc-2020 p. 78)\n  + by 2041";
    assert.equal(
      plain(answer),
      "Riders\nAccording to the Ontario Line Preliminary Design Business Case, the figures are:\n\n• 388,000 daily trips (ontario-line-pdbc-2020 p. 78)\n  • by 2041",
    );
  });

  it("leaves plain text alone: arithmetic, dashes and hand-over lines", () => {
    const text = "For a planner to decide: adopt?\n- What the rules show: 2 * 3 = 6, a ** b\n- 40 riders per $100 (ttc-anp-2026 p. 118)";
    assert.equal(plain(text), text);
  });
});
