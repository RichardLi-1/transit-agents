import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calls, dollars, tokens, unitFor } from "./format.ts";

describe("spend screen", () => {
  it("shows cents from a dollar up, three significant figures below, and $0 for nothing", () => {
    assert.equal(dollars(0), "$0");
    assert.equal(dollars(0.01), "$0.0100");
    assert.equal(dollars(0.0421), "$0.0421");
    assert.equal(dollars(0.5), "$0.500");
    assert.equal(dollars(1), "$1.00");
    assert.equal(dollars(12.34), "$12.34");
    assert.equal(dollars(999.99), "$999.99");
  });

  it("keeps dollars to its third of the screen: <$0.01 below a cent, three figures from $1,000", () => {
    assert.equal(dollars(0.000375), "<$0.01");
    assert.equal(dollars(0.00999), "<$0.01");
    assert.equal(dollars(999.995), "$1.00K");
    assert.equal(dollars(1000), "$1.00K");
    assert.equal(dollars(1234.5), "$1.23K");
    assert.equal(dollars(12_345.67), "$12.3K");
    assert.equal(dollars(123_456.78), "$123K");
    assert.equal(dollars(999_500), "$1.00M");
    assert.equal(dollars(1_234_567), "$1.23M");
    // Never wider than $999.99, from a millionth of a dollar to a billion dollars.
    for (let usd = 1e-6; usd < 1e9; usd *= 1.07) assert.ok(dollars(usd).length <= 7, dollars(usd));
  });

  it("shortens tokens, and shows whole numbers while counting up", () => {
    assert.equal(tokens(0), "0");
    assert.equal(tokens(999), "999");
    assert.equal(tokens(12_345), "12.3K");
    assert.equal(tokens(1_243_567), "1.24M");
    assert.equal(tokens(5.53), "6");
    assert.equal(calls(1234), "1,234");
    assert.equal(calls(41.6), "42");
  });

  it("names one model call, or one token, in the singular", () => {
    assert.equal(unitFor(1, "model call", "model calls"), "model call");
    // While counting up, the count on screen is rounded.
    assert.equal(unitFor(0.6, "token", "tokens"), "token");
    assert.equal(unitFor(1.49, "token", "tokens"), "token");
    assert.equal(unitFor(1.5, "token", "tokens"), "tokens");
    assert.equal(unitFor(0, "model call", "model calls"), "model calls");
    assert.equal(unitFor(2, "model call", "model calls"), "model calls");
    assert.equal(unitFor(null, "model call", "model calls"), "model calls");
  });

  it("keeps three figures in tokens, so a count-up doesn't change width", () => {
    assert.equal(tokens(43_000), "43.0K");
    assert.equal(tokens(50_000), "50.0K");
    assert.equal(tokens(1_000_000), "1.00M");
    assert.equal(tokens(999.6), "1.00K");
    assert.equal(tokens(5), "5");
    // Counting from 38.4K to 51.2K never drops the decimal.
    for (let count = 38_400; count <= 51_200; count += 10) assert.match(tokens(count), /^\d\d\.\dK$/);
  });
});
