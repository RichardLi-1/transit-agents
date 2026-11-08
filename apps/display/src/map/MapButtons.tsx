// Zoom a step at a time, and back to the study, for anyone who can't pinch or
// scroll. Panning, turning and tilting are a drag, or the arrow keys (with Shift)
// once the map has focus, so they need no buttons of their own.
import type { MapControls } from "./controls.ts";

const glyph = { fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

export function MapButtons({ controls, onReset }: { controls: MapControls; onReset: (event: MouseEvent) => void }) {
  return (
    <div class="map-buttons" role="group" aria-label="Map controls">
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => controls.nudge("in")}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 3.5v9M3.5 8h9" {...glyph} />
        </svg>
      </button>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => controls.nudge("out")}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3.5 8h9" {...glyph} />
        </svg>
      </button>
      <button type="button" aria-label="Reset view" title="Reset view" onClick={onReset}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r="4.5" {...glyph} />
          <path d="M8 1.5v2.5M8 12v2.5M1.5 8h2.5M12 8h2.5" {...glyph} />
        </svg>
      </button>
    </div>
  );
}
