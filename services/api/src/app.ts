// The HTTP surface. Every route is declared once in `routes`, which both registers
// it and generates /openapi.json, so the published API can't drift from the code.
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Hono, type Context as HonoContext } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  Activity,
  ContentRemoval,
  FindingRating,
  NewAssumption,
  NewCheck,
  NewContext,
  NewDecision,
  NewFigure,
  NewFinding,
  NewSkill,
  NewStudy,
  NewSubscription,
  type Role,
} from "@transit-agents/contracts";
import { extractPages } from "./extract.ts";
import type { Entry } from "./log.ts";
import { ApiError, type Service } from "./service.ts";
import type { Webhooks } from "./webhooks.ts";

export type Actor = { role: Role; name: string };

export type AppOptions = {
  service: Service;
  webhooks: Webhooks;
  tokens: Map<string, Actor>;
  // Open access makes a request without a token act as a local planner. It is
  // for a demo on a machine you control, and must be switched on explicitly.
  // Without it, every /v1 request needs a token.
  openAccess: boolean;
  // Hosts webhooks may send to. Without open access, an empty list allows none,
  // so nothing can be sent anywhere nobody approved.
  webhookHosts?: string[];
  staticDir?: string;
  live?: { vehicles: (routes: string[]) => unknown };
  timeline?: (studyId: string) => unknown;
};

type Env = { Variables: { actor: Actor } };

const anyone: Role[] = ["viewer", "integration", "agent", "planner"];
const contributors: Role[] = ["integration", "agent", "planner"];
const authors: Role[] = ["agent", "planner"];
const planners: Role[] = ["planner"];
// Agents can't create subscriptions: one could otherwise send the log anywhere.
const integrators: Role[] = ["integration", "planner"];

const Preview = z.object({
  assumptions: z.record(z.string(), z.number()).optional(),
  figures: z.record(z.string(), z.number()).optional(),
});

async function bodyOf<S extends z.ZodType>(c: HonoContext<Env>, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(400, "invalid_body", z.prettifyError(parsed.error));
  return parsed.data;
}

const actorName = (c: HonoContext<Env>) => {
  const { role, name } = c.get("actor");
  return `${role}:${name}`;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

export function createApp(options: AppOptions) {
  const { service, webhooks, tokens, openAccess, staticDir, live, timeline, webhookHosts = [] } = options;
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.header(key, value);
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization");
    // EventSource can't send headers, so the event stream also takes a query token.
    const queryToken = c.req.path === "/v1/events" ? c.req.query("access_token") : undefined;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
    if (token !== undefined) {
      const actor = tokens.get(token);
      if (!actor) throw new ApiError(401, "bad_token", "Unknown token");
      c.set("actor", actor);
    } else if (openAccess) {
      c.set("actor", { role: "planner", name: "local" });
    } else {
      throw new ApiError(401, "token_required", "A token is required");
    }
    await next();
  });

  // A client that retries after a timeout can send the same Idempotency-Key, and
  // gets the first response back instead of writing twice.
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
    if (!key || c.req.method === "GET") return next();
    const actor = actorName(c);
    const seen = service.log.db.prepare("SELECT status, body FROM idempotency WHERE actor = ? AND key = ?").get(actor, key) as
      | { status: number; body: string }
      | undefined;
    if (seen) return c.body(seen.body, seen.status as 200, { "content-type": "application/json", "idempotent-replay": "true" });
    await next();
    if (c.res.ok) {
      const body = await c.res.clone().text();
      service.log.db.prepare("INSERT OR IGNORE INTO idempotency (actor, key, status, body) VALUES (?, ?, ?, ?)").run(actor, key, c.res.status, body);
    }
  });

  type Route = {
    method: "get" | "post" | "put";
    path: string;
    summary: string;
    roles: Role[];
    body?: z.ZodType;
    handler: (c: HonoContext<Env>) => Response | Promise<Response>;
  };

  const routes: Route[] = [
    {
      method: "post",
      path: "/v1/context",
      summary: "Add context as JSON, or upload a file as multipart/form-data",
      roles: contributors,
      body: NewContext,
      handler: async (c) => {
        const type = c.req.header("content-type") ?? "";
        if (!type.startsWith("multipart/form-data")) {
          return c.json(service.addContext(actorName(c), await bodyOf(c, NewContext)), 201);
        }
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) throw new ApiError(400, "invalid_body", "Expected a file field");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pages = await extractPages(file.name, bytes);
        const input = NewContext.parse({ title: String(form.title ?? file.name), folder: String(form.folder ?? "Inbox"), pages });
        const fileHash = createHash("sha256").update(bytes).digest("hex");
        return c.json(service.addContext(actorName(c), input, fileHash), 201);
      },
    },
    {
      method: "get",
      path: "/v1/context",
      summary: "List context",
      roles: anyone,
      handler: (c) => c.json([...service.state.contexts.values()]),
    },
    {
      method: "get",
      path: "/v1/context/:id/pages/:page",
      summary: "Read one page of a document",
      roles: anyone,
      handler: (c) => c.json({ text: service.contextPage(c.req.param("id") as string, Number(c.req.param("page"))) }),
    },
    {
      method: "post",
      path: "/v1/studies",
      summary: "Open a study",
      roles: authors,
      body: NewStudy,
      handler: async (c) => c.json(service.openStudy(actorName(c), await bodyOf(c, NewStudy)), 201),
    },
    {
      method: "get",
      path: "/v1/studies",
      summary: "List studies",
      roles: anyone,
      handler: (c) => c.json(service.studies()),
    },
    {
      method: "get",
      path: "/v1/studies/:id",
      summary: "Read a study: figures, checks, findings and decision",
      roles: anyone,
      handler: (c) => c.json(service.viewStudy(c.req.param("id") as string)),
    },
    {
      method: "post",
      path: "/v1/studies/:id/figures",
      summary: "Add a figure. Rejected if it has no valid source",
      roles: authors,
      body: NewFigure,
      handler: async (c) => c.json(service.addFigure(actorName(c), c.req.param("id") as string, await bodyOf(c, NewFigure)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/checks",
      summary: "Test a figure against a rule",
      roles: authors,
      body: NewCheck,
      handler: async (c) => c.json(service.addCheck(actorName(c), c.req.param("id") as string, await bodyOf(c, NewCheck)), 201),
    },
    {
      method: "post",
      path: "/v1/studies/:id/findings",
      summary: "Add a finding the service can't compute, such as public feedback",
      roles: authors,
      body: NewFinding,
      handler: async (c) => c.json(service.addFinding(actorName(c), c.req.param("id") as string, await bodyOf(c, NewFinding)), 201),
    },
    {
      method: "put",
      path: "/v1/studies/:id/findings/:finding/tone",
      summary: "Rate how a finding reads. Agents can only propose a tone. Planners only",
      roles: planners,
      body: FindingRating,
      handler: async (c) => {
        const { tone } = await bodyOf(c, FindingRating);
        return c.json(service.rateFinding(actorName(c), c.req.param("id") as string, c.req.param("finding") as string, tone));
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/figures/:figure/accept",
      summary: "Accept a skill's result so it can pass or fail a check. Planners only",
      roles: planners,
      handler: (c) => c.json(service.acceptFigure(actorName(c), c.req.param("id") as string, c.req.param("figure") as string)),
    },
    {
      method: "post",
      path: "/v1/studies/:id/activity",
      summary: "Report agent progress, messages, tokens and cost",
      roles: authors,
      body: Activity,
      handler: async (c) => {
        const entry = service.recordActivity(actorName(c), c.req.param("id") as string, await bodyOf(c, Activity));
        return c.json({ seq: entry.seq }, 201);
      },
    },
    {
      method: "post",
      path: "/v1/studies/:id/preview",
      summary: "Try a change. Writes nothing",
      roles: anyone,
      body: Preview,
      handler: async (c) => c.json(service.viewStudy(c.req.param("id") as string, await bodyOf(c, Preview))),
    },
    {
      method: "post",
      path: "/v1/studies/:id/decisions",
      summary: "Record a decision. Planners only",
      roles: planners,
      body: NewDecision,
      handler: async (c) => c.json(service.recordDecision(actorName(c), c.req.param("id") as string, await bodyOf(c, NewDecision)), 201),
    },
    {
      method: "get",
      path: "/v1/studies/:id/compare",
      summary: "See what changed between two log positions, and why",
      roles: anyone,
      handler: (c) => {
        const from = Number(c.req.query("from") ?? 0);
        const to = Number(c.req.query("to") ?? service.log.head().seq);
        return c.json(service.compare(c.req.param("id") as string, from, to));
      },
    },
    {
      method: "get",
      path: "/v1/studies/:id/timeline",
      summary: "See measured results and forecasts from today to the review date",
      roles: anyone,
      handler: (c) => {
        if (!timeline) throw new ApiError(404, "not_found", "Timeline is not available");
        return c.json(timeline(c.req.param("id") as string) as object);
      },
    },
    {
      method: "get",
      path: "/v1/studies/:id/figures/:figure/trace",
      summary: "Trace a figure back to its source",
      roles: anyone,
      handler: (c) => c.json(service.trace(c.req.param("id") as string, c.req.param("figure") as string)),
    },
    {
      method: "put",
      path: "/v1/assumptions/:key",
      summary: "Set or change an assumption, with a reason. Planners only",
      roles: planners,
      body: NewAssumption,
      handler: async (c) => c.json(service.setAssumption(actorName(c), c.req.param("key") as string, await bodyOf(c, NewAssumption))),
    },
    {
      method: "get",
      path: "/v1/assumptions",
      summary: "List assumptions with their history",
      roles: anyone,
      handler: (c) => c.json([...service.state.assumptions.values()]),
    },
    {
      method: "put",
      path: "/v1/skills/:name",
      summary: "Approve a skill version, so its results can enter studies. Planners only",
      roles: planners,
      body: NewSkill,
      handler: async (c) => c.json(service.registerSkill(actorName(c), c.req.param("name") as string, await bodyOf(c, NewSkill)), 201),
    },
    {
      method: "post",
      path: "/v1/log/:seq/remove-content",
      summary: "Remove an entry's content for retention or privacy. The entry and chain stay. Planners only",
      roles: planners,
      body: ContentRemoval,
      handler: async (c) => {
        const { reason } = await bodyOf(c, ContentRemoval);
        return c.json(service.removeContent(actorName(c), Number(c.req.param("seq")), reason), 201);
      },
    },
    {
      method: "get",
      path: "/v1/log",
      summary: "Read the log from a position",
      roles: anyone,
      handler: (c) => {
        const after = Number(c.req.query("after") ?? 0);
        const limit = Math.min(Number(c.req.query("limit") ?? 200), 1000);
        return c.json(service.log.since(after, limit));
      },
    },
    {
      method: "get",
      path: "/v1/log/verify",
      summary: "Check the hash chain",
      roles: anyone,
      handler: (c) => c.json(service.log.verify()),
    },
    {
      method: "get",
      path: "/v1/log/head",
      summary: "Read the latest position and hash, to keep as a witness",
      roles: anyone,
      handler: (c) => c.json(service.log.head()),
    },
    {
      method: "get",
      path: "/v1/usage",
      summary: "Tokens and cost, in total and by study",
      roles: anyone,
      handler: (c) => c.json(service.usage()),
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
        if (!openAccess && !webhookHosts.includes(host)) {
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
    app[route.method](route.path, async (c) => {
      if (!route.roles.includes(c.get("actor").role)) {
        throw new ApiError(403, "forbidden", `A ${c.get("actor").role} can't do this`);
      }
      return route.handler(c);
    });
  }

  // Everything that happens, live. Resume with Last-Event-ID or ?after=.
  app.get("/v1/events", (c) => {
    const wanted = c.req.query("types")?.split(",").filter(Boolean);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    const matches = (entry: Entry) => !wanted || wanted.includes(entry.type);
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
      for (const entry of service.log.since(after, 100_000)) {
        if (matches(entry)) await stream.writeSSE({ id: String(entry.seq), event: entry.type, data: JSON.stringify(entry) });
      }
      const sent = service.log.head().seq;
      while (!stream.aborted) {
        const entry = queue.shift();
        if (!entry) {
          await Promise.race([
            new Promise<void>((resolve) => (wake = resolve)),
            stream.sleep(20_000).then(() => stream.write(": keep-alive\n\n")),
          ]);
          continue;
        }
        if (entry.seq > sent && matches(entry)) {
          await stream.writeSSE({ id: String(entry.seq), event: entry.type, data: JSON.stringify(entry) });
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
        ...(route.body
          ? { requestBody: { content: { "application/json": { schema: z.toJSONSchema(route.body, { io: "input", unrepresentable: "any" }) } } } }
          : {}),
        responses: { default: { description: "See summary" } },
      };
    }
    paths["/v1/events"] = { get: { summary: "Stream the log as server-sent events", "x-roles": anyone, responses: { default: { description: "Event stream" } } } };
    return c.json({ openapi: "3.1.0", info: { title: "Transit Agents", version: "0.1.0" }, paths });
  });

  app.get("/health", (c) => c.json({ ok: true, head: service.log.head() }));

  if (staticDir && existsSync(staticDir)) {
    const root = resolve(staticDir);
    app.use("*", compress());
    app.get("*", (c) => {
      const requested = normalize(decodeURIComponent(new URL(c.req.url).pathname));
      const candidate = join(root, requested === "/" ? "index.html" : requested);
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
