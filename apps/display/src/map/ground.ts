// The map's own ground: metres east and north of a point in the middle of the
// city, with the same origin and scale as scripts/build-transit-data.ts, so a
// latitude and longitude land on the network's metres.

type Point = [number, number];

const ORIGIN = { lat: 43.7, lon: -79.4 };
const EAST = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const NORTH = 110_574;

export const toPoint = (lat: number, lon: number): Point => [(lon - ORIGIN.lon) * EAST, (lat - ORIGIN.lat) * NORTH];

// A point's latitude and longitude, as [lat, lon].
export const toLatLon = ([x, y]: Point): Point => [ORIGIN.lat + y / NORTH, ORIGIN.lon + x / EAST];

// The latitude the map's metres are true at.
export const GROUND_LATITUDE = ORIGIN.lat;
