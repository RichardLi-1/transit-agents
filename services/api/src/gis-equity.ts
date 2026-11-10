// Who a change serves: the people living within reach of a route, its stops or a
// line, from the 2021 census, set beside the City as a whole from the same census,
// and the Neighbourhood Improvement Areas it reaches. For the equity-analysis skill.
//
// Every count is area-weighted, as overlay's are: an area counts in proportion to its
// land inside the layer, which assumes its people are spread evenly across it. They
// are counts of people in areas, and say nothing about any one person.
import { area as areaOf } from "@turf/area";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { buffer as bufferOf } from "@turf/buffer";
import { featureCollection } from "@turf/helpers";
import { union } from "@turf/union";
import type { Feature, Point } from "geojson";
import { z } from "zod";
import { type Area, type Gis, GisError, type Made, METHOD, type Total } from "./gis.ts";
import type { SkillRoute } from "./gis-skills.ts";
import type { Service } from "./service.ts";

const CENSUS = "census-da-2021";
const NIA = "toronto-nia";
// Children (0 to 14) for each dissemination area, from the same Census Profile.
const EXTRA = "census-da-2021-extra.json.gz";
// The TTC's equity weighting reaches stops within 400 m of a Neighbourhood Improvement Area.
const NIA_REACH = 400;

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const share = (of: number, base: number) => (base ? round((of / base) * 100, 1) : 0);

type Sums = { lowIncome: number; lowIncomeBase: number; transit: number; commuters: number; age65: number; ageBase: number; children: number; childBase: number };

// Each count added over areas that have it, and children only where the age base has them too.
function add(sums: Sums, properties: Record<string, unknown>, children: number | null | undefined, weight: number) {
  for (const key of ["lowIncome", "lowIncomeBase", "transit", "commuters", "age65", "ageBase"] as const) {
    const value = properties[key];
    if (typeof value === "number") sums[key] += value * weight;
  }
  if (typeof children === "number" && typeof properties.ageBase === "number") {
    sums.children += children * weight;
    sums.childBase += properties.ageBase * weight;
  }
}
const empty = (): Sums => ({ lowIncome: 0, lowIncomeBase: 0, transit: 0, commuters: 0, age65: 0, ageBase: 0, children: 0, childBase: 0 });
const shares = (s: Sums) => ({
  lowIncomeShare: share(s.lowIncome, s.lowIncomeBase),
  transitShare: share(s.transit, s.commuters),
  seniorShare: share(s.age65, s.ageBase),
  childShare: share(s.children, s.childBase),
});

const LABELS = {
  lowIncomeShare: "Share of people in low income (LIM-AT, 2020 incomes)",
  transitShare: "Share of commuters going by public transit",
  seniorShare: "Share aged 65 and over",
  childShare: "Share aged 0 to 14",
} as const;

// What the equity tool knows beyond Gis: the extra census counts, the City's own
// shares, and 400 m round every NIA, each worked out once.
const known = new WeakMap<Gis, { children: Record<string, number | null>; city: ReturnType<typeof shares>; population: number; reach: Feature<Area> }>();

function context(gis: Gis) {
  const found = known.get(gis);
  if (found) return found;
  const children = gis.read<{ areas: Record<string, number | null> }>(EXTRA).areas;
  const sums = empty();
  let population = 0;
  for (const { feature } of gis.areas(CENSUS)) {
    const properties = feature.properties ?? {};
    if (typeof properties.population === "number") population += properties.population;
    add(sums, properties, children[String(properties.id)], 1);
  }
  const circles = gis.areas(NIA).map(({ feature }) => bufferOf(feature, NIA_REACH, { units: "meters", steps: 16 }) as Feature<Area>);
  const reach = circles.length === 1 ? circles[0] : union(featureCollection(circles));
  if (!reach) throw new GisError("empty", "No Neighbourhood Improvement Areas to reach");
  const made = { children, city: shares(sums), population, reach: reach as Feature<Area> };
  known.set(gis, made);
  return made;
}

// The equity profile of an area layer, such as 400 m round a route's stops, and of a
// stops layer if given: how many of them are within 400 m of an NIA.
export function equityProfile(gis: Gis, layer: Feature[], stops?: Feature[]): Made & { nias: { name: string; share: number }[] } {
  const { children, city, population: cityPopulation, reach } = context(gis);
  const census = gis.overlay(layer, CENSUS, ["population", "lowIncome", "lowIncomeShare", "transitShare", "seniorShare"]);
  const byId = new Map(gis.areas(CENSUS).map((a) => [String(a.feature.properties?.id), a]));
  const sums = empty();
  const features: Feature[] = [];
  for (const piece of census.features) {
    const id = String(piece.properties?.id);
    const whole = byId.get(id);
    if (!whole) continue;
    const weight = Math.min(1, areaOf(piece) / whole.area);
    const properties = whole.feature.properties ?? {};
    add(sums, properties, children[id], weight);
    const own = typeof properties.lowIncome === "number" && typeof properties.lowIncomeBase === "number" ? { lowIncomeShare: share(properties.lowIncome, properties.lowIncomeBase) } : {};
    features.push({ type: "Feature", properties: { id, share: piece.properties?.share, ...own }, geometry: piece.geometry });
  }
  const here = shares(sums);
  const t = census.totals ?? {};
  const value = (name: string) => (t[name] as Total).value;
  const totals: Record<string, Total> = {
    population: { value: value("population"), unit: "people", label: "Population, 2021, area-weighted" },
    lowIncome: { value: value("lowIncome"), unit: "people", label: "People in low income (LIM-AT, 2020 incomes), area-weighted" },
    censusLayerShare: { value: value("layerShare"), unit: "%", label: "Share of the layer in the City's census areas" },
  };
  for (const name of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    const city_ = `city${name[0]?.toUpperCase()}${name.slice(1)}`;
    totals[name] = { value: here[name], unit: "%", label: `${LABELS[name]}, area-weighted` };
    totals[city_] = { value: city[name], unit: "%", label: `${LABELS[name]}, City of Toronto` };
    totals[`${name}Gap`] = { value: round(here[name] - city[name], 1), unit: "percentage points", label: `${LABELS[name]}: here less the City` };
  }
  totals.cityPopulation = { value: cityPopulation, unit: "people", label: "Population, 2021, City of Toronto" };

  // The NIAs the layer reaches, how much of it they cover, and the people in that part.
  const nia = gis.overlay(layer, NIA);
  const nias = nia.features
    .map((f) => ({ name: String(f.properties?.name), share: Number(f.properties?.share) }))
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
  const niaPopulation = nia.features.length ? ((gis.overlay(nia.features, CENSUS, ["population"]).totals?.population as Total).value) : 0;
  totals.niaAreas = { value: nia.features.length, unit: "areas", label: "Neighbourhood Improvement Areas reached" };
  totals.niaLayerShare = { value: (nia.totals?.layerShare as Total).value, unit: "%", label: "Share of the layer in Neighbourhood Improvement Areas" };
  totals.niaPopulation = { value: niaPopulation, unit: "people", label: "Population in Neighbourhood Improvement Areas, 2021, area-weighted" };
  totals.niaPopulationShare = { value: share(niaPopulation, value("population")), unit: "%", label: "Share of the population living in Neighbourhood Improvement Areas" };

  const warnings = [...(census.warnings ?? [])];
  if (stops) {
    const points = stops.filter((f): f is Feature<Point> => f.geometry?.type === "Point");
    if (!points.length || points.length < stops.length) throw new GisError("not_points", "stops needs a layer of stops, such as route_stops makes");
    const near = points.filter((p) => booleanPointInPolygon(p, reach)).length;
    totals.stops = { value: points.length, unit: "stops", label: "Stops in the stops layer" };
    totals.stopsNearNia = { value: near, unit: "stops", label: "Stops within 400 m of a Neighbourhood Improvement Area" };
    totals.stopsNearNiaShare = { value: share(near, points.length), unit: "%", label: "Share of the stops within 400 m of a Neighbourhood Improvement Area" };
    warnings.push(
      "The TTC weights boardings at stops within 400 m of the residential parts of NIAs. These are the NIAs' whole areas, so the stops counted near one can be more than the TTC's own count, never fewer.",
    );
  }
  warnings.push("Every count is of people in areas, area-weighted, an estimate: none says anything about any one person, or about who rides.");
  return { kind: "polygons", features, dataset: gis.cite(CENSUS), totals, warnings, nias };
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, "Use lowercase letters, numbers, dots and dashes");
export const EquityRequest = z.object({
  layer: slug,
  // A layer of stops, such as route_stops makes, to count those near an NIA.
  stops: slug.optional(),
  id: slug.optional(),
  title: z.string().min(1).max(80).optional(),
});

// The totals each profile records as figures.
const RECORD = ["population", "lowIncome", "lowIncomeShare", "cityLowIncomeShare", "transitShare", "cityTransitShare", "seniorShare", "citySeniorShare", "childShare", "cityChildShare", "niaAreas", "niaPopulation", "stopsNearNia"];

export function equityLayer(service: Service, actor: string, studyId: string, input: z.output<typeof EquityRequest>) {
  const source = service.studyLayer(studyId, input.layer);
  const stops = input.stops ? service.studyLayer(studyId, input.stops) : undefined;
  const made = service.gisCall(() => equityProfile(service.gis, source.features, stops?.features));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? `${source.layer.id}-equity`.slice(0, 63),
      title: input.title ?? `Who lives in ${source.layer.title}`,
      color: "#9333ea",
      derivedFrom: [source.layer.id, ...(stops ? [stops.layer.id] : [])],
      operation: { name: "equity_profile", params: { layer: source.layer.id, ...(stops ? { stops: stops.layer.id } : {}) } },
    },
    RECORD,
    source.layer.title,
  );
  return { ...saved, method: METHOD, nias: made.nias };
}

export const EQUITY_ROUTES: SkillRoute[] = [
  {
    path: "/v1/studies/:id/gis/equity",
    tool: "equity_profile",
    summary: "Who lives within an area layer, from the 2021 census, beside the City as a whole, and the Neighbourhood Improvement Areas it reaches, saved as a layer with its totals recorded as figures",
    description:
      "Who lives within an area layer, such as 400 m round a route's stops: people in low income (LIM-AT), commuters by transit, people 65 and over and 0 to 14, each as a share beside the City of Toronto's from the same 2021 census, with the difference; the Neighbourhood Improvement Areas it reaches and the people in them; and, given a stops layer, how many stops are within 400 m of an NIA. Area-weighted estimates. Saves the census areas as a layer and records the totals as figures citing census-da-2021.",
    body: EquityRequest,
    run: (service, actor, studyId, body: z.output<typeof EquityRequest>) => equityLayer(service, actor, studyId, body),
  },
];
