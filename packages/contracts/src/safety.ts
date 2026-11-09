// What the road safety and active transportation GIS tools take. Like the other GIS
// tools, each works on a layer of the study, and id and title name the new layer;
// without them the service makes them from the request, so the same request gives
// the same layer.
import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, "Use lowercase letters, numbers, dots and dashes");
const LayerName = { id: slug.optional(), title: z.string().min(1).max(80).optional() };
const Year = z.number().int().min(1900).max(2100);

// KSI collisions inside an area layer, by year, road user, severity, place, light
// and time of day. Narrowed by years, both included, and who was involved.
export const KsiProfileRequest = z.object({
  layer: slug,
  from: Year.optional(),
  to: Year.optional(),
  involving: z.enum(["pedestrian", "cyclist", "motorcyclist"]).optional(),
  ...LayerName,
});
export type KsiProfileRequest = z.input<typeof KsiProfileRequest>;

// The places inside an area layer with the most KSI collisions: collisions within
// `radius` metres of each other count as one place.
export const KsiHotspotsRequest = KsiProfileRequest.extend({
  radius: z.number().min(10).max(100).default(30),
  top: z.number().int().min(1).max(25).default(10),
});
export type KsiHotspotsRequest = z.input<typeof KsiHotspotsRequest>;

// KSI collisions a year inside an area layer, before and from `split`, against the
// whole city's over the same years.
export const KsiTrendRequest = KsiProfileRequest.extend({ split: Year.optional() });
export type KsiTrendRequest = z.input<typeof KsiTrendRequest>;

// The cycling network, sidewalks or bike share stations inside an area layer.
export const ActiveLayerRequest = z.object({ layer: slug, ...LayerName });
export type ActiveLayerRequest = z.input<typeof ActiveLayerRequest>;

// For each stop of a points layer: the nearest bike share station, and the
// bikeways within `metres`.
export const FirstLastMileRequest = z.object({ layer: slug, metres: z.number().min(50).max(1500), ...LayerName });
export type FirstLastMileRequest = z.input<typeof FirstLastMileRequest>;
