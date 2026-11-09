// A figure the GIS service measured on a map layer has the basis
// { kind: "spatial", layer, total }: it cites the layer's dataset, not a page.
import type { FigureView } from "@transit-agents/contracts";

// The layer it was measured on, or null for any other figure.
export function spatialLayer(figure: Pick<FigureView, "basis">): string | null {
  const basis = figure.basis as { kind: string; layer?: unknown };
  return basis.kind === "spatial" && typeof basis.layer === "string" ? basis.layer : null;
}
