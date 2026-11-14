import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askedModel, modelLabel, shownModel } from "./models.ts";

const MODELS = { choices: ["gemini-3.6-flash", "gemini-3.8-flash"], default: "gemini-3.6-flash" };
const kept = (value: string | null) => ({ getItem: () => value });

describe("the agents' model, chosen in Settings", () => {
  it("asks for none until the viewer chooses, so the agents use their own default", () => {
    assert.equal(askedModel(MODELS, kept(null)), undefined);
    assert.equal(shownModel(MODELS, kept(null)), "gemini-3.6-flash");
  });

  it("asks for the viewer's choice while the service offers it", () => {
    assert.equal(askedModel(MODELS, kept("gemini-3.8-flash")), "gemini-3.8-flash");
    // Chosen on another deployment, or no longer offered: none.
    assert.equal(askedModel(MODELS, kept("qwen3.5:9b")), undefined);
    assert.equal(askedModel(undefined, kept("gemini-3.8-flash")), undefined);
  });

  it("names each model plainly", () => {
    assert.equal(modelLabel("gemini-3.6-flash"), "Gemini 3.6 Flash");
    assert.equal(modelLabel("gemini-3.5-flash-lite"), "Gemini 3.5 Flash-Lite");
    assert.equal(modelLabel("qwen3.5:9b"), "Qwen3.5 9B, on-prem");
  });
});
