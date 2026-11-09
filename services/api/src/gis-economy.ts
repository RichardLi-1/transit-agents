// Jobs and activity near stations, for the economic-development skill: the people who
// work within an area layer, from the 2021 census by the tract they work in, beside the
// people who live there; and the land in it each kind of zone covers, from Zoning
// By-law 569-2013, Don Mills corridor only. Counts what is there; forecasts nothing.
import { area as areaOf } from "@turf/area";
import { bbox as bboxOf } from "@turf/bbox";
import { bboxClip } from "@turf/bbox-clip";
import { featureCollection } from "@turf/helpers";
import { intersect } from "@turf/intersect";
import type { Feature } from "geojson";
import { z } from "zod";
import { type Area, type BBox, clean, dissolve, type Gis, GisError, type Made, METHOD, type Total } from "./gis.ts";
import type { SkillRoute } from "./gis-skills.ts";
import type { Service } from "./service.ts";

const WORK = "statcan-pow-ct-2021";
const CENSUS = "census-da-2021";
const ZONING = "toronto-zoning-corridor";

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// People who work within an area layer, area-weighted from census tracts of work,
// and people who live there, area-weighted from dissemination areas.
export function jobsWithin(gis: Gis, layer: Feature[]): Made {
  const work = gis.overlay(layer, WORK, ["jobs", "atHome"]);
  const live = gis.overlay(layer, CENSUS, ["population"]);
  const value = (made: Made, name: string) => (made.totals?.[name] as Total).value;
  const jobs = value(work, "jobs");
  const population = value(live, "population");
  // Simplified tracts overlap by a few metres, which can sum to a hair over the layer.
  const workShare = Math.min(100, value(work, "layerShare"));
  const totals: Record<string, Total> = {
    jobs: { value: jobs, unit: "people", label: "People with a usual place of work here, 2021 (25% sample), area-weighted" },
    atHome: { value: value(work, "atHome"), unit: "people", label: "People who worked at home here, 2021 (25% sample), area-weighted" },
    tracts: { value: value(work, "areas"), unit: "areas", label: "Census tracts of work touched" },
    workLayerShare: { value: workShare, unit: "%", label: "Share of the layer in the Toronto CMA's census tracts" },
    population: { value: population, unit: "people", label: "Population, 2021, area-weighted" },
    censusLayerShare: { value: value(live, "layerShare"), unit: "%", label: "Share of the layer in the City's census areas" },
  };
  const warnings = [...(work.warnings ?? []), ...(live.warnings ?? [])];
  // Jobs and residents set side by side only where both datasets cover the same land.
  if (Math.abs(workShare - value(live, "layerShare")) <= 2 && population > 0) {
    totals.jobsPerResident = { value: round(jobs / population, 2), unit: "people per resident", label: "People working here per person living here, 2021" };
  } else {
    warnings.push("The work and census data cover different parts of the layer, so jobs per resident isn't worked out.");
  }
  warnings.push(
    "Census tracts are large beside a walk to a station: a tract's workers count in proportion to its land inside the layer, as if spread evenly, though work clusters in a few buildings. An estimate, coarser than the census areas'.",
    "May 2021, during COVID-19, when many people worked at home. It counts people with a usual place of work, a 25% sample, not jobs or businesses, and leaves out people with no fixed workplace.",
  );
  return { kind: "polygons", features: work.features, dataset: gis.cite(WORK), totals, warnings };
}

// Zoning By-law 569-2013's broad uses, and what each total is called.
const USES: Record<string, string> = {
  residential: "Residential and residential apartment zones",
  mixedUse: "Commercial residential zones (mixed use)",
  commercial: "Commercial zones",
  employment: "Employment industrial zones",
  institutional: "Institutional zones",
  openSpace: "Open space zones",
  utility: "Utility and transportation zones",
};

// The land in an area layer that each kind of zone covers, in km² and as a share of
// the zoned land, from the zones' own shapes: no weighting.
export function zoningWithin(gis: Gis, layer: Feature[]): Made {
  const info = gis.dataset(ZONING);
  const whole = dissolve(layer);
  const corridor = info.bbox as BBox;
  // The zones cover the corridor box, so the layer is measured inside it only.
  const mask = overlaps(bboxOf(whole) as BBox, corridor) ? clean(bboxClip(whole, corridor) as Feature<Area>) : undefined;
  if (!mask || areaOf(mask) < 1) {
    throw new GisError("outside_coverage", `"${ZONING}" covers ${info.coverage}. This layer lies wholly beyond it, so there is nothing to measure`);
  }
  const box = bboxOf(mask) as BBox;
  const land: Record<string, number> = Object.fromEntries(Object.keys(USES).map((use) => [use, 0]));
  const features: Feature[] = [];
  for (const { feature, bbox } of gis.areas(ZONING)) {
    if (!overlaps(bbox, box)) continue;
    const near = clean(bboxClip(mask, bbox) as Feature<Area>);
    if (!near) continue;
    const piece = intersect(featureCollection([feature, near]));
    if (!piece) continue;
    const m2 = areaOf(piece);
    if (m2 < 1) continue;
    const use = String(feature.properties?.use);
    land[use] = (land[use] ?? 0) + m2;
    features.push({ type: "Feature", properties: { zone: feature.properties?.zone, chapter: feature.properties?.chapter, use, km2: round(m2 / 1e6, 4) }, geometry: piece.geometry });
  }
  const zoned = Object.values(land).reduce((a, b) => a + b, 0);
  const layerArea = areaOf(mask);
  const corridorShare = round((layerArea / areaOf(whole)) * 100, 1);
  const zonedShare = layerArea ? round((zoned / layerArea) * 100, 1) : 0;
  const totals: Record<string, Total> = {
    corridorShare: { value: corridorShare, unit: "%", label: "Share of the layer inside the Don Mills corridor, where the zoning data is" },
    layerKm2: { value: round(layerArea / 1e6, 2), unit: "km²", label: "Land in the layer inside the corridor" },
    zonedKm2: { value: round(zoned / 1e6, 2), unit: "km²", label: "Land in the layer zoned under By-law 569-2013" },
    zonedShare: { value: zonedShare, unit: "%", label: "Share of the layer inside the corridor zoned under By-law 569-2013" },
  };
  for (const [use, label] of Object.entries(USES)) {
    totals[`${use}Km2`] = { value: round((land[use] ?? 0) / 1e6, 2), unit: "km²", label: `${label}, land in the layer` };
    totals[`${use}Share`] = { value: zoned ? round(((land[use] ?? 0) / zoned) * 100, 1) : 0, unit: "%", label: `${label}, share of the zoned land in the layer` };
  }
  const warnings = [
    "Zoning says what a lot may be used for, not what is built or who works there.",
    `${round(100 - zonedShare, 1)}% of the layer inside the corridor has no zone here: streets and rail, which the By-law doesn't zone, and any land still under a former municipality's by-law.`,
  ];
  if (corridorShare < 99.9) {
    warnings.unshift(
      `${round(100 - corridorShare, 1)}% of the layer is beyond the Don Mills corridor, where this zoning data stops. Nothing there is measured: these totals are for the part inside the corridor only. The City's whole Zoning By-law layer would cover the rest.`,
    );
  }
  return { kind: "polygons", features, dataset: gis.cite(ZONING), totals, warnings };
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, "Use lowercase letters, numbers, dots and dashes");
export const EconomyRequest = z.object({ layer: slug, id: slug.optional(), title: z.string().min(1).max(80).optional() });
type Request = z.output<typeof EconomyRequest>;

export function jobsLayer(service: Service, actor: string, studyId: string, input: Request) {
  const source = service.studyLayer(studyId, input.layer);
  const made = service.gisCall(() => jobsWithin(service.gis, source.features));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? `${source.layer.id}-jobs`.slice(0, 63),
      title: input.title ?? `Where people work in ${source.layer.title}`,
      color: "#0891b2",
      derivedFrom: [source.layer.id],
      operation: { name: "jobs_within", params: { layer: source.layer.id, weighting: "area" } },
    },
    ["jobs", "population", "jobsPerResident"],
    source.layer.title,
  );
  return { ...saved, method: METHOD };
}

export function zoningLayer(service: Service, actor: string, studyId: string, input: Request) {
  const source = service.studyLayer(studyId, input.layer);
  const made = service.gisCall(() => zoningWithin(service.gis, source.features));
  return service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? `${source.layer.id}-zoning`.slice(0, 63),
      title: input.title ?? `Zoning in ${source.layer.title}`,
      color: "#ca8a04",
      derivedFrom: [source.layer.id],
      operation: { name: "zoning_within", params: { layer: source.layer.id } },
    },
    ["employmentKm2", "employmentShare", "residentialKm2", "residentialShare", "mixedUseShare"],
    source.layer.title,
  );
}

export const ECONOMY_ROUTES: SkillRoute[] = [
  {
    path: "/v1/studies/:id/gis/jobs",
    tool: "jobs_within",
    summary: "The people who work within an area layer, from the 2021 census by census tract of work, beside the people who live there, saved as a layer with totals recorded as figures",
    description:
      "Count the people who work within an area layer, such as 800 m round a line's stations: the 2021 census's people with a usual place of work there, area-weighted from census tracts of work (statcan-pow-ct-2021, Toronto CMA), and those who worked at home; beside the people who live there (census-da-2021), with people working here per resident. Area-weighted estimates, May 2021. Saves the tracts as a layer and records the totals as figures.",
    body: EconomyRequest,
    run: (service, actor, studyId, body: Request) => jobsLayer(service, actor, studyId, body),
  },
  {
    path: "/v1/studies/:id/gis/zoning",
    tool: "zoning_within",
    summary: "The land in an area layer each kind of zone covers, from Zoning By-law 569-2013, Don Mills corridor only, saved as a layer with totals recorded as figures",
    description:
      "Measure the land in an area layer each kind of zone covers under Zoning By-law 569-2013 (toronto-zoning-corridor): residential, mixed use, commercial, employment industrial, institutional, open space, utility, in km² and as a share of the zoned land. Don Mills corridor only: it measures the part of the layer inside the corridor, and refuses a layer wholly beyond it. Saves the zones as a layer and records the employment and residential totals as figures.",
    body: EconomyRequest,
    run: (service, actor, studyId, body: Request) => zoningLayer(service, actor, studyId, body),
  },
];
