// The HTTP surface. Every route is declared once in `routes`, which both registers
// it and generates /openapi.json, so the published API can't drift from the code.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context as HonoContext } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ActiveLayerRequest,
  FirstLastMileRequest,
  KsiHotspotsRequest,
  KsiProfileRequest,
  KsiTrendRequest,
} from "@transit-agents/contracts";
import {
  Activity,
  AreaRequest,
  BufferRequest,
  ContentRemoval,
  OverlayRequest,
  PointsWithinRequest,
  RouteLayerRequest,
  StudyLineRequest,
  EXECUTIVE,
  executiveDecision,
  NewEscalation,
  FindingRating,
  MEDIA_MAX_BYTES,
  NeedClaim,
  NeedFailure,
  NeedWithdrawal,
  NewAssumption,
  NewCheck,
  NewContext,
  NewDecision,
  NewFigure,
  NewAlignment,
  NewFinding,
  NewDocument,
  NewMedia,
  NewNeed,
  NewSkill,
  NewStudy,
  NewSubscription,
  AUDIENCE,
  ON_BEHALF_OF,
  SIGN_IN_TO_DECIDE,
  type AccessMode,
  type GuestPass,
  type Me,
  type Role,
  type ServiceConfig,
  type SignIn,
  type VisitorBudget as BudgetView,
} from "@transit-agents/contracts";
import type { VisitorBudget } from "./budget.ts";
import { extractPages } from "./extract.ts";
import { GIS_SKILL_ROUTES } from "./gis-skills.ts";
import { activeLayer, firstLastMileLayer } from "./gis-active.ts";
import { ksiHotspotsLayer, ksiProfileLayer, ksiTrendLayer } from "./gis-safety.ts";
import { issueGuest, userAudience, verifyGuest } from "./guests.ts";
import type { ImageryTiles } from "./imagery.ts";
import { EVERYONE, visible, type Entry } from "./log.ts";
import { VisitorLimits } from "./limits.ts";
import { aiFetchMessage, matchAiFetcher, readVisit, visitMessage, type Visits } from "./visits.ts";
import { checkOrigin, fixedAddress, mcp, rpcError } from "./mcp.ts";
import { byteRange, formParts } from "./media.ts";
import { ApiError, type MediaFile, type Service } from "./service.ts";
import { DEFAULT_EXECUTIVE, escalation, gist, studyLink, type Executive, type Slack } from "./slack.ts";
import type { Webhooks } from "./webhooks.ts";

export type Actor = { role: Role; name: string };

// A verifier can also say who stands behind a token, such as its Auth0 subject.
// Two people can share a name, but not a subject.
export type Verified = Actor & { subject?: string };

export type AppOptions = {
  service: Service;
  webhooks: Webhooks;
  tokens: Map<string, Actor>;
  // Checks a bearer token that isn't one of `tokens`, such as an Auth0 access
  // token. Resolves to undefined when the token doesn't check out.
  verifyToken?: (token: string) => Promise<Verified | undefined>;
  // What a request without a token may do. In "token" mode, every /v1 request
  // needs a token. "demo" is for a public demo: a request without one reads as a
  // viewer, and writes still need a token. "open" makes it a local planner, for a
  // machine you control. A token that is sent is always checked, in every mode.
  access: AccessMode;
  // In "open" mode, the name of the planner a request without a token acts as,
  // such as the presenter's, so their decisions carry it. "local" without one.
  openName?: string;
  // How people sign in. /v1/config tells the display.
  signIn?: SignIn | null;
  // Hosts webhooks may send to. Except in open mode, an empty list allows none,
  // so nothing can be sent anywhere nobody approved.
  webhookHosts?: string[];
  staticDir?: string;
  live?: { vehicles: (routes: string[]) => unknown };
  // A study's timeline, as the caller sees the study.
  timeline?: (studyId: string, view: Service) => unknown;
  // The address people reach the service at, when it differs from the one it
  // serves on. MCP accepts browser requests from it.
  publicUrl?: string;
  // With a secret, and only in demo mode, the service gives out guest passes. A
  // visitor with one can do what a planner does, in a sandbox of their own,
  // except decide.
  guests?: { secret: string };
  // Today's Gemini spend for visitors, which their messages and media requests
  // must leave room in.
  budget?: VisitorBudget;
  // How often a visitor may write.
  limits?: VisitorLimits;
  // The static agent tokens, by name, that may act for a visitor with X-On-Behalf-Of.
  visitorAgents?: string[];
  // Slack, for a planner's ping about a decision above their authority, and who it
  // goes to, from SLACK_EXECUTIVE. Without Slack, a ping is refused.
  slack?: Pick<Slack, "sendAndWait"> | null;
  executive?: Executive;
  clock?: () => Date;
  // Aerial photo tiles for the map, kept on disk. Without them, there are none.
  imagery?: Pick<ImageryTiles, "get">;
  // Page views, bounces and AI assistants' fetches, to a Discord channel, from
  // DISCORD_WEBHOOK_URL. Without it, /v1/track takes them and sends nothing.
  visits?: Pick<Visits, "take" | "send"> | null;
};

// The principal is the credential behind a request, which a name alone can't tell
// apart. The audience is the visitor whose sandbox the request reads and writes:
// null for the shared record. Everyone is set only when one of the service's own
// agents reads the whole log, every sandbox with it.
type Env = { Variables: { actor: Actor; principal: string; anonymous?: boolean; audience: string | null; everyone: boolean } };

// Who a request without a token acts as, in each mode.
const ANONYMOUS: Record<AccessMode, Actor | undefined> = {
  token: undefined,
  open: { role: "planner", name: "local" },
  demo: { role: "viewer", name: "demo" },
};

const anyone: Role[] = ["viewer", "integration", "agent", "planner", "guest"];
const contributors: Role[] = ["integration", "agent", "planner"];
const authors: Role[] = ["agent", "planner"];
const planners: Role[] = ["planner"];
// Generated media comes only from agents, while a request is open.
const agents: Role[] = ["agent"];
// What a planner does that a visitor may also do, in their own sandbox.
const people: Role[] = ["planner", "guest"];
// Agents can't create subscriptions: one could otherwise send the log anywhere.
const integrators: Role[] = ["integration", "planner"];

// Bodies are read only up to a limit, so nobody can make the service hold a huge
// one. Context can be a whole document, so a contributor gets more room for it.
// An agent uploading media gets room for the largest video and its fields.
const BODY_LIMIT = 1024 * 1024;
const CONTEXT_LIMIT = 50 * 1024 * 1024;
// Room for an upload's fields and the form around its file.
const FORM_ROOM = 64 * 1024;
const MEDIA_UPLOAD = /^\/v1\/studies\/[^/]+\/needs\/[^/]+\/media$/;
// Uploads read at once. Each is held in memory while it's checked.
const UPLOADS_AT_ONCE = 2;

// Why a visitor can't do something only planners and agents do.
const SIGN_IN_AS_PLANNER = "Sign in as a planner to do this.";

// A second ping about the same answer within this long is a repeat, and refused.
const PING_REPEAT_MS = 10 * 60_000;
const clockTime = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// A whole number from a query, kept within bounds. Anything else is the fallback.
function whole(value: string | undefined, fallback: number, low: number, high: number): number {
  const number = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), low), high);
}

const Preview = z.object({
  assumptions: z.record(z.string(), z.number()).optional(),
  figures: z.record(z.string(), z.number()).optional(),
});

// JSON bodies must say so. A page on another site can send text/plain without
// asking the browser's permission, but not application/json.
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

async function bodyOf<S extends z.ZodType>(c: HonoContext<Env>, schema: S): Promise<z.output<S>> {
  if (!JSON_TYPE.test(c.req.header("content-type") ?? "")) {
    throw new ApiError(415, "unsupported_media_type", "Send the body as JSON, with content-type: application/json");
  }
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(400, "invalid_body", z.prettifyError(parsed.error));
  return parsed.data;
}

const actorName = (c: HonoContext<Env>) => {
  const { role, name } = c.get("actor");
  return `${role}:${name}`;
};

// A multipart body: the form's fields, each JSON when it isn't a string, and the file.
function multipart(form: z.ZodType) {
  const schema = z.toJSONSchema(form, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  const json = Object.entries(schema.properties ?? {}).filter(([, field]) => field.type === "array" || field.type === "object");
  return {
    schema: {
      ...schema,
      properties: { ...schema.properties, file: { type: "string", format: "binary" } },
      required: [...(schema.required ?? []), "file"],
    },
    encoding: Object.fromEntries(json.map(([name]) => [name, { contentType: "application/json" }])),
  };
}

// Media is named by its hash, so a copy never goes stale, but a planner can take a
// file down, so each use checks it is still there: a 304 when it is. Browsers play
// and seek video by asking for ranges of it.
function serveMedia(c: HonoContext<Env>, file: MediaFile): Response {
  const etag = `"${file.id}"`;
  const headers: Record<string, string> = {
    "content-type": file.type,
    // A visitor's media is theirs, so no shared cache keeps a copy.
    "cache-control": `${file.private ? "private" : "public"}, no-cache`,
    etag,
    "accept-ranges": "bytes",
    // A name the service chose, never an upload's, and safe in a header.
    "content-disposition": `inline; filename="${file.filename}"`,
    // A PDF opens in the browser's own viewer, which the display's policy would block.
    ...(file.type === "application/pdf" ? { "content-security-policy": PDF_POLICY } : {}),
  };
  const cached = c.req.header("if-none-match")?.split(",").map((tag) => tag.trim().replace(/^W\//, ""));
  if (cached?.includes(etag) || cached?.includes("*")) return c.body(null, 304, headers);
  const range = byteRange(c.req.header("range"), file.size);
  if (range === null) return c.body(null, 416, { ...headers, "content-range": `bytes */${file.size}` });
  const [start, end] = range ?? [0, file.size - 1];
  headers["content-length"] = String(end - start + 1);
  if (range) headers["content-range"] = `bytes ${start}-${end}/${file.size}`;
  const status = range ? 206 : 200;
  if (c.req.method === "HEAD") return c.body(null, status, headers);
  return c.body(Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream, status, headers);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

// A PDF the service made, opened in a tab of its own, where no other page may frame
// it. Chrome's viewer runs as a plugin, which the display's object-src 'none' would
// block, so a PDF has this policy instead.
const PDF_POLICY = "object-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// When people can sign in, the page talks to the Auth0 tenant, and renews their
// token in a hidden frame from it. The manifest, which makes the display an app
// Chrome can install, comes from the service too.
function securityHeaders(signIn: SignIn | null): Record<string, string> {
  const tenant = signIn ? ` https://${signIn.domain}` : "";
  const policy = [
    "default-src 'self'",
    "img-src 'self' data:",
    "media-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "manifest-src 'self'",
    `connect-src 'self'${tenant}`,
    ...(signIn ? [`frame-src 'self'${tenant}`] : []),
    "base-uri 'none'",
    "form-action 'none'",
    // Its own pages only, so the display can show the simulator in a tab.
    "frame-ancestors 'self'",
    "object-src 'none'",
  ];
  return {
    "content-security-policy": policy.join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
  };
}

// A planner's name for open mode, from PLANNER_NAME: letters, numbers, spaces and
// . ' -, at most 80, so it reads well in the log as role:name. Undefined otherwise.
export function plannerName(raw: string | undefined): string | undefined {
  const name = raw?.trim().replace(/\s+/g, " ");
  return name && /^[\p{L}\p{N} .'-]{1,80}$/u.test(name) ? name : undefined;
}

export function createApp(options: AppOptions) {
  const { service, webhooks, tokens, verifyToken, access, signIn = null, staticDir, live, timeline, webhookHosts = [] } = options;
  const { budget, visitorAgents = [], clock = () => new Date() } = options;
  const slack = options.slack ?? null;
  const executive = options.executive ?? { name: DEFAULT_EXECUTIVE };
  // Each answer's last ping, by study and answer: when it went, or 0 while it's going.
  const pinged = new Map<string, number>();
  // Guest passes are for a public demo. In token mode they would let anyone in.
  const guests = access === "demo" ? options.guests : undefined;
  const limits = options.limits ?? new VisitorLimits({ clock });
  const anonymous: Actor | undefined = access === "open" && options.openName ? { role: "planner", name: options.openName } : ANONYMOUS[access];
  // A person who signs in can't act as a static token, or as whoever a request
  // without a token acts as. Otherwise the log couldn't tell them apart.
  const taken = new Set([...tokens.values(), ...Object.values(ANONYMOUS), anonymous].map((actor) => actor && `${actor.role}:${actor.name}`));
  const headers = securityHeaders(signIn);
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    // A PDF keeps the policy it was served with.
    const own = c.res.headers.get("content-type") === "application/pdf" ? ["content-security-policy"] : [];
    for (const [key, value] of Object.entries(headers)) if (!own.includes(key)) c.header(key, value);
  });

  app.onError((error, c) => {
    if (!(error instanceof ApiError)) console.error(error);
    const { status, code, message } = error instanceof ApiError ? error : new ApiError(500, "internal", "Something went wrong");
    // MCP clients read only JSON-RPC errors.
    if (c.req.path === "/v1/mcp") return c.json(rpcError(status, code, message), status as 400);
    return c.json({ error: { code, message } }, status as 400);
  });

  // Writes come only from this service's own pages, or from clients that aren't
  // browsers, whatever token they hold. Without this, under open access any page
  // on any site could act as the local planner: record decisions, or start paid
  // agent runs from the chat.
  const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") checkOrigin(c.req, publicOrigin);
    await next();
  });

  // Public routes need no token and read none, so a client holding a stale token
  // can still find out how to sign in, and an <img> can show media. Filled in as
  // routes are registered. A HEAD request is answered as its GET.
  const publicRoutes: { method: string; path: RegExp }[] = [];
  const isPublic = (method: string, path: string) =>
    publicRoutes.some((route) => route.method === (method === "HEAD" ? "GET" : method) && route.path.test(path));
  app.use("/v1/*", async (c, next) => {
    if (isPublic(c.req.method, c.req.path)) return next();
    c.set("audience", null);
    c.set("everyone", false);
    const header = c.req.header("authorization");
    // The scheme is case-insensitive. Any other Authorization header still presents
    // a credential, so it is refused, never read as no token.
    const bearer = header === undefined ? undefined : /^bearer +(\S+)$/i.exec(header)?.[1];
    if (header !== undefined && bearer === undefined) throw new ApiError(401, "bad_token", "Unknown token");
    // EventSource can't send headers, so the event stream also takes a query token.
    const token = bearer ?? (c.req.path === "/v1/events" ? c.req.query("access_token") : undefined);
    const known = token === undefined ? undefined : tokens.get(token);
    if (token !== undefined) {
      // A bad token is refused. It never falls back to acting without one.
      if (known) {
        c.set("actor", known);
        // A static token is told apart by its hash.
        c.set("principal", `token:${createHash("sha256").update(token).digest("hex")}`);
      } else if (token.startsWith("g1.")) {
        // A guest pass is checked only here: never by the verifier, never as no token.
        const pass = guests && verifyGuest(guests.secret, token, clock());
        if (!pass) throw new ApiError(401, "bad_token", "Unknown token");
        c.set("actor", { role: "guest", name: pass.id });
        c.set("principal", `guest:${pass.id}`);
        c.set("audience", `guest:${pass.id}`);
      } else {
        const actor = await verifyToken?.(token).catch(() => undefined);
        if (!actor || taken.has(`${actor.role}:${actor.name}`)) throw new ApiError(401, "bad_token", "Unknown token");
        // A person is told apart by their subject.
        const person = actor.subject ?? `${actor.role}:${actor.name}`;
        c.set("principal", `person:${person}`);
        if (guests && actor.role === "viewer") {
          // Someone signed in who isn't a planner gets a sandbox, as a visitor does,
          // and the same one each time.
          const audience = userAudience(guests.secret, person);
          c.set("actor", { role: "guest", name: audience.slice("user:".length) });
          c.set("audience", audience);
        } else {
          c.set("actor", actor);
        }
      }
    } else if (anonymous) {
      c.set("actor", anonymous);
      c.set("principal", "anonymous");
      c.set("anonymous", true);
    } else {
      throw new ApiError(401, "token_required", "A token is required");
    }

    // The service's own agents act for one visitor, in that visitor's sandbox. Only
    // a static agent token named in visitorAgents may: never a person, whatever
    // their permissions, and never the replay client.
    const behalf = c.req.header(ON_BEHALF_OF);
    if (behalf !== undefined) {
      const actor = c.get("actor");
      if (!known || actor.role !== "agent" || !visitorAgents.includes(actor.name)) {
        throw new ApiError(403, "forbidden", "Only the service's own agents act for a visitor");
      }
      if (behalf === "*") {
        // Every sandbox, only to read the log. MCP carries the header to each tool
        // call, and each call is checked again as its own request.
        if (!["GET", "HEAD"].includes(c.req.method) && c.req.path !== "/v1/mcp") {
          throw new ApiError(400, "read_only", "Acting for everyone only reads. Act for one visitor to write");
        }
        c.set("everyone", true);
      } else if (AUDIENCE.test(behalf)) {
        c.set("audience", behalf);
      } else {
        throw new ApiError(400, "bad_audience", `${ON_BEHALF_OF} names a visitor, as guest:<id> or user:<id>, or * to read the whole log`);
      }
    }
    await next();
  });

  let uploading = 0;
  // A request without a token acts for whoever runs this machine in open mode.
  // After DNS rebinding, an attacker's page reaches this service under the
  // attacker's own name, and could read what it answers. So in open mode such a
  // request is answered only at an IP address, localhost or PUBLIC_URL's name.
  // Writes from other sites are refused above, token or not.
  const publicHost = options.publicUrl ? new URL(options.publicUrl).host : undefined;
  app.use("/v1/*", async (c, next) => {
    const own = new URL(c.req.url);
    if (access === "open" && c.get("anonymous") && !fixedAddress(own) && own.host !== publicHost) {
      throw new ApiError(403, "forbidden_host", `Open access answers only at an IP address, localhost or PUBLIC_URL, not ${own.host}`);
    }
    await next();
  });

  const tooLarge = (): never => {
    throw new ApiError(413, "too_large", "The request body is too large");
  };
  const limit = bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge });
  const contextLimit = bodyLimit({ maxSize: CONTEXT_LIMIT, onError: tooLarge });
  app.use("/v1/*", (c, next) => {
    const role = c.get("actor")?.role;
    if (c.req.path === "/v1/context" && contributors.includes(role)) return contextLimit(c, next);
    // An upload's route checks its length itself, before reading it: this one would
    // read a body sent without a length before the route could refuse it.
    if (c.req.method === "POST" && MEDIA_UPLOAD.test(c.req.path) && agents.includes(role)) return next();
    return limit(c, next);
  });

  // A client that retries after a timeout can send the same Idempotency-Key, and
  // gets the first response back instead of writing twice. Records are kept per
  // credential, in the actor column, since two credentials can share a name.
  service.log.db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency (
      actor TEXT NOT NULL,
      key TEXT NOT NULL,
      status INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (actor, key)
    );
  `);
  app.use("/v1/*", async (c, next) => {
    const key = c.req.header("idempotency-key");
    // Not on /v1/mcp: a client sends its headers with every message there, so one
    // key would answer each later message with the first one's reply. A viewer can
    // only preview, which writes nothing, so it keeps no record either. Nor does a
    // guest, or a public route. Otherwise anyone reading a public demo could fill
    // this table.
    const role = c.get("actor")?.role;
    if (!key || ["GET", "HEAD"].includes(c.req.method) || c.req.path === "/v1/mcp" || !role || role === "viewer" || role === "guest") return next();
    // An agent acting for a visitor keeps its records apart for each visitor, so no
    // visitor gets another's reply.
    const audience = c.get("audience");
    const principal = audience ? `${c.get("principal")}|${audience}` : c.get("principal");
    const seen = service.log.db.prepare("SELECT status, body FROM idempotency WHERE actor = ? AND key = ?").get(principal, key) as
      | { status: number; body: string }
      | undefined;
    if (seen) return c.body(seen.body, seen.status as 200, { "content-type": "application/json", "idempotent-replay": "true" });
    await next();
    if (c.res.ok) {
      const body = await c.res.clone().text();
      service.log.db.prepare("INSERT OR IGNORE INTO idempotency (actor, key, status, body) VALUES (?, ?, ?, ?)").run(principal, key, c.res.status, body);
    }
  });

  type Route = {
    method: "get" | "post" | "put";
    path: string;
    summary: string;
    roles: Role[];
    // Needs no token, in any mode.
    public?: boolean;
    body?: z.ZodType;
    // The fields of a multipart/form-data body, sent with a file.
    form?: z.ZodType;
    handler: (c: HonoContext<Env>) => Response | Promise<Response>;
  };

  // The service as the caller sees it: the shared record, plus their own sandbox
  // when they are a visitor or act for one.
  const view = (c: HonoContext<Env>) => service.viewFor(c.get("audience") ?? null);
  const audienceOf = (c: HonoContext<Env>) => c.get("audience") ?? null;
  // The entries a caller reads of the log: every sandbox's for an agent acting for
  // everyone, and otherwise the caller's own.
  const scopeOf = (c: HonoContext<Env>) => (c.get("everyone") ? EVERYONE : audienceOf(c));
  const isGuest = (c: HonoContext<Env>) => c.get("actor")?.role === "guest";

  // A visitor's message or media request needs this much of today's budget left.
  // A message starts a run of model calls; an image and a short video cost more.
  const MESSAGE_USD = 0.1;
  const MEDIA_USD = 0.7;
  const requireBudget = (c: HonoContext<Env>, usd: number) => {
    const audience = audienceOf(c);
    if (audience) budget?.require(audience, usd);
  };

  const routes: Route[] = [
    {
      method: "get",
      path: "/v1/config",
      summary: "How to sign in, what a request without a token may do, and whether visitors get guest passes. Needs no token",
      roles: anyone,
      public: true,
      handler: (c) => c.json({ auth: access, signIn, guests: Boolean(guests), executive: slack ? executive.name : null } satisfies ServiceConfig),
    },
    {
      method: "post",
      path: "/v1/guests",
      summary: "Get a guest pass, to act as a visitor in a sandbox of your own. Needs no token, and writes nothing",
      roles: anyone,
      public: true,
      handler: (c) => {
        if (!guests) throw new ApiError(404, "not_found", "This service gives out no guest passes");
        return c.json(issueGuest(guests.secret, clock()) satisfies GuestPass, 201, { "cache-control": "no-store" });
      },
    },
    {
      method: "get",
      path: "/v1/budget",
      summary: "What is left of today's Gemini budget for visitors, for the visitor you are or act for",
      roles: anyone,
      handler: (c) => {
        const audience = audienceOf(c);
        return c.json((budget && audience ? budget.view(audience) : { capped: false }) satisfies BudgetView);
      },
    },
    {
      method: "get",
      path: "/v1/me",
      summary: "Who you are: your role and name",
      roles: anyone,
      handler: (c) => {
        const { role, name } = c.get("actor");
        return c.json({ role, name } satisfies Me);
      },
    },
    {
      method: "post",
      path: "/v1/context",
      summary: "Add context as JSON, or upload a file as multipart/form-data",
      roles: contributors,
      body: NewContext,
      handler: async (c) => {
        const type = c.req.header("content-type") ?? "";
        if (!type.startsWith("multipart/form-data")) {
          return c.json(view(c).addContext(actorName(c), await bodyOf(c, NewContext)), 201);
        }
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) throw new ApiError(400, "invalid_body", "Expected a file field");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pages = await extractPages(file.name, bytes);
        const input = NewContext.parse({ title: String(form.title ?? file.name), folder: String(form.folder ?? "Inbox"), pages });
        const fileHash = createHash("sha256").update(bytes).digest("hex");
        return c.json(view(c).addContext(actorName(c), input, fileHash), 201);
      },
    },
    {
      method: "get",
      path: "/v1/context",
      summary: "List context",
      roles: anyone,
      handler: (c) => c.json([...view(c).state.contexts.values()]),
    },
    {
      method: "get",
      path: "/v1/context/:id/pages/:page",
      summary: "Read one page of a document",
      roles: anyone,
      handler: (c) => c.json({ text: view(c).contextPage(c.req.param("id") as string, Number(c.req.param("page"))) }),
    },
    {
      method: "get",
      path: "/v1/search",
      summary: "Search source pages, best match first, citable pages before the rest",
      roles: anyone,
      handler: (c) => {
        const q = c.req.query("q")?.trim();
        if (!q) throw new ApiError(400, "invalid_query", "Say what to look for in q");
        const limit = c.req.query("limit") ?? "10";
        if (!/^\d+$/.test(limit) || Number(limit) < 1) throw new ApiError(400, "invalid_query", "limit must be a whole number, 1 or more");
        return c.json({ results: view(c).search(q, Math.min(Number(limit), 50)) });
      },
    },
    {
      method: "post",
      path: "/v1/studies",
      summary: "Open a study",
      roles: authors,
      body: NewStudy,
      handler: async (c) => c.json(view(c).openStudy(actorName(c), await bodyOf(c, NewStudy)), 201),
    },
    {
      method: "get",
      path: "/v1/studies",
      summary: "List studies",
      roles: anyone,
      handler: (c) => c.json(view(c).studies()),
    },
    {
      method: "get",
      path: "/v1/studies/:id",
      summary: "Read a study: figures, checks, findings and decision",
      roles: anyone,
      handler: (c) => c.json(view(c).viewStudy(c.req.param("id") as string)),
    },
    {
      method: "post",
      path: "/v1/studies/:id/figures",
      summary: "Add a figure. Rejected if it has no valid source",
      roles: authors,
      body: NewFigure,
      handler: async (c) => c.json(view(c).addFigure(actorName(c), c.req.param("id") as string, await bodyOf(c, NewFigure)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/checks",
      summary: "Test a figure against a rule",
      roles: authors,
      body: NewCheck,
      handler: async (c) => c.json(view(c).addCheck(actorName(c), c.req.param("id") as string, await bodyOf(c, NewCheck)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/findings",
      summary: "Add a finding the service can't compute, such as public feedback",
      roles: authors,
      body: NewFinding,
      handler: async (c) => c.json(view(c).addFinding(actorName(c), c.req.param("id") as string, await bodyOf(c, NewFinding)), 201),
    },
    {
      method: "put",
      path: "/v1/studies/:id/findings/:finding/tone",
      summary: "Rate how a finding reads. Agents can only propose a tone. Planners, or a visitor in their own sandbox",
      roles: people,
      body: FindingRating,
      handler: async (c) => {
        const { tone } = await bodyOf(c, FindingRating);
        return c.json(view(c).rateFinding(actorName(c), c.req.param("id") as string, c.req.param("finding") as string, tone));
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/alignments",
      summary: "Propose a draft alignment to a real station or interchange, built only along route shapes the service holds. Refused if it can't be snapped",
      roles: authors,
      body: NewAlignment,
      handler: async (c) => c.json(view(c).proposeAlignment(actorName(c), c.req.param("id") as string, await bodyOf(c, NewAlignment)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/findings/:finding/review",
      summary: "Hand an alignment option over for a consultant's review, as a gap for a planner. Planners, or a visitor in their own sandbox",
      roles: people,
      handler: (c) => c.json(view(c).requestReview(actorName(c), c.req.param("id") as string, c.req.param("finding") as string), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/findings/:finding/renders",
      summary: "Propose renders of an alignment option's main station, an image and a video. Planners, or a visitor in their own sandbox",
      roles: people,
      handler: (c) => c.json(view(c).proposeRenders(actorName(c), c.req.param("id") as string, c.req.param("finding") as string), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/figures/:figure/accept",
      summary: "Accept a skill's result so it can pass or fail a check. Planners, or a visitor in their own sandbox",
      roles: people,
      handler: (c) => c.json(view(c).acceptFigure(actorName(c), c.req.param("id") as string, c.req.param("figure") as string)),
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs",
      summary: "Propose something to make for public engagement in one place, such as a poster or a short video",
      roles: authors,
      body: NewNeed,
      handler: async (c) => c.json(view(c).addNeed(actorName(c), c.req.param("id") as string, await bodyOf(c, NewNeed)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs/:need/create",
      summary: "Ask for a need's image or video to be made. Asking again changes nothing. Planners, or a visitor in their own sandbox",
      roles: people,
      handler: (c) => {
        if (isGuest(c)) requireBudget(c, MEDIA_USD);
        return c.json(view(c).requestCreation(actorName(c), c.req.param("id") as string, c.req.param("need") as string), 202);
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs/:need/claim",
      summary: "Take on a request to make a need, before spending anything: a planner's, or, acting for a visitor, theirs. One agent holds it at a time, for 20 minutes. Agents only",
      roles: agents,
      body: NeedClaim,
      handler: async (c) =>
        c.json(view(c).claimCreation(actorName(c), c.req.param("id") as string, c.req.param("need") as string, await bodyOf(c, NeedClaim))),
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs/:need/failed",
      summary: "Say why a need's image or video couldn't be made, with the request's claim. Nothing more is made until someone asks again. Agents only",
      roles: agents,
      body: NeedFailure,
      handler: async (c) =>
        c.json(view(c).failCreation(actorName(c), c.req.param("id") as string, c.req.param("need") as string, await bodyOf(c, NeedFailure))),
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs/:need/dismiss",
      summary: "Drop a need nobody has to make any more, such as one for a change that won't go ahead, with a reason. Its files stop being served. Planners only",
      roles: planners,
      body: NeedWithdrawal,
      handler: async (c) =>
        c.json(view(c).dismissNeed(actorName(c), c.req.param("id") as string, c.req.param("need") as string, await bodyOf(c, NeedWithdrawal))),
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs/:need/media/:media/withdraw",
      summary: "Take down a generated image or video that shouldn't be shown, with a reason. The need is needed again. Planners only",
      roles: planners,
      body: NeedWithdrawal,
      handler: async (c) =>
        c.json(
          view(c).withdrawMedia(actorName(c), c.req.param("id") as string, c.req.param("need") as string, c.req.param("media") as string, await bodyOf(c, NeedWithdrawal)),
        ),
    },
    {
      method: "post",
      path: "/v1/studies/:id/needs/:need/media",
      summary: "Attach a generated image or video to a need, as multipart/form-data: the file, with the request's claim, kind, model, prompt and inputs. Agents only",
      roles: agents,
      form: NewMedia.omit({ needId: true }),
      handler: async (c) => {
        const studyId = c.req.param("id") as string;
        const needId = c.req.param("need") as string;
        // Checked before the body is read, so an upload nobody asked for costs nothing,
        // and one that is asked for gets room for what it still lacks.
        const kinds = view(c).uploadable(actorName(c), studyId, needId);
        const room = Math.max(...kinds.map((kind) => MEDIA_MAX_BYTES[kind])) + FORM_ROOM;
        const contentType = c.req.header("content-type") ?? "";
        if (!contentType.startsWith("multipart/form-data")) throw new ApiError(400, "invalid_body", "Send the file and its fields as multipart/form-data");
        const length = c.req.header("content-length");
        if (length === undefined || c.req.header("transfer-encoding") !== undefined || !/^\d+$/.test(length)) {
          throw new ApiError(411, "length_required", "Send the upload with a Content-Length");
        }
        if (Number(length) > room) tooLarge();
        // Each upload is held in memory while it's checked, so only a few are read at once.
        if (uploading >= UPLOADS_AT_ONCE) throw new ApiError(503, "busy", "Other files are being read. Try again in a few seconds");
        uploading += 1;
        try {
          const body = new Uint8Array(await c.req.arrayBuffer());
          if (body.length > room) tooLarge();
          const form = formParts(body, contentType);
          if (!form) throw new ApiError(400, "invalid_body", "The form can't be read");
          const field = (name: string) => {
            const part = form.get(name);
            return part && part.filename === undefined ? new TextDecoder().decode(part.data) : undefined;
          };
          const file = form.get("file");
          if (file?.filename === undefined) throw new ApiError(400, "invalid_body", "Expected a file field");
          let inputs: unknown;
          try {
            const text = field("inputs");
            inputs = text === undefined ? undefined : JSON.parse(text);
          } catch {
            throw new ApiError(400, "invalid_body", "inputs must be a JSON array");
          }
          const parsed = NewMedia.safeParse({
            needId,
            claim: field("claim"),
            kind: field("kind"),
            model: field("model"),
            prompt: field("prompt"),
            inputs,
            alt: field("alt"),
          });
          if (!parsed.success) throw new ApiError(400, "invalid_body", z.prettifyError(parsed.error));
          return c.json(view(c).addMedia(actorName(c), studyId, parsed.data, { bytes: file.data, ...(file.type ? { type: file.type } : {}) }), 201);
        } finally {
          uploading -= 1;
        }
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/documents",
      summary:
        "Make a PDF of the study, a report or slides, from sections of points. A point with a citation is refused unless its quote is on the cited page. Returns where to read it",
      roles: authors,
      body: NewDocument,
      handler: async (c) => {
        const base = options.publicUrl ?? new URL(c.req.url).origin;
        return c.json(await view(c).createDocument(actorName(c), c.req.param("id") as string, await bodyOf(c, NewDocument), base), 201);
      },
    },
    {
      method: "get",
      path: "/v1/datasets",
      summary: "List the open datasets the GIS tools work on: publisher, licence, retrieval date, coverage, and what each can total",
      roles: anyone,
      handler: (c) => c.json({ datasets: view(c).datasets() }),
    },
    {
      method: "get",
      path: "/v1/studies/:id/layers",
      summary: "List a study's map layers, newest last",
      roles: anyone,
      handler: (c) => c.json({ layers: view(c).layers(c.req.param("id") as string) }),
    },
    {
      method: "get",
      path: "/v1/studies/:id/layers/:layer",
      summary: "Summarise a map layer: what it is, its size, its totals and the figures that record them, and its first rows",
      roles: anyone,
      handler: (c) => c.json(view(c).summariseLayer(c.req.param("id") as string, c.req.param("layer") as string)),
    },
    {
      method: "get",
      path: "/v1/studies/:id/layers/:layer/geojson",
      summary: "A map layer's features as a GeoJSON FeatureCollection, in WGS84",
      roles: anyone,
      handler: (c) => c.json(view(c).layerGeojson(c.req.param("id") as string, c.req.param("layer") as string)),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/route-stops",
      summary: "Save a TTC route's stops as a map layer: every stop its trips call at, all branches and both directions, from the GTFS",
      roles: authors,
      body: RouteLayerRequest,
      handler: async (c) => c.json(view(c).routeLayer(actorName(c), c.req.param("id") as string, "stops", await bodyOf(c, RouteLayerRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/route-shape",
      summary: "Save a TTC route's main shapes as a map layer of lines, from the GTFS",
      roles: authors,
      body: RouteLayerRequest,
      handler: async (c) => c.json(view(c).routeLayer(actorName(c), c.req.param("id") as string, "shape", await bodyOf(c, RouteLayerRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/study-line",
      summary: "Save the study's line, as the display draws it, as a map layer of lines",
      roles: authors,
      body: StudyLineRequest,
      handler: async (c) => c.json(view(c).studyLineLayer(actorName(c), c.req.param("id") as string, await bodyOf(c, StudyLineRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/area",
      summary: "Save one named area of an area dataset, such as a neighbourhood or a Neighbourhood Improvement Area, as a map layer",
      roles: authors,
      body: AreaRequest,
      handler: async (c) => c.json(view(c).namedAreaLayer(actorName(c), c.req.param("id") as string, await bodyOf(c, AreaRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/buffer",
      summary: "Buffer a map layer by some metres, as one area, saved as a new layer",
      roles: authors,
      body: BufferRequest,
      handler: async (c) => c.json(view(c).bufferLayer(actorName(c), c.req.param("id") as string, await bodyOf(c, BufferRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/overlay",
      summary:
        "Overlay an area layer with an area dataset, such as census areas: each area's share of land inside, and area-weighted totals, saved as a layer, with the totals recorded as figures",
      roles: authors,
      body: OverlayRequest,
      handler: async (c) => c.json(view(c).overlayLayer(actorName(c), c.req.param("id") as string, await bodyOf(c, OverlayRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/points-within",
      summary: "Count a point dataset's points inside an area layer, such as KSI collisions by year, saved as a layer, with the counts recorded as figures",
      roles: authors,
      body: PointsWithinRequest,
      handler: async (c) => c.json(view(c).pointsWithinLayer(actorName(c), c.req.param("id") as string, await bodyOf(c, PointsWithinRequest)), 201),
    },
    // Road safety (gis-safety.ts) and active transportation (gis-active.ts).
    {
      method: "post",
      path: "/v1/studies/:id/gis/ksi-profile",
      summary: "KSI collisions inside an area layer by year, road user, severity, place, light and time of day, saved as a layer, with the main counts recorded as figures",
      roles: authors,
      body: KsiProfileRequest,
      handler: async (c) => c.json(ksiProfileLayer(view(c), actorName(c), c.req.param("id") as string, await bodyOf(c, KsiProfileRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/ksi-hotspots",
      summary: "The places inside an area layer with the most KSI collisions, ranked, saved as a layer",
      roles: authors,
      body: KsiHotspotsRequest,
      handler: async (c) => c.json(ksiHotspotsLayer(view(c), actorName(c), c.req.param("id") as string, await bodyOf(c, KsiHotspotsRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/ksi-trend",
      summary: "KSI collisions a year inside an area layer, before and after a year, against the city's, with an exact test of the change, saved as a layer",
      roles: authors,
      body: KsiTrendRequest,
      handler: async (c) => c.json(ksiTrendLayer(view(c), actorName(c), c.req.param("id") as string, await bodyOf(c, KsiTrendRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/cycling",
      summary: "The cycling network inside an area layer, in km by type, saved as a layer, with the totals recorded as figures",
      roles: authors,
      body: ActiveLayerRequest,
      handler: async (c) => c.json(activeLayer(view(c), actorName(c), c.req.param("id") as string, "cycling", await bodyOf(c, ActiveLayerRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/sidewalks",
      summary: "Streets inside an area layer by their sidewalks, in km, saved as a layer, with the totals recorded as figures",
      roles: authors,
      body: ActiveLayerRequest,
      handler: async (c) => c.json(activeLayer(view(c), actorName(c), c.req.param("id") as string, "sidewalks", await bodyOf(c, ActiveLayerRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/bike-share",
      summary: "Bike share stations inside an area layer, and their docks, saved as a layer, with the totals recorded as figures",
      roles: authors,
      body: ActiveLayerRequest,
      handler: async (c) => c.json(activeLayer(view(c), actorName(c), c.req.param("id") as string, "bike-share", await bodyOf(c, ActiveLayerRequest)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/gis/first-last-mile",
      summary: "For each stop of a points layer, the nearest bike share station and the bikeways within a distance, saved as two layers, with the counts recorded as figures",
      roles: authors,
      body: FirstLastMileRequest,
      handler: async (c) => c.json(firstLastMileLayer(view(c), actorName(c), c.req.param("id") as string, await bodyOf(c, FirstLastMileRequest)), 201),
    },
    // The equity, economic development and stop accessibility skills' GIS tools.
    ...GIS_SKILL_ROUTES.map(
      (route): Route => ({
        method: "post",
        path: route.path,
        summary: route.summary,
        roles: authors,
        body: route.body,
        handler: async (c) => c.json(route.run(view(c), actorName(c), c.req.param("id") as string, (await bodyOf(c, route.body)) as never), 201),
      }),
    ),
    {
      method: "get",
      path: "/v1/media/:id",
      summary: "Read a generated image or video, or a document's PDF, by its sha256. Needs no token",
      roles: anyone,
      public: true,
      handler: (c) => serveMedia(c, service.mediaFile(c.req.param("id") as string)),
    },
    {
      method: "get",
      path: "/v1/tiles/imagery/:z/:x/:y",
      summary: "An aerial photo of Toronto, as a 256-pixel Web Mercator tile from the City of Toronto, under the Open Government Licence – Toronto. Needs no token",
      roles: anyone,
      public: true,
      handler: async (c) => {
        const [z, x, y] = ["z", "x", "y"].map((name) => Number(c.req.param(name)));
        const tile = await options.imagery?.get(z as number, x as number, y as number);
        if (!tile) throw new ApiError(404, "not_found", "No aerial photo there");
        // A tile of a year's photos never changes, so the browser keeps it.
        return c.body(tile.body as Uint8Array<ArrayBuffer>, 200, { "content-type": tile.type, "cache-control": "public, max-age=2592000" });
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/activity",
      summary: "Report agent progress, messages, tokens and cost. A visitor may only send a message",
      roles: [...authors, "guest"],
      body: Activity,
      handler: async (c) => {
        const activity = await bodyOf(c, Activity);
        // A visitor chats, and the agents report the rest. Usage from a visitor
        // would misstate what the agents spent.
        if (isGuest(c)) {
          if (activity.kind !== "message") throw new ApiError(403, "sign_in_required", SIGN_IN_AS_PLANNER);
          requireBudget(c, MESSAGE_USD);
        }
        const entry = view(c).recordActivity(actorName(c), c.req.param("id") as string, activity);
        // An agent acting for a visitor learns what is left after each model call,
        // so a run can stop once the budget is spent.
        const audience = audienceOf(c);
        if (budget && audience && activity.kind === "usage" && c.get("actor").role === "agent") {
          return c.json({ seq: entry.seq, budgetLeftUsd: budget.left(audience) }, 201);
        }
        return c.json({ seq: entry.seq }, 201);
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/escalate",
      summary:
        "Ping the executive on Slack about a decision above a planner's authority, such as which option to fund: the decision, and the answer that asked for it. Once per answer in 10 minutes. Planners only",
      roles: planners,
      body: NewEscalation,
      handler: async (c) => {
        const studyId = c.req.param("id") as string;
        const { text, message } = await bodyOf(c, NewEscalation);
        const study = service.state.studies.get(studyId);
        if (!study) throw new ApiError(404, "not_found", `No study "${studyId}"`);
        let answer: string | undefined;
        if (message !== undefined) {
          const entry = service.log.get(message);
          const data = entry?.data as { kind?: string; text?: unknown } | undefined;
          if (!entry || entry.studyId !== studyId || entry.type !== "activity" || data?.kind !== "message" || typeof data.text !== "string") {
            throw new ApiError(422, "unknown_message", `No message ${message} in this study's chat`);
          }
          answer = data.text;
        }
        if (!slack) throw new ApiError(503, "slack_off", "Slack isn't set up. Set SLACK_WEBHOOK_URL to ping the executive.");
        const decision = (EXECUTIVE.test(text) ? executiveDecision(text) : text) ?? text;
        // A double click, or a second planner, pings once.
        const key = `${studyId}\n${message ?? decision}`;
        const now = clock().getTime();
        const last = pinged.get(key);
        if (last !== undefined && (last === 0 || now - last < PING_REPEAT_MS)) {
          const when = last === 0 ? "just now" : `at ${clockTime.format(last)}`;
          throw new ApiError(409, "already_sent", `${executive.name} was pinged about this ${when}.`);
        }
        pinged.set(key, 0);
        const reason = await slack.sendAndWait(
          escalation(executive, {
            decision,
            summary: answer ? gist(answer) : undefined,
            study: study.title,
            link: studyLink(options.publicUrl, studyId),
            raisedBy: c.get("actor").name,
          }),
        );
        if (reason) {
          pinged.delete(key);
          throw new ApiError(502, "slack_failed", "Slack didn't take the message. Try again.");
        }
        pinged.set(key, now);
        const entry = service.recordActivity(actorName(c), studyId, {
          kind: "escalation.sent",
          text: decision.slice(0, 300),
          to: executive.name,
          ...(message !== undefined ? { message } : {}),
        });
        return c.json({ seq: entry.seq, at: entry.at, to: executive.name }, 201);
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/preview",
      summary: "Try a change. Writes nothing",
      roles: anyone,
      body: Preview,
      handler: async (c) => c.json(view(c).viewStudy(c.req.param("id") as string, await bodyOf(c, Preview))),
    },
    {
      method: "post",
      path: "/v1/studies/:id/decisions",
      summary: "Record a decision. Planners only",
      roles: planners,
      body: NewDecision,
      handler: async (c) => c.json(view(c).recordDecision(actorName(c), c.req.param("id") as string, await bodyOf(c, NewDecision)), 201),
    },
    {
      method: "get",
      path: "/v1/studies/:id/compare",
      summary: "See what changed between two log positions, and why",
      roles: anyone,
      handler: (c) => {
        const from = Number(c.req.query("from") ?? 0);
        const to = Number(c.req.query("to") ?? service.log.headFor(audienceOf(c)).seq);
        return c.json(view(c).compare(c.req.param("id") as string, from, to));
      },
    },
    {
      method: "get",
      path: "/v1/studies/:id/timeline",
      summary: "See measured results and forecasts from today to the review date",
      roles: anyone,
      handler: (c) => {
        if (!timeline) throw new ApiError(404, "not_found", "Timeline is not available");
        return c.json(timeline(c.req.param("id") as string, view(c)) as object);
      },
    },
    {
      method: "get",
      path: "/v1/studies/:id/figures/:figure/trace",
      summary: "Trace a figure back to its source",
      roles: anyone,
      handler: (c) => c.json(view(c).trace(c.req.param("id") as string, c.req.param("figure") as string)),
    },
    {
      method: "put",
      path: "/v1/assumptions/:key",
      summary: "Set or change an assumption, with a reason. Planners, or a visitor in their own sandbox",
      roles: people,
      body: NewAssumption,
      handler: async (c) => c.json(view(c).setAssumption(actorName(c), c.req.param("key") as string, await bodyOf(c, NewAssumption))),
    },
    {
      method: "get",
      path: "/v1/assumptions",
      summary: "List assumptions with their history",
      roles: anyone,
      handler: (c) => c.json([...view(c).state.assumptions.values()]),
    },
    {
      method: "put",
      path: "/v1/skills/:name",
      summary: "Approve a skill version, so its results can enter studies. Planners only",
      roles: planners,
      body: NewSkill,
      handler: async (c) => c.json(view(c).registerSkill(actorName(c), c.req.param("name") as string, await bodyOf(c, NewSkill)), 201),
    },
    {
      method: "post",
      path: "/v1/log/:seq/remove-content",
      summary: "Remove an entry's content for retention or privacy. The entry and chain stay. For a visitor's entry, give their audience. Planners only",
      roles: planners,
      body: ContentRemoval,
      handler: async (c) => {
        const { reason, audience } = await bodyOf(c, ContentRemoval);
        return c.json(view(c).removeContent(actorName(c), Number(c.req.param("seq")), reason, audience ?? null), 201);
      },
    },
    {
      method: "get",
      path: "/v1/log",
      summary: "Read the log from a position",
      roles: anyone,
      handler: (c) => {
        const after = whole(c.req.query("after"), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = whole(c.req.query("limit"), 200, 1, 1000);
        return c.json(service.log.since(after, limit, scopeOf(c)));
      },
    },
    {
      method: "get",
      path: "/v1/log/verify",
      summary: "Check the hash chain, and get the hash of the latest entry you can read",
      roles: anyone,
      handler: (c) => {
        // The whole chain is checked, visitors' sandboxes too. Its length and last
        // hash would show when visitors work, so only an agent acting for everyone
        // gets them.
        const verified = service.log.verify();
        const scope = scopeOf(c);
        if (!verified.ok || scope === EVERYONE) return c.json(verified);
        return c.json({ ok: true, head: service.log.headFor(scope).hash });
      },
    },
    {
      method: "get",
      path: "/v1/log/head",
      summary: "Read the latest position and hash you can read, to keep as a witness",
      roles: anyone,
      handler: (c) => c.json(service.log.headFor(scopeOf(c))),
    },
    {
      method: "get",
      path: "/v1/usage",
      summary: "Everything agents have spent: tokens and cost, in total, with visitors' sandboxes added in, and by study, for the shared record. Each comes with an estimate of the energy, CO2e and water the calls used, at least",
      roles: anyone,
      handler: (c) => c.json(view(c).usage()),
    },
    {
      method: "post",
      path: "/v1/subscriptions",
      summary: "Subscribe a webhook to events. Formats: json, slack, teams",
      roles: integrators,
      body: NewSubscription,
      handler: async (c) => {
        const input = await bodyOf(c, NewSubscription);
        const host = new URL(input.url).hostname;
        if (access !== "open" && !webhookHosts.includes(host)) {
          throw new ApiError(403, "host_not_allowed", `Webhooks to ${host} are not allowed. Add it to WEBHOOK_HOSTS`);
        }
        return c.json(webhooks.add(actorName(c), input), 201);
      },
    },
    {
      method: "get",
      path: "/v1/live/vehicles",
      summary: "Latest live vehicle positions for the given routes",
      roles: anyone,
      handler: (c) => c.json(live?.vehicles((c.req.query("routes") ?? "").split(",").filter(Boolean)) ?? []),
    },
  ];

  for (const route of routes) {
    if (route.public) publicRoutes.push({ method: route.method.toUpperCase(), path: new RegExp(`^${route.path.replace(/:\w+/g, "[^/]+")}$`) });
    // Writes, which a visitor may make only so often. A preview writes nothing.
    const writes = route.method !== "get" && !route.path.endsWith("/preview");
    app[route.method](route.path, async (c) => {
      if (route.public) return route.handler(c);
      const { role } = c.get("actor");
      if (!route.roles.includes(role)) {
        // Without a token, anything beyond reading needs one, as in token mode.
        if (c.get("anonymous")) throw new ApiError(401, "token_required", "A token is required");
        // A visitor can do everything a planner can but decide, so signing in is the way.
        if (role === "guest") throw new ApiError(403, "sign_in_required", route.path.endsWith("/decisions") ? SIGN_IN_TO_DECIDE : SIGN_IN_AS_PLANNER);
        throw new ApiError(403, "forbidden", `This needs a ${route.roles.join(" or ")} token, not ${role}`);
      }
      if (role === "guest" && writes) limits.take(audienceOf(c) as string);
      return route.handler(c);
    });
  }

  // A page view or a quick bounce, which the display's track.js reports. Not in
  // `routes`, so it's no agent's tool. Always 204, sent or not: tracking is best
  // effort, and a page never waits on it.
  const visits = options.visits ?? null;
  publicRoutes.push({ method: "POST", path: /^\/v1\/track$/ });
  app.post("/v1/track", async (c) => {
    if (visits) {
      let visit = null;
      try {
        visit = readVisit(JSON.parse(await c.req.text()));
      } catch {
        // Not JSON: nothing to send.
      }
      const address = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (visit && visits.take(address)) void visits.send(visitMessage(visit, c.req.raw.headers, clock()));
    }
    return c.body(null, 204);
  });

  // Agents can connect over MCP instead. Each tool call runs one route above, as the caller.
  app.all("/v1/mcp", mcp(app, routes, { publicUrl: options.publicUrl }));

  // Everything that happens, live. Resume with Last-Event-ID or ?after=.
  app.get("/v1/events", (c) => {
    const wanted = c.req.query("types")?.split(",").filter(Boolean);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    // The shared record, and the caller's own sandbox. Never the whole log.
    const audience = audienceOf(c);
    const wants = (type: string) => !wanted || wanted.includes(type);
    const matches = (entry: Entry) => visible(entry, audience) && wants(entry.type);
    // A model call made in someone else's sandbox. The stream can't show it, but
    // says one was made, as everyone's /v1/usage total does, so the spend screen
    // loads the new total at once.
    const unseenUsage = (entry: Entry) =>
      !visible(entry, audience) && entry.type === "activity" && (entry.data as { kind?: string }).kind === "usage" && wants("activity");
    return streamSSE(c, async (stream) => {
      const queue: Entry[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = service.log.subscribe((entry) => {
        queue.push(entry);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      // The replay ends at the head as it is now. An entry written later, even while
      // the replay is still being sent, comes from the queue, once.
      const sent = service.log.head().seq;
      for (const entry of service.log.since(after, 100_000, audience)) {
        if (matches(entry)) await stream.writeSSE({ id: String(entry.seq), event: entry.type, data: JSON.stringify(entry) });
      }
      while (!stream.aborted) {
        const entry = queue.shift();
        if (!entry) {
          // A comment every 20 s keeps a quiet stream open. Its timer ends with
          // the wait, so a stream that has ended doesn't keep the service running.
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            new Promise<void>((resolve) => (wake = resolve)),
            new Promise<void>((resolve) => (timer = setTimeout(resolve, 20_000))).then(() => stream.write(": keep-alive\n\n")),
          ]);
          clearTimeout(timer);
          continue;
        }
        if (entry.seq <= sent) continue;
        if (matches(entry)) {
          await stream.writeSSE({ id: String(entry.seq), event: entry.type, data: JSON.stringify(entry) });
        } else if (unseenUsage(entry)) {
          // Nothing of the entry: no content, and no id, so a stream that starts
          // again carries on from the last entry it could show.
          await stream.writeSSE({ event: "usage", data: "{}" });
        }
      }
    });
  });

  app.get("/openapi.json", (c) => {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const route of routes) {
      const path = route.path.replace(/:(\w+)/g, "{$1}");
      paths[path] ??= {};
      (paths[path] as Record<string, unknown>)[route.method] = {
        summary: route.summary,
        "x-roles": route.roles,
        ...(route.public ? { security: [] } : {}),
        ...(route.body
          ? { requestBody: { content: { "application/json": { schema: z.toJSONSchema(route.body, { io: "input", unrepresentable: "any" }) } } } }
          : {}),
        ...(route.form ? { requestBody: { content: { "multipart/form-data": multipart(route.form) } } } : {}),
        responses: { default: { description: "See summary" } },
      };
    }
    paths["/v1/events"] = {
      get: {
        summary: "Stream the log as server-sent events. A model call in a sandbox you can't read comes as an empty usage event",
        "x-roles": anyone,
        responses: { default: { description: "Event stream" } },
      },
    };
    return c.json({
      openapi: "3.1.0",
      info: { title: "Transit Agents", version: "0.1.0" },
      components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
      security: [{ token: [] }],
      paths,
    });
  });

  // Anyone may ask, so it gives the shared record's head.
  app.get("/health", (c) => c.json({ ok: true, head: service.log.headFor(null) }));

  // AI assistants fetching a page themselves, which run no JavaScript, so track.js
  // never sees them: each one a JSON log line, and one a person asked for (a "user"
  // fetcher) a message to Discord as well.
  app.use("*", async (c, next) => {
    const fetcher = c.req.method === "GET" && !c.req.path.startsWith("/v1/") && !extname(c.req.path) ? matchAiFetcher(c.req.header("user-agent")) : null;
    if (fetcher) {
      const url = new URL(c.req.url);
      const page = url.pathname + url.search;
      console.log(JSON.stringify({ type: "ai_fetch", vendor: fetcher.vendor, bot: fetcher.token, kind: fetcher.kind, page }));
      if (fetcher.kind === "user" && visits?.take(undefined)) void visits.send(aiFetchMessage(fetcher, page, clock()));
    }
    await next();
  });

  if (staticDir && existsSync(staticDir)) {
    const root = resolve(staticDir);
    app.use("*", compress());
    app.get("*", (c) => {
      let requested = "/";
      try {
        requested = normalize(decodeURIComponent(new URL(c.req.url).pathname));
      } catch {
        // An address that can't be decoded, such as /%zz, names no file.
      }
      // A folder that holds an index.html serves it, so / and /spend are each a page.
      const page = join(root, requested, "index.html");
      const candidate = existsSync(page) ? page : join(root, requested);
      const file = candidate.startsWith(root) && existsSync(candidate) && extname(candidate) ? candidate : join(root, "index.html");
      const hashed = file.includes(`${join(root, "assets")}`);
      const data = file.includes(`${join(root, "data")}`) || file.includes(`${join(root, "sources")}`);
      c.header("content-type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
      c.header("cache-control", hashed ? "public, max-age=31536000, immutable" : data ? "public, max-age=86400" : "no-cache");
      return c.body(new Uint8Array(readFileSync(file)));
    });
  }

  return app;
}
