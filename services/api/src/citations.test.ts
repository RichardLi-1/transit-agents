import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findQuote, valueInQuote } from "./citations.ts";

const PAGE = `Service Productivity
This recommendation is anticipated to cost 25 weekly service hours and is forecasted to
produce a weekly system ridership increase of 1,680 customers. This increase is due to
the removed transfers.

Table 1: Service Productivity Targets by Route Classification
Period  Streetcar  Bus
Peak Periods  95  50  75  20

The customer’s cross-
town trip is –10 minutes.`;

describe("findQuote", () => {
  it("finds a quote across a line break", () => {
    assert.equal(findQuote(PAGE, "is forecasted to produce a weekly system ridership increase of 1,680 customers"), "exact");
  });

  it("ignores case and curly quotes", () => {
    assert.equal(findQuote(PAGE, "THE CUSTOMER'S"), "exact");
  });

  it("rejoins words hyphenated across lines", () => {
    assert.equal(findQuote(PAGE, "crosstown trip"), "exact");
  });

  it("accepts a table row whose cells came back apart", () => {
    assert.equal(findQuote(PAGE, "Bus Peak Periods 75 20"), "scattered");
  });

  it("rejects an invented quote", () => {
    assert.equal(findQuote(PAGE, "ridership increase of 9,999 customers"), "none");
    assert.equal(findQuote(PAGE, "the board approved this change unanimously"), "none");
  });

  it("does not assemble a quote from words far apart on a long page", () => {
    const page = `alpha ${"filler ".repeat(200)} beta ${"filler ".repeat(200)} gamma`;
    assert.equal(findQuote(page, "alpha beta gamma"), "none");
  });

  it("rejects an empty quote", () => {
    assert.equal(findQuote(PAGE, "   "), "none");
  });
});

describe("valueInQuote", () => {
  it("matches thousands separators", () => {
    assert.equal(valueInQuote(1680, "an increase of 1,680 customers"), true);
  });

  it("ignores sign, since documents write decreases in words", () => {
    assert.equal(valueInQuote(-610, "a decrease of 610 customers"), true);
  });

  it("matches decimals and dollars", () => {
    assert.equal(valueInQuote(1.29, "net cost per passenger gained of $1.29"), true);
    assert.equal(valueInQuote(40, "gain 40 riders per $100 spent"), true);
  });

  it("does not match part of a longer number", () => {
    assert.equal(valueInQuote(68, "an increase of 1,680 customers"), false);
    assert.equal(valueInQuote(1680, "an increase of 16,800 customers"), false);
    assert.equal(valueInQuote(1, "net cost of $1.29"), false);
  });

  it("rejects a value the quote does not contain", () => {
    assert.equal(valueInQuote(2000, "an increase of 1,680 customers"), false);
  });
});
