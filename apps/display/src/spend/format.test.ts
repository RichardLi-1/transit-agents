import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EstimateBasis } from "@transit-agents/contracts";
import { aboutEstimate, calls, co2e, dollars, energy, tokens, unitFor } from "./format.ts";

// A number and its unit are kept together by narrow spaces that don't break.
const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");

const BASIS: EstimateBasis = {
  perCallWh: 0.24,
  perCallCo2eGrams: 0.03,
  perCallWaterMl: 0.26,
  co2e: "market-based",
  source: {
    title: "Measuring the environmental impact of delivering AI at Google Scale",
    url: "https://arxiv.org/abs/2508.15734",
    date: "2025-08-21",
    quote: "For Google’s Gemini Apps products, a median text prompt consumes 0.24 Wh of energy, generates 0.03 gCO2e, and consumes 0.26 mL of water.",
  },
};

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

  it("shows energy as an estimate in three figures, stepping up from Wh to kWh", () => {
    assert.equal(plain(energy(0)), "0 Wh");
    assert.equal(plain(energy(0.24)), "≈ 0.240 Wh");
    assert.equal(plain(energy(2.4)), "≈ 2.40 Wh");
    assert.equal(plain(energy(26.4)), "≈ 26.4 Wh");
    assert.equal(plain(energy(240)), "≈ 240 Wh");
    assert.equal(plain(energy(999.6)), "≈ 1.00 kWh");
    assert.equal(plain(energy(2_400)), "≈ 2.40 kWh");
    assert.equal(plain(energy(2_400_000)), "≈ 2.40 MWh");
    assert.match(energy(2.4), /^≈\u202f2\.40\u202fWh$/);
  });

  it("keeps energy to its column on a phone, as <0.1 Wh while counting up from nothing", () => {
    assert.equal(plain(energy(0.0024)), "<0.1 Wh");
    assert.equal(plain(energy(0.0999)), "<0.1 Wh");
    // Never longer than one call's ≈ 0.240 Wh, up to a billion calls.
    for (let wh = 1e-5; wh < 2.4e8; wh *= 1.07) assert.ok(energy(wh).length <= energy(0.24).length, energy(wh));
  });

  it("writes CO2e in three figures from grams to tonnes, never broken from its unit", () => {
    assert.equal(plain(co2e(0)), "0 g CO₂e");
    assert.equal(plain(co2e(0.005)), "<0.01 g CO₂e");
    assert.equal(plain(co2e(0.03)), "0.0300 g CO₂e");
    assert.equal(plain(co2e(0.3)), "0.300 g CO₂e");
    assert.equal(plain(co2e(1_234)), "1.23 kg CO₂e");
    assert.equal(plain(co2e(3_000_000)), "3.00 t CO₂e");
    assert.doesNotMatch(co2e(0.3), / /);
  });

  it("describes energy as an estimate and a floor, with its source's title, month and words", () => {
    assert.equal(
      aboutEstimate(BASIS),
      "Estimate, at least: each model call counted as one median prompt. CO₂e is market-based. " +
        "From Measuring the environmental impact of delivering AI at Google Scale, August 2025: " +
        "“For Google’s Gemini Apps products, a median text prompt consumes 0.24 Wh of energy, generates 0.03 gCO2e, and consumes 0.26 mL of water.”",
    );
  });
});
