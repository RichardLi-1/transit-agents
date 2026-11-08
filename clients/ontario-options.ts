// Two draft alignments for the Ontario Line's extension north, for planners to
// choose between. Each is traced from TTC route shapes in the display's network
// data (apps/display/public/data/network.bin, built from the TTC's GTFS feed):
//
//   A  Don Mills Road, along the 25 Don Mills, from Don Valley station north to
//      Don Mills station on Line 4. The study's own extension.
//   B  Leslie Street, from Don Valley station west along Eglinton to Leslie Street
//      and north along the 51 Leslie to Leslie station on Line 4. Hypothetical.
//
// Each length is measured along its line. Each cost is the study's own formula,
// cost per km × length × (1 + optimism bias / 100) ÷ (1 + contingency / 100), with
// $613 M a km (IBC p. 77), 64% optimism bias (BCM p. 103) and 30% contingency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFinding } from "@transit-agents/contracts";

type LonLat = [number, number];

const DATA = join(import.meta.dirname, "../apps/display/public/data");
const ORIGIN = { lat: 43.7, lon: -79.4 };
const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

const IBC = "ontario-line-ibc-2019";
const MANUAL = "metrolinx-bcm-vol2";
const cite = (contextId: string, page: number, quote: string) => ({ contextId, page, quote });
const COST_PER_KM = { value: 613, citation: cite(IBC, 77, "Cost per km $832 M to $999 M $613 M") };
const OPTIMISM_BIAS = { value: 64, citation: cite(MANUAL, 103, "OB 64%") };
const CONTINGENCY = 30;

// Where the options start and end: Don Valley station, as the study's line has it,
// and Line 4's two eastern stations, as the network draws them.
const DON_VALLEY: LonLat = [-79.338694, 43.721443];
const DON_MILLS: LonLat = [-79.34724, 43.77504];

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const metres = ([lon, lat]: LonLat) => [(lon - ORIGIN.lon) * METRES_PER_DEG_LON, (lat - ORIGIN.lat) * METRES_PER_DEG_LAT] as const;
const distance = (a: LonLat, b: LonLat) => {
  const [ax, ay] = metres(a);
  const [bx, by] = metres(b);
  return Math.hypot(bx - ax, by - ay);
};
export const lengthOf = (line: LonLat[]) => line.reduce((sum, p, i) => (i ? sum + distance(line[i - 1] as LonLat, p) : 0), 0);

// A route's longest shape, as longitude and latitude.
function shapeOf(routeId: string): LonLat[] {
  const meta = JSON.parse(readFileSync(join(DATA, "network.json"), "utf8")) as {
    unitMetres: number;
    routes: { id: string }[];
    polylines: { route: number; start: number; count: number }[];
  };
  const bytes = readFileSync(join(DATA, "network.bin"));
  const coordinates = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  const route = meta.routes.findIndex((r) => r.id === routeId);
  const [longest] = meta.polylines.filter((p) => p.route === route).sort((a, b) => b.count - a.count);
  if (!longest) throw new Error(`No shape for route ${routeId}`);
  return Array.from({ length: longest.count }, (_, i): LonLat => {
    const x = (coordinates[(longest.start + i) * 2] as number) * meta.unitMetres;
    const y = (coordinates[(longest.start + i) * 2 + 1] as number) * meta.unitMetres;
    return [round6(x / METRES_PER_DEG_LON + ORIGIN.lon), round6(y / METRES_PER_DEG_LAT + ORIGIN.lat)];
  });
}

const nearest = (shape: LonLat[], to: LonLat) => shape.reduce((best, p, i) => (distance(p, to) < distance(shape[best] as LonLat, to) ? i : best), 0);

// The part of a shape between the points nearest two places, in order.
const between = (shape: LonLat[], from: LonLat, to: LonLat) => shape.slice(nearest(shape, from), nearest(shape, to) + 1);

// A: north along the 25 Don Mills, from Eglinton to Sheppard, then into Don Mills
// station.
// The bus comes up from south of Eglinton, so the line takes its points north of
// the station.
const DON_MILLS_LINE: LonLat[] = [
  DON_VALLEY,
  ...between(shapeOf("25"), DON_VALLEY, [-79.3465, 43.7735]).filter(([, lat]) => lat > DON_VALLEY[1]),
  DON_MILLS,
];

// B: west along Eglinton, where the 51 Leslie turns north, then north along it to
// Sheppard, at Leslie station.
const LESLIE_LINE: LonLat[] = [DON_VALLEY, ...between(shapeOf("51"), [-79.35, 43.7171], [-79.3642, 43.7717])];

const costOf = (km: number) => (COST_PER_KM.value * km * (1 + OPTIMISM_BIAS.value / 100)) / (1 + CONTINGENCY / 100);

// A point on a line, this share of the way along it.
function along(line: LonLat[], share: number): LonLat {
  let left = lengthOf(line) * share;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1] as LonLat, line[i] as LonLat];
    const step = distance(a, b);
    if (left <= step) return [round6(a[0] + ((b[0] - a[0]) * left) / step), round6(a[1] + ((b[1] - a[1]) * left) / step)];
    left -= step;
  }
  return line.at(-1) as LonLat;
}

const money = (millions: number) => `about $${(millions / 1000).toFixed(1)} B`;

type Draft = { id: string; letter: string; follows: string; street: string; line: LonLat[]; station: { name: string; at: LonLat }; why: string; pin: number };

function option({ id, letter, follows, street, line, station, why, pin }: Draft): NewFinding {
  const km = Math.round(lengthOf(line) / 100) / 10;
  // On the length as shown, to a tenth of a km, so the card's sum can be checked.
  const costM = Math.round(costOf(km));
  const [lon, lat] = along(line, pin);
  return {
    id,
    label: `Alignment option ${letter}`,
    text: `Alignment option ${letter} · ${street} · ${km.toFixed(1)} km · ${money(costM)} (draft). Draft options for planners. ${why}`,
    tone: "neutral",
    citation: COST_PER_KM.citation,
    at: { lon, lat },
    option: {
      letter,
      follows,
      line,
      lengthKm: km,
      stations: 3,
      costM,
      costCitations: [COST_PER_KM.citation, OPTIMISM_BIAS.citation],
      station: { name: station.name, lon: station.at[0], lat: station.at[1] },
    },
  };
}

export const ONTARIO_OPTIONS: NewFinding[] = [
  option({
    id: "option-don-mills",
    letter: "A",
    follows: "Don Mills Road",
    street: "Don Mills Rd",
    line: DON_MILLS_LINE,
    station: { name: "Don Mills station", at: DON_MILLS },
    why: "The study's extension, traced along the 25 Don Mills to Don Mills station on Line 4.",
    pin: 0.62,
  }),
  option({
    id: "option-leslie",
    letter: "B",
    follows: "Leslie Street",
    street: "Leslie St",
    line: LESLIE_LINE,
    station: { name: "Leslie station", at: LESLIE_LINE.at(-1) as LonLat },
    why: "Hypothetical: no source studies it. Traced along the 51 Leslie to Leslie station on Line 4.",
    pin: 0.85,
  }),
];
