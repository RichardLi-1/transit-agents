import type { Camera } from "./engine.ts";

// Where to stand for each study. The line runs away from the viewer into the fade.
export const VIEWS: Record<string, Camera> = {
  // Far enough along that the hospital clears the time bar on a laptop screen.
  "lawrence-sunnybrook": { x: -2200, y: 2900, distance: 13000, pitch: 1.2, bearing: -1.5 },
  "sherbourne-castle-frank": { x: 2300, y: -4300, distance: 6200, pitch: 1.18, bearing: -0.25 },
  // Looking south down Don Mills Road: the proposed extension in front, and the
  // line under construction running away toward downtown.
  "ontario-line-don-mills": { x: 3800, y: 4200, distance: 12500, pitch: 1.2, bearing: -3.14 },
};
export const OVERVIEW: Camera = { x: -1500, y: 1500, distance: 26000, pitch: 1.15, bearing: -0.3 };
