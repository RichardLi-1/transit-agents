// The GIS tools of the equity-analysis, economic-development and stop-accessibility
// skills: each a route that works on a study's layers and saves what it makes as a
// layer, with totals recorded as figures citing the dataset, as gis.ts's tools do.
// app.ts registers every route here, and mcp.ts makes each one a tool, which only
// those skills' specialists are given.
import type { z } from "zod";
import { ACCESS_ROUTES } from "./gis-access.ts";
import { ECONOMY_ROUTES } from "./gis-economy.ts";
import { EQUITY_ROUTES } from "./gis-equity.ts";
import type { Service } from "./service.ts";

export type SkillRoute = {
  path: `/v1/studies/:id/gis/${string}`;
  // The MCP tool's name, and what a model is told it does.
  tool: string;
  description: string;
  // What /openapi.json says.
  summary: string;
  body: z.ZodType;
  run(service: Service, actor: string, studyId: string, body: never): unknown;
};

export const GIS_SKILL_ROUTES: SkillRoute[] = [...EQUITY_ROUTES, ...ECONOMY_ROUTES, ...ACCESS_ROUTES];

// mcp.ts's form: one tool per route, keyed by method and path.
export const GIS_SKILL_TOOLS: Record<string, { name: string; description: string }> = Object.fromEntries(
  GIS_SKILL_ROUTES.map((route) => [`POST ${route.path}`, { name: route.tool, description: route.description }]),
);
