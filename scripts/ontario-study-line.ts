// The Ontario Line study's line on the map, from the OpenStreetMap geometry in
// scripts/data: the line under construction, drawn like any study line, and the
// hypothetical extension up Don Mills Road, drawn as proposed. Nothing is
// scheduled on either. The geometry is © OpenStreetMap contributors, so the line
// carries that credit for the display to show beside it.
//
// build-transit-data.ts adds it to studies.json. To add it without rebuilding
// from GTFS: node scripts/ontario-study-line.ts [studies.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ONTARIO_LINE = "ontario-line-don-mills";

type Point = [number, number];
type Collection = {
  attribution: string;
  licenseUrl: string;
  features: { properties: { kind: string }; geometry: { coordinates: unknown } }[];
};

// The same flat projection as build-transit-data.ts, so the line sits on the network.
const ORIGIN = { lat: 43.7, lon: -79.4 };
const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const round1 = (n: number) => Math.round(n * 10) / 10;

const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "data", name), "utf8")) as Collection;

function lineOf(collection: Collection): Point[] {
  const feature = collection.features.find((f) => f.properties.kind === "line");
  if (!feature) throw new Error("No line in the geometry");
  return (feature.geometry.coordinates as [number, number][]).map(([lon, lat]) => [
    round1((lon - ORIGIN.lon) * METRES_PER_DEG_LON),
    round1((lat - ORIGIN.lat) * METRES_PER_DEG_LAT),
  ]);
}

export function ontarioStudyLine() {
  const building = read("ontario-line.geojson");
  const extension = read("don-mills-extension.geojson");
  return {
    lines: [lineOf(building)],
    proposed: [lineOf(extension)],
    schedule: { weekday: [], saturday: [], sunday: [] },
    credit: { text: building.attribution, url: building.licenseUrl },
  };
}

if (import.meta.main) {
  const file = process.argv[2] ?? join(import.meta.dirname, "../apps/display/public/data/studies.json");
  const studies = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  studies[ONTARIO_LINE] = ontarioStudyLine();
  writeFileSync(file, JSON.stringify(studies));
  console.log(ONTARIO_LINE, "added to", file);
}
