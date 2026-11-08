// The energy, emissions and water behind the agents' model calls, at least. Each
// call counts as Google's median Gemini Apps text prompt, measured in May 2025:
//
//   Elsworth et al. (Google), "Measuring the environmental impact of delivering
//   AI at Google Scale", arXiv:2508.15734, 21 August 2025, section 5:
//   https://arxiv.org/abs/2508.15734
//   "For Google's Gemini Apps products, a median text prompt consumes 0.24 Wh of
//   energy, generates 0.03 gCO2e, and consumes 0.26 mL of water."
//
// The emissions are market-based, which counts the clean energy Google buys:
// "We consider MB GHG emissions for all metrics presented in this paper." The
// paper gives no location-based figure per prompt. Google's post on the paper
// gives the same three figures: "How much energy does Google's AI use? We did
// the math", Amin Vahdat and Jeff Dean, Google Cloud Blog, 21 August 2025,
// https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference
//
// Our calls often carry whole documents and long answers, so each uses more
// than a median chat prompt. The estimate is a floor, never an exact figure.
import type { EstimateBasis, UsageEstimate } from "@transit-agents/contracts";

export const GEMINI_PROMPT: EstimateBasis = {
  perCallWh: 0.24,
  perCallCo2eGrams: 0.03,
  perCallWaterMl: 0.26,
  co2e: "market-based",
  source: {
    title: "Measuring the environmental impact of delivering AI at Google Scale",
    url: "https://arxiv.org/abs/2508.15734",
    date: "2025-08-21",
    // The paper sets the 2 of gCO2e as a subscript.
    quote: "For Google’s Gemini Apps products, a median text prompt consumes 0.24 Wh of energy, generates 0.03 gCO2e, and consumes 0.26 mL of water.",
  },
};

// To the millionth, which drops floating-point noise: 11 calls are 2.64 Wh, not
// 2.6399999999999997.
const times = (calls: number, perCall: number) => Math.round(calls * perCall * 1e6) / 1e6;

export const estimate = (calls: number): UsageEstimate => ({
  atLeast: true,
  energyWh: times(calls, GEMINI_PROMPT.perCallWh),
  co2eGrams: times(calls, GEMINI_PROMPT.perCallCo2eGrams),
  waterMl: times(calls, GEMINI_PROMPT.perCallWaterMl),
  basis: GEMINI_PROMPT,
});
