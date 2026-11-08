import type { Camera } from "./engine.ts";

// Where to stand for each study. The line runs away from the viewer into the fade.
export const VIEWS: Record<string, Camera> = {
  // Far enough along that the hospital clears the time bar on a laptop screen.
  "lawrence-sunnybrook": { x: -2200, y: 2900, distance: 13000, pitch: 1.2, bearing: -1.5 },
  "sherbourne-castle-frank": { x: 2300, y: -4300, distance: 6200, pitch: 1.18, bearing: -0.25 },
  // Looking north from downtown: the whole Ontario Line in front, rising to the
  // proposed extension up Don Mills Road. Looking south from Don Mills instead put
  // the line itself on the horizon, a hairline under the folders.
  "ontario-line-don-mills": { x: 1200, y: -300, distance: 27000, pitch: 0.8, bearing: 0.35 },
};
export const OVERVIEW: Camera = { x: -1500, y: 1500, distance: 26000, pitch: 1.15, bearing: -0.3 };

// TTC Signage and Wayfinding Standards, November 2023, section 3.3 Colour (in
// City of Toronto background file 258834, a TTC Board report, 2025):
// https://www.toronto.ca/legdocs/mmis/2025/ttc/bgrd/backgroundfile-258834.pdf
// TTC Red, Pantone 485, RGB 218 37 29, is for the TTC logo and local routes.
export const TTC_RED = "da251d";
// The same manual's line colours, by line number. Line 3 Blue, Pantone 2194,
// RGB 0 130 201, is the colour of Line 3, the number the TTC gives the Ontario
// Line. Metrolinx has not published a final colour for it.
export const LINE_COLORS: Record<string, string> = {
  "1": "f8c300",
  "2": "00923f",
  "3": "0082c9",
  "4": "a21a68",
  "5": "eb8738",
  "6": "969594",
};

// Each study's line is drawn in the colour riders know it by: the Ontario Line in
// Line 3 Blue, a bus route in TTC Red.
export const STUDY_COLORS: Record<string, string> = {
  "lawrence-sunnybrook": TTC_RED,
  "sherbourne-castle-frank": TTC_RED,
  "ontario-line-don-mills": LINE_COLORS["3"] as string,
};
export const studyColor = (line: string | null | undefined) => (line && STUDY_COLORS[line]) || "b03488";
