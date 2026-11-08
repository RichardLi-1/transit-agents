// Agents connect over MCP at /v1/mcp: Streamable HTTP, stateless. Each tool is one
// route in app.ts, and each call goes back through the app as an ordinary request
// with the caller's token. So roles, validation, citation checks, idempotency and
// the log treat a tool call exactly like the same REST call, and none of that is
// repeated here.
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
import type { Role } from "@transit-agents/contracts";
import type { Context } from "hono";
import { z } from "zod";
import type { Actor } from "./app.ts";
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

type Spec = { name: string; description: string; query?: Record<string, JsonSchema> };

export const INSTRUCTIONS = [
  "Transit Agents holds transit planning studies: agents do the first pass, and every figure must trace to the page it came from.",
  "Read a source page with read_page before citing it.",
  "Every figure needs a basis: a quote that is on the cited page and contains the value, a formula over other figures and planner-set rules, or a planner-approved skill.",
  "Rule thresholds come only from list_rules.",
  "Only planners decide. They set rules, rate findings, accept skill results and record decisions.",
  'After each model call, report its tokens and cost with report_activity, kind "usage".',
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
  "POST /v1/studies/:id/activity": {
    name: "report_activity",
    description: "Report progress, messages, tokens and cost. After each model call, report kind usage with the model, tokens and cost.",
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
    description: "Tokens and cost, in total and by study.",
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
    description: "Check the log's hash chain.",
  },
  "GET /v1/log/head": {
    name: "get_log_head",
    description: "Read the latest log position and hash, to keep as a witness.",
  },
  "GET /v1/live/vehicles": {
    name: "live_vehicles",
    description: "Latest live vehicle positions for the given routes.",
    query: { routes: { type: "string", description: "Route numbers, comma-separated, such as 52,11" } },
  },
  "PUT /v1/studies/:id/findings/:finding/tone": {
    name: "rate_finding",
    description: "Rate how a finding reads. Planners only.",
  },
  "POST /v1/studies/:id/figures/:figure/accept": {
    name: "accept_figure",
    description: "Accept a skill's result so it can pass or fail a check. Planners only.",
  },
  "POST /v1/studies/:id/decisions": {
    name: "record_decision",
    description: "Record a decision on a study, with a reason. Planners only.",
  },
  "PUT /v1/assumptions/:key": {
    name: "set_rule",
    description: "Set or change a rule or assumption, with a reason. Planners only.",
  },
  "PUT /v1/skills/:name": {
    name: "approve_skill",
    description: "Approve a skill version, so its results can enter studies. Planners only.",
  },
  "POST /v1/log/:seq/remove-content": {
    name: "remove_content",
    description: "Remove a log entry's content for retention or privacy. The entry and the hash chain stay. Planners only.",
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
    const required = [...path];
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
type Caller = { origin: string; authorization: string | undefined };

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
    headers: { "content-type": "application/json", ...(caller.authorization ? { authorization: caller.authorization } : {}) },
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
const fixedAddress = (url: URL) => url.hostname === "localhost" || isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) !== 0;

// The handler for /v1/mcp. `app` is the app it is mounted on, and `routes` that
// app's route table.
export function mcp(app: Requester, routes: readonly ApiRoute[], { publicUrl }: { publicUrl?: string } = {}) {
  const tools = buildTools(routes);
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined;

  return async (c: Context<{ Variables: { actor: Actor } }>) => {
    // Browsers send Origin with every POST, so a page on another site can't use
    // this endpoint, even on a local service with open access. Server-side
    // clients send none. After DNS rebinding, an attacker's page reaches this
    // service under the attacker's own name, and its Host and Origin agree. So
    // the request's own origin counts only at an IP address or localhost. Any
    // other name must be PUBLIC_URL's.
    const origin = c.req.header("origin");
    const own = new URL(c.req.url);
    const allowed = [publicOrigin, fixedAddress(own) ? own.origin : undefined];
    if (origin !== undefined && !allowed.includes(origin)) {
      throw new ApiError(403, "forbidden_origin", `Requests from ${origin} are not allowed`);
    }
    // Stateless: there is no session to end and no stream to open.
    if (c.req.method !== "POST") {
      return c.json(rpcError(405, "method_not_allowed", "Send MCP messages with POST"), 405, { allow: "POST" });
    }

    const { role } = c.get("actor");
    const caller = { origin: own.origin, authorization: c.req.header("authorization") };
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
