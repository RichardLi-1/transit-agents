// A Vision Zero corridor audit's numbers, worked out here and never by a model:
// police-reported collisions where someone was killed or seriously injured (KSI)
// inside an area layer, by year, road user, severity, place, light and time of day;
// the places with the most of them; and whether there are more or fewer a year than
// before, against the whole city's change, with how likely chance alone is to give
// as large a change. Each result is a layer on the study, its main totals figures
// citing toronto-ksi-detail. Nothing here says why a collision happened.
import { bbox as bboxOf } from "@turf/bbox";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import type { KsiHotspotsRequest as HotspotsSchema, KsiProfileRequest as ProfileSchema, KsiTrendRequest as TrendSchema } from "@transit-agents/contracts";
import type { Feature, Position } from "geojson";
import type { z } from "zod";
import { dissolve, type Gis, GisError, type Made, type Total } from "./gis.ts";
import { layerId, metres, refusing, round, sourceLayer } from "./gis-layers.ts";
import type { Service } from "./service.ts";

export const KSI_DETAIL = "toronto-ksi-detail";

// [lon, lat, year, month, hour, flags, street1, street2, killed x5, seriously injured x5],
// by road user: pedestrian, cyclist, motorcyclist, motorist, other.
type Ksi = { years: [number, number]; lastDate: string; roadUsers: string[]; streets: string[]; points: number[][] };
type Filter = { from?: number | undefined; to?: number | undefined; involving?: "pedestrian" | "cyclist" | "motorcyclist" | undefined };

const FATAL = 1;
const INVOLVED = { pedestrian: 2, cyclist: 4, motorcyclist: 8 } as const;
const AT_INTERSECTION = 16;
const MID_BLOCK = 32;
const DARK = 64;
const USERS = ["pedestrian", "cyclist", "motorcyclist", "motorist", "other"] as const;

// Times of day by the hour police recorded, each band's hours given in its label.
export const TIMES = [
  { name: "night", label: "midnight to 6 am", from: 0, to: 5 },
  { name: "morning", label: "6 am to 10 am", from: 6, to: 9 },
  { name: "midday", label: "10 am to 3 pm", from: 10, to: 14 },
  { name: "afternoon", label: "3 pm to 7 pm", from: 15, to: 18 },
  { name: "evening", label: "7 pm to midnight", from: 19, to: 23 },
] as const;

// Fewer collisions than this, and a breakdown by year, hour or road user shows little.
export const FEW = 20;

// The road user a collision is filed under: the most vulnerable one involved.
export const modeOf = (flags: number) =>
  flags & INVOLVED.pedestrian ? "pedestrian" : flags & INVOLVED.cyclist ? "cyclist" : flags & INVOLVED.motorcyclist ? "motorcyclist" : "motorist";

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// A two-sided exact test of two Poisson counts over spans of years: given the total,
// the earlier count is binomial with the earlier span's share of the years. The
// p-value is the chance of a split at least as uneven if the yearly rate hadn't changed.
export function poissonTest(before: number, yearsBefore: number, after: number, yearsAfter: number): number {
  const n = before + after;
  if (!n) return 1;
  const p = yearsBefore / (yearsBefore + yearsAfter);
  const logs = [0];
  for (let k = 1; k <= n; k++) logs.push((logs[k - 1] as number) + Math.log(k));
  const logP = (k: number) => (logs[n] as number) - (logs[k] as number) - (logs[n - k] as number) + k * Math.log(p) + (n - k) * Math.log(1 - p);
  const observed = logP(before);
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const l = logP(k);
    if (l <= observed + 1e-9) total += Math.exp(l);
  }
  return Math.min(1, total);
}

export class Safety {
  private readonly gis: Gis;
  constructor(gis: Gis) {
    this.gis = gis;
  }

  private ksi(): Ksi {
    return this.gis.read<Ksi>(this.gis.dataset(KSI_DETAIL).file);
  }

  // The years asked for, checked against the data's.
  years(filter: Filter, { whole = false } = {}): [number, number] {
    const ksi = this.ksi();
    const partial = Number(ksi.lastDate.slice(0, 4));
    const to = filter.to ?? (whole ? partial - 1 : ksi.years[1]);
    // A trend's default: the ten whole years to `to`.
    const from = filter.from ?? (whole ? Math.max(ksi.years[0], to - 9) : ksi.years[0]);
    if (from > to) throw new GisError("bad_years", `from (${from}) is after to (${to})`);
    if (from < ksi.years[0] || to > ksi.years[1]) throw new GisError("outside_years", `The collisions run from ${ksi.years[0]} to ${ksi.lastDate}. Ask for years in that range`);
    if (whole && to >= partial) throw new GisError("partial_year", `${partial} is partial: the collisions run to ${ksi.lastDate}. End a trend at ${partial - 1}`);
    return [from, to];
  }

  // The collisions inside an area, in the years and with the road user asked for.
  private within(layer: Feature[], filter: Filter, [from, to]: [number, number]): number[][] {
    const mask = dissolve(layer);
    const [w, s, e, n] = bboxOf(mask);
    const bit = filter.involving ? INVOLVED[filter.involving] : 0;
    return this.ksi().points.filter(([lon, lat, year, , , flags]) => {
      const [x, y, yr, f] = [lon as number, lat as number, year as number, flags as number];
      return yr >= from && yr <= to && (!bit || f & bit) && x >= (w as number) && x <= (e as number) && y >= (s as number) && y <= (n as number) && booleanPointInPolygon([x, y], mask);
    });
  }

  private feature(point: number[]): Feature {
    const ksi = this.ksi();
    const [lon, lat, year, month, hour, flags, s1, s2] = point as [number, number, number, number, number, number, number, number];
    const streets = [s1, s2].filter((s) => s >= 0).map((s) => ksi.streets[s]);
    return {
      type: "Feature",
      properties: {
        year,
        month,
        hour,
        fatal: Boolean(flags & FATAL),
        mode: modeOf(flags),
        place: flags & AT_INTERSECTION ? "intersection" : flags & MID_BLOCK ? "mid-block" : "not recorded",
        dark: Boolean(flags & DARK),
        ...(streets.length ? { streets: streets.join(" & ") } : {}),
        killed: sum(point.slice(8, 13)),
        seriouslyInjured: sum(point.slice(13, 18)),
      },
      geometry: { type: "Point", coordinates: [lon, lat] },
    };
  }

  private describe(filter: Filter, [from, to]: [number, number]) {
    const years = from === to ? `${from}` : `${from}–${to}`;
    return { years, which: filter.involving ? ` involving a ${filter.involving}` : "" };
  }

  private warnings(count: number, [, to]: [number, number]): string[] {
    const ksi = this.ksi();
    const warnings = ["Police-reported only: collisions police didn't attend are missing. Counts say where and when, never why."];
    if (to >= Number(ksi.lastDate.slice(0, 4))) warnings.push(`${ksi.lastDate.slice(0, 4)} is partial: the collisions run to ${ksi.lastDate}.`);
    if (count < FEW) warnings.push(`Only ${count} collisions: too few to read a pattern by year, hour or road user.`);
    return warnings;
  }

  // Counts by year, road user, severity, place, light and time of day.
  profile(layer: Feature[], filter: Filter): Made & { breakdown: Record<string, Record<string, number>> } {
    const span = this.years(filter);
    const points = this.within(layer, filter, span);
    const { years, which } = this.describe(filter, span);
    const count = (test: (p: number[]) => boolean) => points.filter(test).length;
    const flag = (bit: number) => (p: number[]) => Boolean((p[5] as number) & bit);
    const people = (offset: number) => USERS.map((_, i) => sum(points.map((p) => p[offset + i] as number)));
    const killed = people(8);
    const serious = people(13);
    const byYear: Record<string, number> = {};
    for (let y = span[0]; y <= span[1]; y++) byYear[y] = count((p) => p[2] === y);
    const byMode = Object.fromEntries(["pedestrian", "cyclist", "motorcyclist", "motorist"].map((m) => [m, count((p) => modeOf(p[5] as number) === m)]));
    const byTime = Object.fromEntries(TIMES.map((t) => [t.name, count((p) => (p[4] as number) >= t.from && (p[4] as number) <= t.to)]));
    const t = (value: number, unit: string, label: string): Total => ({ value, unit, label: `${label}, ${years}` });
    const totals: Record<string, Total> = {
      collisions: t(points.length, "collisions", `KSI collisions${which}`),
      fatal: t(count(flag(FATAL)), "collisions", `KSI collisions${which} where someone was killed`),
      killed: t(sum(killed), "people", `People killed in KSI collisions${which}`),
      seriouslyInjured: t(sum(serious), "people", `People seriously injured in KSI collisions${which}`),
      ...Object.fromEntries(
        USERS.map((user, i) => [`${user}Ksi`, t((killed[i] as number) + (serious[i] as number), "people", `${user[0]?.toUpperCase()}${user.slice(1)}s killed or seriously injured${which}`)]),
      ),
      ...Object.fromEntries(
        Object.entries(byMode).map(([mode, n]) => [`${mode}Collisions`, t(n, "collisions", mode === "motorist" ? `KSI collisions${which} with no pedestrian, cyclist or motorcyclist` : `KSI collisions${which} involving a ${mode}`)]),
      ),
      atIntersection: t(count(flag(AT_INTERSECTION)), "collisions", `KSI collisions${which} police placed at or near an intersection`),
      midBlock: t(count(flag(MID_BLOCK)), "collisions", `KSI collisions${which} police placed mid-block`),
      placeNotRecorded: t(count((p) => !((p[5] as number) & (AT_INTERSECTION | MID_BLOCK))), "collisions", `KSI collisions${which} with no place recorded`),
      dark: t(count(flag(DARK)), "collisions", `KSI collisions${which} in the dark`),
      ...Object.fromEntries(TIMES.map((time) => [time.name, t(byTime[time.name] as number, "collisions", `KSI collisions${which}, ${time.label}`)])),
      ...Object.fromEntries(Object.entries(byYear).map(([year, n]) => [`year${year}`, { value: n, unit: "collisions", label: `KSI collisions${which} in ${year}` }])),
    };
    return {
      kind: "points",
      features: points.map((p) => this.feature(p)),
      dataset: this.gis.cite(KSI_DETAIL),
      totals,
      warnings: this.warnings(points.length, span),
      breakdown: {
        byYear,
        byMode,
        byTime,
        peopleKilled: Object.fromEntries(USERS.map((u, i) => [u, killed[i] as number])),
        peopleSeriouslyInjured: Object.fromEntries(USERS.map((u, i) => [u, serious[i] as number])),
      },
    };
  }

  // The places with the most collisions. Collisions at the same point come first;
  // then each place, busiest first, takes in any within `radius` metres of it that
  // no busier place has. Ties go to the place with more deaths, then west to east.
  hotspots(layer: Feature[], filter: Filter, radius: number, top: number): Made {
    const span = this.years(filter);
    const points = this.within(layer, filter, span);
    const { years, which } = this.describe(filter, span);
    const ksi = this.ksi();
    const spots = new Map<string, number[][]>();
    for (const p of points) {
      const key = `${p[0]},${p[1]}`;
      spots.set(key, [...(spots.get(key) ?? []), p]);
    }
    const fatal = (list: number[][]) => list.filter((p) => (p[5] as number) & FATAL).length;
    const order = (a: number[][], b: number[][]) => b.length - a.length || fatal(b) - fatal(a) || (a[0]?.[0] as number) - (b[0]?.[0] as number) || (a[0]?.[1] as number) - (b[0]?.[1] as number);
    const seeds = [...spots.values()].sort(order);
    const places: { at: Position; members: number[][] }[] = [];
    for (const spot of seeds) {
      const at: Position = [spot[0]?.[0] as number, spot[0]?.[1] as number];
      const near = places.find((place) => metres(place.at, at) <= radius);
      if (near) near.members.push(...spot);
      else places.push({ at, members: [...spot] });
    }
    const ranked = places.filter((p) => p.members.length >= 2).sort((a, b) => order(a.members, b.members));
    const name = (members: number[][]) => {
      const names = new Map<string, number>();
      for (const p of members) {
        const streets = [p[6], p[7]].filter((s): s is number => (s as number) >= 0).map((s) => ksi.streets[s] as string).sort();
        const key = streets.join(" & ") || "No street recorded";
        names.set(key, (names.get(key) ?? 0) + 1);
      }
      return [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] as string;
    };
    const listed = ranked.slice(0, top);
    const features: Feature[] = listed.map((place, i) => {
      const m = place.members;
      const ys = m.map((p) => p[2] as number);
      const intersection = m.filter((p) => (p[5] as number) & AT_INTERSECTION).length;
      return {
        type: "Feature",
        properties: {
          rank: i + 1,
          name: name(m),
          collisions: m.length,
          fatal: fatal(m),
          killed: sum(m.map((p) => sum(p.slice(8, 13)))),
          seriouslyInjured: sum(m.map((p) => sum(p.slice(13, 18)))),
          pedestrian: m.filter((p) => modeOf(p[5] as number) === "pedestrian").length,
          cyclist: m.filter((p) => modeOf(p[5] as number) === "cyclist").length,
          atIntersection: intersection,
          years: Math.min(...ys) === Math.max(...ys) ? `${Math.min(...ys)}` : `${Math.min(...ys)}–${Math.max(...ys)}`,
        },
        geometry: { type: "Point", coordinates: place.at },
      };
    });
    const inTop = sum(listed.map((p) => p.members.length));
    const warnings = this.warnings(points.length, span);
    warnings.push(
      `A place is collisions within ${radius} m of the busiest point near them, named by the streets police recorded most often there. It isn't the City's own list of intersections or segments.`,
      "A place with many collisions in past years may have fewer in the next even if nothing changes there (regression to the mean). Compare places over the same years.",
    );
    if (!listed.length) warnings.push("No two collisions here are within the radius of each other, so there are no hot spots to list.");
    const totals: Record<string, Total> = {
      collisions: { value: points.length, unit: "collisions", label: `KSI collisions${which}, ${years}` },
      places: { value: ranked.length, unit: "places", label: `Places with 2 or more KSI collisions${which} within ${radius} m, ${years}` },
      topCollisions: { value: listed[0]?.members.length ?? 0, unit: "collisions", label: `KSI collisions${which} at the place with the most, ${years}` },
      listedShare: { value: points.length ? round((inTop / points.length) * 100, 1) : 0, unit: "%", label: `Share of KSI collisions${which} at the ${listed.length} places listed, ${years}` },
    };
    return { kind: "points", features, dataset: this.gis.cite(KSI_DETAIL), totals, warnings };
  }

  // Collisions a year before `split` and from it, against the whole city's.
  trend(layer: Feature[], filter: Filter & { split?: number | undefined }): Made & { test: Record<string, number | string> } {
    const [from, to] = this.years(filter, { whole: true });
    const split = filter.split ?? from + Math.ceil((to - from + 1) / 2);
    if (split <= from || split > to) throw new GisError("bad_split", `split (${split}) must be after from (${from}) and no later than to (${to}), so each period has a year`);
    const points = this.within(layer, filter, [from, to]);
    const bit = filter.involving ? INVOLVED[filter.involving] : 0;
    const city = this.ksi().points.filter((p) => (p[2] as number) >= from && (p[2] as number) <= to && (!bit || (p[5] as number) & bit));
    const yearsBefore = split - from;
    const yearsAfter = to - split + 1;
    const before = points.filter((p) => (p[2] as number) < split).length;
    const after = points.length - before;
    const cityBefore = city.filter((p) => (p[2] as number) < split).length;
    const cityAfter = city.length - cityBefore;
    const change = (b: number, a: number) => (b ? round(((a / yearsAfter - b / yearsBefore) / (b / yearsBefore)) * 100, 1) : 0);
    const p = poissonTest(before, yearsBefore, after, yearsAfter);
    const label = (y0: number, y1: number) => (y0 === y1 ? `${y0}` : `${y0}–${y1}`);
    const [early, late] = [label(from, split - 1), label(split, to)];
    const { which } = this.describe(filter, [from, to]);
    const reading =
      points.length < FEW
        ? `Too few to tell: ${points.length} collisions in all, under ${FEW}.`
        : p < 0.05
          ? `${after / yearsAfter > before / yearsBefore ? "More" : "Fewer"} a year in ${late} than in ${early}. Chance alone would give a change this large ${p < 0.001 ? "less than 0.1%" : `${round(p * 100, 1)}%`} of the time. This says the rate changed, not why.`
          : `No clear change: chance alone would give a difference this large ${round(p * 100, 0)}% of the time.`;
    const t = (value: number, unit: string, text: string): Total => ({ value, unit, label: text });
    const totals: Record<string, Total> = {
      before: t(before, "collisions", `KSI collisions${which}, ${early}`),
      after: t(after, "collisions", `KSI collisions${which}, ${late}`),
      beforePerYear: t(round(before / yearsBefore, 1), "collisions/year", `KSI collisions${which} a year, ${early}`),
      afterPerYear: t(round(after / yearsAfter, 1), "collisions/year", `KSI collisions${which} a year, ${late}`),
      changePct: t(change(before, after), "%", `Change in KSI collisions${which} a year, ${early} to ${late}`),
      pValue: t(round(p, 4), "", `Chance of a change this large with no change in the yearly rate, ${early} to ${late}`),
      cityChangePct: t(change(cityBefore, cityAfter), "%", `Change in KSI collisions${which} a year in all of Toronto, ${early} to ${late}`),
    };
    const features = points.map((pt) => {
      const f = this.feature(pt);
      return { ...f, properties: { ...f.properties, period: (pt[2] as number) < split ? early : late } };
    });
    const warnings = this.warnings(points.length, [from, to]);
    warnings.push("A change in the count isn't a change in risk: traffic, people walking and cycling, and reporting change too. Set it beside the city's change.");
    return {
      kind: "points",
      features,
      dataset: this.gis.cite(KSI_DETAIL),
      totals,
      warnings,
      test: { method: "Exact test of two Poisson counts over their years (conditional binomial), two-sided", reading, early, late, cityBefore, cityAfter },
    };
  }
}

const filterOf = (input: { from?: number | undefined; to?: number | undefined; involving?: Filter["involving"] }): Filter => ({
  ...(input.from !== undefined ? { from: input.from } : {}),
  ...(input.to !== undefined ? { to: input.to } : {}),
  ...(input.involving !== undefined ? { involving: input.involving } : {}),
});

const suffix = (filter: Filter) => [filter.from !== undefined || filter.to !== undefined ? `${filter.from ?? "start"}-${filter.to ?? "end"}` : "", filter.involving ?? ""];

const COLOR = "#dc2626";
const RECORD = ["collisions", "fatal", "killed", "seriouslyInjured", "pedestrianKsi", "cyclistKsi", "motorcyclistKsi", "motoristKsi"];

// The service's side: each request on a study's layer, saved as a layer with its
// main totals recorded as figures.
export function ksiProfileLayer(service: Service, actor: string, studyId: string, input: z.output<typeof ProfileSchema>) {
  const source = sourceLayer(service, studyId, input.layer);
  const filter = filterOf(input);
  const made = refusing(() => new Safety(service.gis).profile(source.features, filter));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? layerId(source.layer.id, "ksi-profile", ...suffix(filter)),
      title: input.title ?? `KSI collisions in ${source.layer.title}`,
      color: COLOR,
      derivedFrom: [source.layer.id],
      operation: { name: "ksi_profile", params: { layer: source.layer.id, ...filter } },
    },
    RECORD,
    source.layer.title,
  );
  return { ...saved, breakdown: made.breakdown };
}

export function ksiHotspotsLayer(service: Service, actor: string, studyId: string, input: z.output<typeof HotspotsSchema>) {
  const source = sourceLayer(service, studyId, input.layer);
  const filter = filterOf(input);
  const radius = input.radius ?? 30;
  const top = input.top ?? 10;
  const made = refusing(() => new Safety(service.gis).hotspots(source.features, filter, radius, top));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? layerId(source.layer.id, "ksi-hotspots", ...suffix(filter)),
      title: input.title ?? `KSI hot spots in ${source.layer.title}`,
      color: "#b91c1c",
      derivedFrom: [source.layer.id],
      operation: { name: "ksi_hotspots", params: { layer: source.layer.id, ...filter, radius, top } },
    },
    ["places", "topCollisions"],
    source.layer.title,
  );
  return { ...saved, hotspots: made.features.map((f) => f.properties) };
}

export function ksiTrendLayer(service: Service, actor: string, studyId: string, input: z.output<typeof TrendSchema>) {
  const source = sourceLayer(service, studyId, input.layer);
  const filter = { ...filterOf(input), ...(input.split !== undefined ? { split: input.split } : {}) };
  const made = refusing(() => new Safety(service.gis).trend(source.features, filter));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? layerId(source.layer.id, "ksi-trend", ...suffix(filter), input.split !== undefined && `split-${input.split}`),
      title: input.title ?? `KSI trend in ${source.layer.title}`,
      color: COLOR,
      derivedFrom: [source.layer.id],
      operation: { name: "ksi_trend", params: { layer: source.layer.id, ...filter } },
    },
    ["before", "after", "changePct"],
    source.layer.title,
  );
  return { ...saved, test: made.test };
}
