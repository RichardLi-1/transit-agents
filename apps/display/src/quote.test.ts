import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitAtQuote } from "./quote.ts";

const marked = (text: string, quote: string) => splitAtQuote(text, quote)[1];

describe("splitAtQuote", () => {
  it("finds a quote across line breaks, spacing and case", () => {
    const page = "The extension would add a weekly system\n   ridership increase of 1,680 Customers, at a cost of";
    assert.deepEqual(splitAtQuote(page, "weekly system ridership increase of 1,680 customers"), [
      "The extension would add a ",
      "weekly system\n   ridership increase of 1,680 Customers",
      ", at a cost of",
    ]);
  });

  it("reads a table row along its spaced-out columns", () => {
    const page = "Route class        AM    Mid   PM    Eve\n  Peak Periods        95      50      75      20\n";
    assert.equal(marked(page, "Peak Periods 95 50 75 20"), "Peak Periods        95      50      75      20");
  });

  it("treats curly and straight quotes, dashes and ligatures alike", () => {
    assert.equal(marked("the TTC’s “base network” – all day", `TTC's "base network" - all`), "TTC’s “base network” – all");
    assert.equal(marked("a beneﬁt to service", "benefit to"), "benefit to");
  });

  it("takes a quote's other characters as they are", () => {
    assert.equal(marked("gain 11 riders per $100 (net) spent", "riders per $100 (net)"), "riders per $100 (net)");
    assert.equal(marked("riders per 100 spent", "riders per $100"), "");
  });

  it("leaves the page whole when the quote isn't there", () => {
    assert.deepEqual(splitAtQuote("Nothing like it.", "weekly ridership"), ["Nothing like it.", "", ""]);
    assert.deepEqual(splitAtQuote("Anything.", "  "), ["Anything.", "", ""]);
  });
});
