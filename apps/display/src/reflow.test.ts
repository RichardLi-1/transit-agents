import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitAtQuote } from "./quote.ts";
import { paragraphsOf, reflow } from "./reflow.ts";

// As pdftotext -layout gives a page: indented, spaced out, a line per printed line.
const PAGE = [
  "11 Bayview, 52 Lawrence West, 124 Sunnybrook",
  "",
  "Summary",
  "The TTC recommends a routing adjustment on the 11 Bayview, 52 Lawrence West, and",
  "124 Sunnybrook. This recommendation aims to improve customer experience and",
  "network connectivity by eliminating required transfers at Lawrence Station and",
  "Sunnybrook Hospital. This would have a particular benefit to shift-",
  "workers accessing the hospital.",
  "   •   Lawrence Avenue Corridor",
  "   •   Downsview Park",
  "",
  "Period            Streetcar          Bus",
  "Peak Periods          95     50      75      20",
  "",
  "",
  "2026 Annual Network Plan – Appendix 4: Technical Assessment                                   4",
].join("\n");

describe("reflow", () => {
  const flowed = reflow(PAGE);

  it("runs a paragraph's lines together, and keeps headings, list items and table rows on lines of their own", () => {
    assert.deepEqual(flowed.split("\n\n"), [
      "11 Bayview, 52 Lawrence West, 124 Sunnybrook",
      "Summary\n" +
        "The TTC recommends a routing adjustment on the 11 Bayview, 52 Lawrence West, and 124 Sunnybrook. This recommendation aims to " +
        "improve customer experience and network connectivity by eliminating required transfers at Lawrence Station and Sunnybrook " +
        "Hospital. This would have a particular benefit to shift-workers accessing the hospital.\n" +
        "• Lawrence Avenue Corridor\n" +
        "• Downsview Park",
      "Period    Streetcar    Bus\nPeak Periods    95    50    75    20",
      "2026 Annual Network Plan – Appendix 4: Technical Assessment    4",
    ]);
  });

  it("changes only spacing, so a quote across lines is still found", () => {
    assert.equal(flowed.replace(/\s+/g, ""), PAGE.replace(/\s+/g, ""));
    const quote = "eliminating required transfers at Lawrence Station and Sunnybrook Hospital";
    assert.equal(splitAtQuote(flowed, quote)[1], quote);
    assert.equal(splitAtQuote(flowed, "Peak Periods 95 50 75 20")[1], "Peak Periods    95    50    75    20");
  });

  it("leaves an empty page empty", () => {
    assert.equal(reflow(""), "");
    assert.equal(reflow("\n   \n"), "");
    assert.deepEqual(paragraphsOf("\n   \n", "anything"), []);
  });
});

describe("paragraphsOf", () => {
  it("marks the quote in the paragraph that holds it", () => {
    const [heading, summary, table] = paragraphsOf(PAGE, "eliminating required transfers at Lawrence Station");
    assert.deepEqual(heading, ["11 Bayview, 52 Lawrence West, 124 Sunnybrook", "", ""]);
    assert.equal(summary?.[1], "eliminating required transfers at Lawrence Station");
    assert.match(summary?.[0] ?? "", /^Summary\nThe TTC .+ network connectivity by $/s);
    assert.match(summary?.[2] ?? "", /^ and Sunnybrook Hospital\./);
    assert.deepEqual(table, ["", "", "Period    Streetcar    Bus\nPeak Periods    95    50    75    20"]);
  });

  it("marks a quote that runs into the next paragraph in both", () => {
    const parts = paragraphsOf("A first paragraph that ends here.\n\nAnd a second one.", "ends here. And a second");
    assert.deepEqual(parts, [
      ["A first paragraph that ", "ends here.", ""],
      ["", "And a second", " one."],
    ]);
  });

  it("marks nothing for a quote the page doesn't have, or none", () => {
    for (const quote of ["not on this page", ""]) {
      assert.ok(paragraphsOf(PAGE, quote).every(([, quoted, after]) => quoted === "" && after === ""));
    }
  });
});
