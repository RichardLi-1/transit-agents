// Buttons that zoom, pan, turn and tilt the map a step at a time, for anyone who
// can't drag, pinch or twist, or has no keyboard.
import type { MapControls, Step } from "./controls.ts";

const glyph = { fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

// Each button's step, which also names its place in the pad, its name and its
// icon. The order is the tab order.
const BUTTONS: [Step, string, string][] = [
  ["in", "Zoom in", "M8 3.5v9M3.5 8h9"],
  ["out", "Zoom out", "M3.5 8h9"],
  ["up", "Pan up", "M4.5 10l3.5-3.5 3.5 3.5"],
  ["left", "Pan left", "M10 4.5L6.5 8l3.5 3.5"],
  ["right", "Pan right", "M6 4.5L9.5 8 6 11.5"],
  ["down", "Pan down", "M4.5 6l3.5 3.5 3.5-3.5"],
  ["turn-left", "Turn left", "M12 11a4 4 0 0 0-8 0M2.5 9.5L4 11l1.5-1.5"],
  ["turn-right", "Turn right", "M4 11a4 4 0 0 1 8 0M10.5 9.5L12 11l1.5-1.5"],
  ["tilt-up", "Tilt up", "M5.5 4.5h5l2.5 7h-10z"],
  ["tilt-down", "Tilt down", "M3.5 4.5h9v7h-9z"],
];

// A flat map doesn't tilt, so it has no tilt buttons.
export function MapButtons({ controls, flat }: { controls: MapControls; flat: boolean }) {
  const buttons = flat ? BUTTONS.filter(([step]) => !step.startsWith("tilt")) : BUTTONS;
  return (
    <div class="map-buttons" role="group" aria-label="Map controls">
      {buttons.map(([step, name, path]) => (
        <button key={step} type="button" style={{ gridArea: step }} aria-label={name} title={name} onClick={() => controls.nudge(step)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d={path} {...glyph} />
          </svg>
        </button>
      ))}
    </div>
  );
}
