import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FigureView } from "@transit-agents/contracts";
import { spatialLayer } from "./spatial.ts";

const basis = (value: unknown) => ({ basis: value }) as Pick<FigureView, "basis">;

describe("a figure measured on a map layer", () => {
  it("names its layer, and no other figure has one", () => {
    assert.equal(spatialLayer(basis({ kind: "spatial", layer: "das-in-buffer", total: "zero-car households" })), "das-in-buffer");
    assert.equal(spatialLayer(basis({ kind: "spatial" })), null);
    assert.equal(spatialLayer(basis({ kind: "cited", citation: { contextId: "plan", page: 1, quote: "Riders" } })), null);
  });
});
