// Layers as the GIS service will list them, for tests and screenshots until it
// does: stops up Don Mills Road, a 400 m buffer round them, the dissemination
// areas the buffer touches, and the corridor. Never part of the display's build.
import type { Feature, FeatureCollection, Layer } from "./layers.ts";

const STOPS: [string, number, number][] = [
  ["Science Centre", 43.7255, -79.3378],
  ["Lawrence Ave E", 43.7446, -79.3418],
  ["Lawrence Ave E (north side)", 43.7478, -79.3426],
  ["York Mills Rd", 43.7581, -79.3466],
  ["Graydon Hall Dr", 43.7652, -79.3472],
  ["Sheppard Ave E", 43.7752, -79.3462],
];

const point = ([name, lat, lon]: [string, number, number]): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { name },
});

// A circle of `metres` round a place, as a buffer operation would give it.
function circle(lat: number, lon: number, metres: number, sides = 32): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    ring.push([lon + (metres * Math.cos(a)) / (111_320 * Math.cos((lat * Math.PI) / 180)), lat + (metres * Math.sin(a)) / 110_574]);
  }
  return ring;
}

const box = (west: number, south: number, east: number, north: number) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

const DATA_AREAS: [string, number, number, number, number][] = [
  ["35204831", -79.3445, 43.7400, -79.3385, 43.7455],
  ["35204832", -79.3462, 43.7455, -79.3392, 43.7505],
  ["35204755", -79.3500, 43.7545, -79.3430, 43.7612],
  ["35204756", -79.3505, 43.7612, -79.3440, 43.7680],
  ["35204690", -79.3500, 43.7718, -79.3425, 43.7785],
];

export const FIXTURE_GEOJSON: Record<string, FeatureCollection> = {
  "don-mills-stops": { type: "FeatureCollection", features: STOPS.map(point) },
  "don-mills-stops-400m": {
    type: "FeatureCollection",
    features: STOPS.map(([name, lat, lon]) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [circle(lat, lon, 400)] }, properties: { name } })),
  },
  "das-in-buffer": {
    type: "FeatureCollection",
    features: DATA_AREAS.map(([id, w, s, e, n]) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [box(w, s, e, n)] }, properties: { dauid: id } })),
  },
  "don-mills-corridor": {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "LineString", coordinates: STOPS.map(([, lat, lon]) => [lon, lat]) }, properties: { name: "Don Mills Rd" } }],
  },
};

const AT = "2026-11-09T14:02:00.000Z";
const GTFS = { id: "ttc-gtfs", title: "TTC Routes and Schedules", publisher: "Toronto Transit Commission", licence: "Open Government Licence – Toronto", url: "https://open.toronto.ca/dataset/ttc-routes-and-schedules/", retrieved: "2026-11-02" };
const CENSUS = { id: "statcan-da-2021", title: "Dissemination area boundaries, 2021", publisher: "Statistics Canada", licence: "Statistics Canada Open Licence", url: "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-eng.cfm", retrieved: "2026-11-02" };

export const FIXTURE_LAYERS: Layer[] = [
  { id: "don-mills-stops", title: "Don Mills Rd stops", kind: "points", color: "#d1495b", featureCount: 6, bbox: [-79.3472, 43.7255, -79.3378, 43.7752], dataset: GTFS, createdBy: "agent:lead", at: AT },
  { id: "don-mills-stops-400m", title: "Stops, 400 m buffer", kind: "polygons", color: "#7b4fa0", featureCount: 6, bbox: [-79.3522, 43.7219, -79.3328, 43.7788], derivedFrom: ["don-mills-stops"], operation: { name: "buffer", params: { metres: 400 } }, createdBy: "agent:lead", at: AT },
  { id: "das-in-buffer", title: "Dissemination areas in buffer", kind: "polygons", color: "#2a8c7e", featureCount: 5, bbox: [-79.3505, 43.74, -79.3385, 43.7785], dataset: CENSUS, derivedFrom: ["don-mills-stops-400m"], operation: { name: "intersects", params: {} }, createdBy: "agent:lead", at: AT },
  { id: "don-mills-corridor", title: "Don Mills corridor", kind: "lines", color: "#3f7cac", featureCount: 1, bbox: [-79.3472, 43.7255, -79.3378, 43.7752], derivedFrom: ["don-mills-stops"], createdBy: "agent:lead", at: AT },
];
