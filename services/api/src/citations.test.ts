import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkValue, findQuote } from "./citations.ts";

const PAGE = `Service Productivity
This recommendation is anticipated to cost 25 weekly service hours and is forecasted to
produce a weekly system ridership increase of 1,680 customers. This increase is due to
the removed transfers.

Table 1: Service Productivity Targets by Route Classification
Period  Streetcar  Bus
Peak Periods  95  50  75  20

The customer’s cross-
town trip is –10 minutes. The final recommendation is that this proposal is not adopted
as a component of the TTC network.`;

describe("findQuote", () => {
  it("finds a quote across a line break", () => {
    assert.equal(findQuote(PAGE, "is forecasted to produce a weekly system ridership increase of 1,680 customers"), "exact");
  });

  it("ignores case and curly quotes, and rejoins hyphenated words", () => {
    assert.equal(findQuote(PAGE, "THE CUSTOMER'S crosstown trip"), "exact");
  });

  it("refuses reordered prose, so 'not adopted' can't become 'adopted'", () => {
    assert.equal(findQuote(PAGE, "this proposal is adopted"), "none");
    assert.equal(findQuote(PAGE, "the proposal is not adopted"), "none");
  });

  it("allows a table row with gaps, in order", () => {
    assert.equal(findQuote(PAGE, "Peak Periods 95 75 20"), "table");
  });

  it("refuses a table row out of order", () => {
    assert.equal(findQuote(PAGE, "Peak Periods 20 75 95"), "none");
  });

  it("finds a sentence that runs onto the next page", () => {
    assert.equal(findQuote("issues on the 52 Lawrence West could be", "expanded to affect customers", "x"), "none");
    assert.equal(findQuote("issues on the 52 Lawrence West could be", "could be expanded to affect customers", "expanded to affect customers"), "exact");
  });

  it("refuses a quote that sits wholly on the next page", () => {
    assert.equal(findQuote("first page text", "second page sentence", "second page sentence here"), "none");
  });

  it("rejects an invented quote and an empty one", () => {
    assert.equal(findQuote(PAGE, "ridership increase of 9,999 customers"), "none");
    assert.equal(findQuote(PAGE, "   "), "none");
  });
});

describe("checkValue", () => {
  it("matches thousands separators and decimals", () => {
    assert.deepEqual(checkValue(1680, "an increase of 1,680 customers"), { ok: true });
    assert.deepEqual(checkValue(1.29, "net cost per passenger gained of $1.29"), { ok: true });
  });

  it("does not match part of a longer number", () => {
    assert.equal(checkValue(68, "an increase of 1,680 customers").ok, false);
    assert.equal(checkValue(1680, "an increase of 16,800 customers").ok, false);
  });

  it("reads numbers written as words", () => {
    assert.deepEqual(checkValue(12, "the standard of twelve new customer trips"), { ok: true });
  });

  it("requires wording for a negative value", () => {
    assert.deepEqual(checkValue(-610, "a decrease of 610 customers"), { ok: true });
    assert.deepEqual(checkValue(-50470, "net savings in weighted customer travel time of 50,470 weekly minutes"), { ok: true });
    assert.deepEqual(checkValue(-1.2, "net cost per passenger gained of ($1.20)"), { ok: true });
    assert.equal(checkValue(-18940, "net increase in weighted customer travel time of 18,940 weekly minutes").ok, false);
  });

  it("refuses a positive value for a decrease, which would flip a test", () => {
    assert.equal(checkValue(610, "a decrease of 610 customers").ok, false);
    assert.equal(checkValue(50470, "net savings in weighted customer travel time of 50,470 weekly minutes").ok, false);
  });

  it("takes only the last cell of a table row, however it matched", () => {
    assert.deepEqual(checkValue(20, "Peak Periods 95 50 75 20", "table"), { ok: true });
    assert.equal(checkValue(95, "Peak Periods 95 50 75 20", "table").ok, false);
    assert.equal(checkValue(75, "Peak Periods 95 50 75 20", "exact").ok, false);
  });

  it("reads a hyphen between numbers as a range, not a minus sign", () => {
    assert.deepEqual(checkValue(12, "twelve routes in 2026-2027"), { ok: true });
    assert.deepEqual(checkValue(-10, "the change is -10 minutes"), { ok: true });
  });
});
