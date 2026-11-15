// Agents connect over MCP at /v1/mcp: Streamable HTTP, stateless. Each tool is one
// route in app.ts, and each call goes back through the app as an ordinary request
// with the caller's token, and the visitor it acts for. So roles, validation,
// citation checks, idempotency, visitors' sandboxes and the log treat a tool call
// exactly like the same REST call, and none of that is repeated here.
//
// This uses the SDK's low-level Server, not McpServer. A tool's input is JSON
// Schema made from the route's own zod schema, as /openapi.json is, and the route
// validates the arguments. McpServer would validate them again with zod, replace
// the API's errors with its own, and needs an object schema, which a union body
// such as Activity is not.
import { isIP } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ON_BEHALF_OF, type Role } from "@transit-agents/contracts";
import type { Context } from "hono";
import { z } from "zod";
import type { Actor } from "./app.ts";
import { GIS_SKILL_TOOLS } from "./gis-skills.ts";
import { ApiError } from "./service.ts";

// What a tool needs to know about a route in app.ts.
export type ApiRoute = { method: "get" | "post" | "put"; path: string; roles: readonly Role[]; body?: z.ZodType };

type JsonSchema = {
  [key: string]: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
};

// `query` arguments go in the URL. Those named in `required` must be given.
type Spec = { name: string; description: string; query?: Record<string, JsonSchema>; required?: string[] };

export const INSTRUCTIONS = [
  "Transit Agents holds transit planning studies: agents do the first pass, and every figure must trace to the page it came from.",
  "Find pages with search_sources, then read the page with read_page before citing it.",
  "Every figure needs a basis: a quote that is on the cited page and contains the value, a formula over other figures and planner-set rules, or a planner-approved skill.",
  "Rule thresholds come only from list_rules.",
  "Only planners decide. They set rules, rate findings, accept skill results and record decisions.",
  "When people in a neighbourhood need to hear about a change, propose what to make with add_engagement_need. Only a planner asks for it to be made.",
  "The agent's own code reports each model call's tokens and cost; never report usage numbers you weren't given.",
].join("\n");

// One tool per route, named and described for a model, keyed by method and path.
export const TOOLS: Record<string, Spec> = {
  "GET /v1/context": {
    name: "list_sources",
    description:
      "List source documents: id, title, folder, page count and who added them. Only sources added by a planner or an agency system can be cited.",
  },
  "GET /v1/context/:id/pages/:page": {
    name: "read_page",
    description: "Read one page of a source document. Read a page before citing it: a quote must be on the page it cites.",
  },
  "GET /v1/search": {
    name: "search_sources",
    description: "Find which source pages mention something. Then read_page before citing.",
    query: {
      q: { type: "string", description: "Words or numbers to look for, such as: Lawrence weekly ridership" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Most pages to return. Default 10" },
    },
    required: ["q"],
  },
  "POST /v1/context": {
    name: "add_source",
    description: "Add a source document: a title, and its pages or a single text. A source an agent adds can't back a figure.",
  },
  "GET /v1/me": {
    name: "whoami",
    description: "Who you are to the service: your role and name. Your role decides which tools you have.",
  },
  "GET /v1/studies": {
    name: "list_studies",
    description: "List studies, each with its figures, checks, findings, analysis and decision.",
  },
  "POST /v1/studies": {
    name: "open_study",
    description: "Open a study. Its id uses lowercase letters, numbers, dots and dashes.",
  },
  "GET /v1/studies/:id": {
    name: "get_study",
    description: "Read a study: its figures, checks, findings, analysis and decision.",
  },
  "POST /v1/studies/:id/figures": {
    name: "record_figure",
    description:
      "Add a figure to a study. It is rejected unless its basis holds. cited: a citation whose quote is on the cited page and contains the value. derived: a formula, with inputs mapping each name in it to a figure or a rule. computed: the result of a planner-approved skill version.",
  },
  "POST /v1/studies/:id/checks": {
    name: "record_check",
    description: "Test a figure against a rule. The threshold names a rule from list_rules.",
  },
  "POST /v1/studies/:id/findings": {
    name: "record_finding",
    description:
      "Add a finding the service can't compute, such as public feedback, with a citation. Its tone is only a proposal until a planner rates it.",
  },
  "POST /v1/studies/:id/alignments": {
    name: "propose_alignment",
    description:
      "Propose a draft alignment for the study's line, from Don Valley station (Science Centre) to a terminus: Don Mills station, Leslie station, Lawrence and Don Mills, Fairview Mall, or Sheppard and Victoria Park. corridor lists the streets to follow in order, each one a TTC route runs along: Don Mills Road, Leslie Street, Eglinton Avenue East, Lawrence Avenue East, Sheppard Avenue East, Victoria Park Avenue. The service builds the line only along those routes' shapes and refuses a corridor it can't snap, with why. It returns the option with its length in km, its stations at the planner-set spacing, and its cost from the study's cost per km, optimism bias and contingency. note is one line on why this terminus, such as an interchange or the riders on its routes. Planners decide between options.",
  },
  "POST /v1/studies/:id/needs": {
    name: "add_engagement_need",
    description:
      "Propose something to make so people in one neighbourhood hear about a change: an image such as a poster, a short video, or both. Pin it to a point on the study's route with lon and lat, name the place, give one sentence on why, and cite the pages it rests on. Nothing is made until a planner asks.",
  },
  "POST /v1/studies/:id/documents": {
    name: "create_document",
    description:
      'Make a PDF of the study for planners: kind "report" (portrait pages) or "slides" (16:9, at most 5 points a slide). Give a title and sections, each a heading and its points. A point is plain words, or {text, citation} with a citation as a finding has one: contextId, page and a quote that is on that page, word for word. Reuse the citations get_study shows on the study\'s findings. A point whose quote isn\'t on its page is refused with which one, so fix it and call again. The PDF says it is a draft first pass and lists its sources. Returns its url and link.',
  },
  "POST /v1/studies/:id/needs/:need/create": {
    name: "request_engagement_media",
    description:
      "Ask for an engagement need's image or video to be made. Asking again changes nothing while a request is open. After a failure, it asks again. Planners, or a visitor in their own sandbox.",
  },
  "POST /v1/studies/:id/needs/:need/dismiss": {
    name: "dismiss_engagement_need",
    description:
      "Drop an engagement need nobody has to make any more, such as one for a change that won't go ahead, with a reason. Its images and videos stop being shown. Planners only.",
  },
  "POST /v1/studies/:id/needs/:need/media/:media/withdraw": {
    name: "withdraw_engagement_media",
    description: "Take down one generated image or video that shouldn't be shown, with a reason. The need is needed again. Planners only.",
  },
  "GET /v1/datasets": {
    name: "list_datasets",
    description:
      "List the open datasets the GIS tools work on: each one's id, publisher, licence, retrieval date, what it covers, what to know before using it, and for census areas, the variables overlay can total.",
  },
  "GET /v1/studies/:id/layers": {
    name: "list_layers",
    description: "List a study's map layers, newest last: id, title, kind, feature count, dataset and the operation that made each.",
  },
  "GET /v1/studies/:id/layers/:layer": {
    name: "summarise_layer",
    description:
      "Summarise one map layer: its size (area in km² or length in km), its totals with the figure recording each, how they were weighted, warnings, and its first 10 rows, largest share first.",
  },
  "POST /v1/studies/:id/gis/route-stops": {
    name: "route_stops",
    description:
      "Save a TTC route's stops as a map layer, from the GTFS: every stop its trips call at, all branches and both directions. Give the route number, such as 52. Returns the layer.",
  },
  "POST /v1/studies/:id/gis/route-shape": {
    name: "route_shape",
    description: "Save a TTC route's main shapes as a map layer of lines, from the GTFS. Give the route number, such as 52.",
  },
  "POST /v1/studies/:id/gis/study-line": {
    name: "study_line",
    description: "Save this study's line, as the map draws it, built and proposed parts, as a layer of lines. Buffer it for a corridor.",
  },
  "POST /v1/studies/:id/gis/area": {
    name: "named_area",
    description:
      "Save one named area as a map layer, to work within: a neighbourhood from toronto-neighbourhoods, such as Thorncliffe Park, or a Neighbourhood Improvement Area from toronto-nia.",
  },
  "POST /v1/studies/:id/gis/buffer": {
    name: "buffer",
    description:
      "Buffer a layer by some metres, such as 400 for a walk to a bus stop, into one area, saved as a new layer. Overlapping circles count once.",
  },
  "POST /v1/studies/:id/gis/overlay": {
    name: "overlay",
    description:
      "Overlay an area layer, such as a buffer, with an area dataset from list_datasets: census-da-2021 for people, households, low income and commuting; toronto-nia or toronto-neighbourhoods for which areas it touches. Each area counts in proportion to its land inside the layer, an estimate that assumes even spread. Saves the areas as a layer and records the totals as figures: for census, the variables you name, or population and households.",
  },
  "POST /v1/studies/:id/gis/points-within": {
    name: "points_within",
    description:
      "Count a point dataset's points inside an area layer: toronto-ksi collisions (narrow by years from and to, fatal, or involving a pedestrian, cyclist or motorcyclist), ttc-gtfs stops, or toronto-heritage-corridor properties. Saves the points as a layer and records the counts as figures.",
  },
  // Road safety and active transportation, which only their skills' own tools call.
  "POST /v1/studies/:id/gis/ksi-profile": {
    name: "ksi_profile",
    description:
      "Profile police-reported KSI collisions inside an area layer: by year, road user, severity, intersection or mid-block, dark, and time of day, with the people killed and seriously injured. Narrow by years from and to, or involving a pedestrian, cyclist or motorcyclist. Saves a layer and records the main counts as figures citing toronto-ksi-detail.",
  },
  "POST /v1/studies/:id/gis/ksi-hotspots": {
    name: "ksi_hotspots",
    description:
      "Rank the places inside an area layer with the most KSI collisions: collisions within radius metres (default 30) count as one place, named by the streets police recorded. Returns the top places (default 10) with their counts, and saves them as a layer.",
  },
  "POST /v1/studies/:id/gis/ksi-trend": {
    name: "ksi_trend",
    description:
      "Compare KSI collisions a year inside an area layer before and from a split year, over whole years only (default: the last ten, split in half), against the whole city's change, with an exact test of whether chance alone could give the change. Saves a layer and records the counts and change as figures.",
  },
  "POST /v1/studies/:id/gis/cycling": {
    name: "cycling_within",
    description:
      "Measure the City's cycling network inside an area layer: km of separated cycle tracks, painted bike lanes, multi-use trails and shared roads, and by the City's own type. Saves the segments as a layer and records the km as figures.",
  },
  "POST /v1/studies/:id/gis/sidewalks": {
    name: "sidewalks_within",
    description:
      "Measure streets inside an area layer by their sidewalks, from the City's 2017 inventory: km with sidewalks on both sides, one side, partial or none, and the share with none. Saves the streets as a layer and records the totals as figures.",
  },
  "POST /v1/studies/:id/gis/bike-share": {
    name: "bike_share_within",
    description: "Count Bike Share Toronto stations and their docks inside an area layer. Saves them as a layer and records the counts as figures.",
  },
  "POST /v1/studies/:id/gis/first-last-mile": {
    name: "first_last_mile",
    description:
      "For each stop of a points layer, such as route_stops makes: the nearest bike share station, the stations within metres, and the km of bikeway within metres. Saves two layers, bike share and bikeways, records how many stops have each within reach, and lists stops with neither.",
  },
  ...GIS_SKILL_TOOLS,
  "POST /v1/studies/:id/activity": {
    name: "report_activity",
    description: "Report progress, messages, tokens and cost. Report usage only with numbers you were given.",
  },
  "POST /v1/studies/:id/preview": {
    name: "preview_change",
    description: "Try other values for rules or figures, and see the study's results. Writes nothing.",
  },
  "GET /v1/studies/:id/figures/:figure/trace": {
    name: "trace_figure",
    description: "Trace a figure back to its sources, through the figures and rules it depends on.",
  },
  "GET /v1/studies/:id/compare": {
    name: "compare_versions",
    description: "See what changed in a study between two log positions, and why.",
    query: {
      from: { type: "integer", minimum: 0, description: "Log position to compare from. Default 0" },
      to: { type: "integer", minimum: 0, description: "Log position to compare to. Default the latest" },
    },
  },
  "GET /v1/studies/:id/timeline": {
    name: "get_timeline",
    description: "See measured results and forecasts from today to the review date.",
  },
  "GET /v1/assumptions": {
    name: "list_rules",
    description: "List the rules and assumptions planners have set, with their history. Check thresholds come only from these.",
  },
  "GET /v1/usage": {
    name: "get_usage",
    description:
      "Everything agents have spent: tokens and cost, in total, with visitors' sandboxes added in, and by study, for the shared record. Each comes with an estimate of the energy, CO2e and water its model calls used: a floor, counting each call as a median Gemini prompt, with the source.",
  },
  "GET /v1/log": {
    name: "read_log",
    description: "Read the log of everything that happened, from a position.",
    query: {
      after: { type: "integer", minimum: 0, description: "Read entries after this log position. Default 0" },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Most entries to return. Default 200" },
    },
  },
  "GET /v1/log/verify": {
    name: "verify_log",
    description: "Check the log's hash chain, and get the hash of the latest entry you can read.",
  },
  "GET /v1/log/head": {
    name: "get_log_head",
    description: "Read the latest log position and hash you can read, to keep as a witness.",
  },
  "GET /v1/live/vehicles": {
    name: "live_vehicles",
    description: "Latest live vehicle positions for the given routes.",
    query: { routes: { type: "string", description: "Route numbers, comma-separated, such as 52,11" } },
  },
  "GET /v1/budget": {
    name: "get_budget",
    description: "What is left of today's visitor budget for the visitor this session acts for.",
  },
  "PUT /v1/studies/:id/findings/:finding/tone": {
    name: "rate_finding",
    description: "Rate how a finding reads. Planners, or a visitor in their own sandbox.",
  },
  "POST /v1/studies/:id/figures/:figure/accept": {
    name: "accept_figure",
    description: "Accept a skill's result so it can pass or fail a check. Planners, or a visitor in their own sandbox.",
  },
  "POST /v1/studies/:id/decisions": {
    name: "record_decision",
    description: "Record a decision on a study, with a reason. Planners only.",
  },
  "PUT /v1/assumptions/:key": {
    name: "set_rule",
    description: "Set or change a rule or assumption, with a reason. Planners, or a visitor in their own sandbox.",
  },
  "GET /v1/skills": {
    name: "list_approved_skills",
    description: "Each skill's approved versions: the SHA-256 content hashes of its folder that a planner approved. The agents' own code loads only these.",
  },
  "PUT /v1/skills/:name": {
    name: "approve_skill",
    description: "Approve a skill version, its folder's SHA-256 content hash, so agents may load it and its results can enter studies. Planners only.",
  },
  "POST /v1/log/:seq/remove-content": {
    name: "remove_content",
    description: "Remove a log entry's content for retention or privacy. The entry and the hash chain stay. For a visitor's entry, give their audience. Planners only.",
  },
};

// Routes that are not tools, and why. A test fails if a /v1 route is in neither
// list. The multipart form of POST /v1/context isn't a tool either: add_source
// sends JSON.
export const NOT_TOOLS: Record<string, string> = {
  "GET /v1/events": "A stream that never ends. read_log reads the same entries",
  "POST /v1/subscriptions": "Webhooks are for integrations",
  "ALL /v1/mcp": "This endpoint",
  "GET /v1/config": "Sign-in settings for the display. An agent has no use for them",
  "POST /v1/studies/:id/needs/:need/claim": "Only the media agent's own code claims a request, so no model can take one on, or close one, by mistake",
  "POST /v1/studies/:id/needs/:need/failed": "Only the agent holding the request's claim says it failed, from its own code",
  "POST /v1/skills/:name/candidates": "Only the skill-evolution loop's own code puts a version forward, after its gate, so no model can by mistake",
  "POST /v1/studies/:id/needs/:need/media": "A video is larger than an MCP message may be (4 MiB), so an agent posts the file here with its token",
  "GET /v1/media/:id": "Image and video bytes, for people to see. Each study's needs list their media",
  "GET /v1/tiles/imagery/:z/:x/:y": "Aerial photo tiles, for the display's map to draw",
  "GET /v1/studies/:id/layers/:layer/geojson": "A layer's features, for the display's map. Too large for a model; summarise_layer gives an agent its totals and first rows",
  "POST /v1/guests": "Guest passes are for the display",
  "POST /v1/track": "Page views the display reports, for a Discord channel. An agent never visits a page",
  "POST /v1/studies/:id/escalate": "A person's button under an answer: only a planner pings the executive on Slack, never an agent",
  "POST /v1/studies/:id/findings/:finding/review": "A person's button on an option's card. An agent proposes options, and only people hand one over for review",
  "POST /v1/studies/:id/findings/:finding/renders": "A person's button on an option's card. An agent proposes needs itself with add_engagement_need",
};

// Path parameters become arguments. ":id" is named for what it identifies; the
// others keep the API's names.
const ID_NAMES: Record<string, string> = { context: "contextId", studies: "studyId" };
const PATH_ARGUMENTS: Record<string, JsonSchema> = {
  contextId: { type: "string", description: "Source id, from list_sources" },
  studyId: { type: "string", description: "Study id" },
  page: { type: "integer", minimum: 1, description: "Page number" },
  figure: { type: "string", description: "Figure id" },
  finding: { type: "string", description: "Finding id" },
  need: { type: "string", description: "Engagement need id, from the study's needs" },
  layer: { type: "string", description: "Map layer id, from list_layers" },
  media: { type: "string", description: "Media id, its sha256, from the need's media" },
  key: { type: "string", description: "Rule key, from list_rules" },
  name: { type: "string", description: "Skill name" },
  seq: { type: "integer", minimum: 1, description: "Log position of the entry" },
};

function pathArguments(path: string): string[] {
  const segments = path.split("/");
  return segments.flatMap((segment, i) => {
    if (!segment.startsWith(":")) return [];
    const name = segment === ":id" ? ID_NAMES[segments[i - 1] ?? ""] : segment.slice(1);
    if (!name || !PATH_ARGUMENTS[name]) throw new Error(`Name and describe the argument for ${segment} in ${path}`);
    return [name];
  });
}

// google-genai, which turns these tools into Gemini function declarations, drops
// "oneOf" and "const". "anyOf" and an enum of one value say the same, and survive.
function bodySchema(body: z.ZodType): JsonSchema {
  const schema = z.toJSONSchema(body, {
    io: "input",
    unrepresentable: "any",
    override: ({ jsonSchema }) => {
      if (jsonSchema.oneOf) {
        jsonSchema.anyOf = jsonSchema.oneOf;
        delete jsonSchema.oneOf;
      }
      if (jsonSchema.const !== undefined) {
        jsonSchema.enum = [jsonSchema.const];
        delete jsonSchema.const;
      }
    },
  }) as JsonSchema;
  return schema.anyOf ? merge(schema.anyOf) : schema;
}

// A body that is a union, such as report_activity's kinds, becomes one object with
// every kind's fields, each saying which kinds use it. A tool's input has to be an
// object, and a model fills one flat object reliably. The route still checks each
// kind's fields.
function merge(variants: JsonSchema[]): JsonSchema {
  const tag = Object.keys(variants[0]?.properties ?? {}).find((key) =>
    variants.every((variant) => variant.properties?.[key]?.enum?.length === 1),
  );
  const tagOf = (variant: JsonSchema) => String(tag ? variant.properties?.[tag]?.enum?.[0] : "");
  const properties: Record<string, JsonSchema> = {};
  const usedBy: Record<string, string[]> = {};
  for (const variant of variants) {
    for (const [key, schema] of Object.entries(variant.properties ?? {})) {
      properties[key] ??= schema;
      (usedBy[key] ??= []).push(tagOf(variant));
    }
  }
  if (tag) {
    properties[tag] = { type: "string", enum: variants.map(tagOf) };
    for (const [key, kinds] of Object.entries(usedBy)) {
      if (kinds.length < variants.length) properties[key] = { ...properties[key], description: `For ${tag} ${kinds.join(" or ")}` };
    }
  }
  const required = Object.keys(properties).filter((key) => variants.every((variant) => variant.required?.includes(key)));
  return { type: "object", properties, required };
}

type McpTool = { definition: Tool; route: ApiRoute; path: string[]; query: string[] };

function buildTools(routes: readonly ApiRoute[]): McpTool[] {
  return Object.entries(TOOLS).map(([key, spec]) => {
    const route = routes.find((r) => `${r.method.toUpperCase()} ${r.path}` === key);
    if (!route) throw new Error(`No route ${key} for the ${spec.name} tool`);
    const path = pathArguments(route.path);
    const properties: Record<string, JsonSchema> = {};
    for (const name of path) properties[name] = PATH_ARGUMENTS[name] as JsonSchema;
    Object.assign(properties, spec.query);
    const required = [...path, ...(spec.required ?? [])];
    if (route.body) {
      const body = bodySchema(route.body);
      for (const [name, schema] of Object.entries(body.properties ?? {})) {
        if (name in properties) throw new Error(`${spec.name}: "${name}" is both a body field and an argument`);
        properties[name] = schema;
      }
      required.push(...(body.required ?? []));
    }
    const inputSchema: Tool["inputSchema"] = { type: "object", properties, ...(required.length ? { required } : {}) };
    return { definition: { name: spec.name, description: spec.description, inputSchema }, route, path, query: Object.keys(spec.query ?? {}) };
  });
}

type Requester = { request(input: URL, init: RequestInit): Response | Promise<Response> };
// onBehalfOf is the visitor the session acts for, which each tool call carries on.
type Caller = { origin: string; authorization: string | undefined; onBehalfOf: string | undefined };

const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

// An MCP client reads only JSON-RPC errors. So when /v1/mcp itself refuses a
// request, for a missing or unknown token say, the API's status, code and message
// come as one. -32000 is the code the SDK's transport gives requests it refuses.
export const rpcError = (status: number, code: string, message: string) => ({
  jsonrpc: "2.0",
  id: null,
  error: { code: -32000, message: `${status} ${code}: ${message}` },
});

async function call(app: Requester, tool: McpTool, args: Record<string, unknown>, caller: Caller): Promise<CallToolResult> {
  const rest = { ...args };
  const values: string[] = [];
  for (const name of tool.path) {
    const value = rest[name];
    delete rest[name];
    if (value === undefined || value === null || value === "") return failure(`Missing argument "${name}"`);
    values.push(encodeURIComponent(String(value)));
  }
  const url = new URL(tool.route.path.replace(/:\w+/g, () => values.shift() as string), caller.origin);
  for (const name of tool.query) {
    const value = rest[name];
    delete rest[name];
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const response = await app.request(url, {
    method: tool.route.method.toUpperCase(),
    headers: {
      "content-type": "application/json",
      ...(caller.authorization ? { authorization: caller.authorization } : {}),
      ...(caller.onBehalfOf !== undefined ? { [ON_BEHALF_OF]: caller.onBehalfOf } : {}),
    },
    ...(tool.route.body ? { body: JSON.stringify(rest) } : {}),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  // An error keeps the API's status, code and message, so a model can correct itself.
  if (!response.ok) {
    const error = (data as { error?: { code: string; message: string } } | undefined)?.error;
    return failure(error ? `${response.status} ${error.code}: ${error.message}` : `${response.status} ${text}`);
  }
  const isObject = typeof data === "object" && data !== null && !Array.isArray(data);
  return { content: [{ type: "text", text }], ...(isObject ? { structuredContent: data as Record<string, unknown> } : {}) };
}

// An IP address or localhost: a name no other site can point at this service.
export const fixedAddress = (url: URL) => url.hostname === "localhost" || isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) !== 0;

// Refuses a browser request from a page on another site, or another port. Browsers
// send Origin with every POST and PUT, and say when a request is cross-site, so a
// page elsewhere can't write here, even to a local service with open access.
// Server-side clients send neither. After DNS rebinding, an attacker's page reaches
// this service under the attacker's own name, and its Host and Origin agree. So the
// request's own origin counts only at an IP address or localhost. Any other name
// must be PUBLIC_URL's.
export function checkOrigin(request: { url: string; header(name: string): string | undefined }, publicOrigin: string | undefined) {
  const origin = request.header("origin");
  const own = new URL(request.url);
  const allowed = [publicOrigin, fixedAddress(own) ? own.origin : undefined];
  if (request.header("sec-fetch-site") === "cross-site" || (origin !== undefined && !allowed.includes(origin))) {
    throw new ApiError(403, "forbidden_origin", `Requests from ${origin ?? "another site"} are not allowed`);
  }
}

// The handler for /v1/mcp. `app` is the app it is mounted on, and `routes` that
// app's route table.
export function mcp(app: Requester, routes: readonly ApiRoute[], { publicUrl }: { publicUrl?: string } = {}) {
  const tools = buildTools(routes);
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined;

  return async (c: Context<{ Variables: { actor: Actor } }>) => {
    // A page on another site can't use this endpoint, even with GET.
    checkOrigin(c.req, publicOrigin);
    const own = new URL(c.req.url);
    // Stateless: there is no session to end and no stream to open.
    if (c.req.method !== "POST") {
      return c.json(rpcError(405, "method_not_allowed", "Send MCP messages with POST"), 405, { allow: "POST" });
    }

    const { role } = c.get("actor");
    const caller = { origin: own.origin, authorization: c.req.header("authorization"), onBehalfOf: c.req.header(ON_BEHALF_OF) };
    const server = new Server({ name: "transit-agents", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.filter((tool) => tool.route.roles.includes(role)).map((tool) => tool.definition),
    }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      const tool = tools.find((t) => t.definition.name === params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      return call(app, tool, params.arguments ?? {}, caller);
    });
    // A cancel can only reach a call in the same POST, and that call runs to the end
    // anyway. The SDK's own handler would leave the call unanswered, and a JSON reply
    // waits for every answer, so the POST would get none.
    server.setNotificationHandler(CancelledNotificationSchema, () => {});

    // A server and transport for each request, answering in JSON: no tool streams.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  };
}
