import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { AccessMode, Role } from "@transit-agents/contracts";
import { mkdirSync } from "node:fs";
import { createApp, type Actor } from "./app.ts";
import { auth0Settings } from "./auth0.ts";
import { loadSchedule, Measurements, openMeasurements } from "./collector.ts";
import { watchInbox } from "./inbox.ts";
import { Service } from "./service.ts";
import { buildTimeline } from "./timeline.ts";
import { Webhooks } from "./webhooks.ts";

const root = resolve(import.meta.dirname, "../../..");
const dataDir = resolve(process.env.DATA_DIR ?? join(root, "data"));
const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";

// TRANSIT_TOKENS=agent:lead:abc123,planner:ana:def456
function parseTokens(value = ""): Map<string, Actor> {
  const tokens = new Map<string, Actor>();
  for (const item of value.split(",").filter(Boolean)) {
    const [role, name, token] = item.split(":");
    if (!role || !name || !token) throw new Error(`Bad token entry "${item}". Use role:name:token`);
    tokens.set(token, { role: Role.parse(role), name });
  }
  return tokens;
}

// AUTH=token, the default, needs a token for every /v1 request. AUTH=demo lets
// anyone read. AUTH=open lets anyone act as a planner.
function parseAccess(value = "token"): AccessMode {
  const mode = AccessMode.safeParse(value);
  if (!mode.success) throw new Error(`Unknown AUTH "${value}". Use token, demo or open`);
  return mode.data;
}

const access = parseAccess(process.env.AUTH || undefined);
const { verifyToken, signIn } = auth0Settings(process.env);

mkdirSync(dataDir, { recursive: true });

const service = new Service(join(dataDir, "log.db"));
const webhooks = new Webhooks(service, process.env.PUBLIC_URL);
const stopInbox = watchInbox(service, join(dataDir, "inbox"));
// Measurements live apart from the log, so a demo can reset one without losing
// the other. The collector, a separate process, writes them.
const measurements = new Measurements(
  openMeasurements(join(dataDir, "measurements.db")),
  loadSchedule(join(import.meta.dirname, "../assets/departures.json.gz")),
);

const app = createApp({
  service,
  webhooks,
  tokens: parseTokens(process.env.TRANSIT_TOKENS),
  verifyToken,
  access,
  signIn,
  webhookHosts: (process.env.WEBHOOK_HOSTS ?? "").split(",").filter(Boolean),
  staticDir: join(root, "apps/display/dist"),
  live: measurements,
  timeline: (id) => buildTimeline(service, measurements, id),
  publicUrl: process.env.PUBLIC_URL,
});

const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`Transit Agents on http://${host}:${port}`);
  if (access === "open") {
    console.warn("AUTH=open: requests without a token act as a planner. Use only on a machine you control.");
  }
  if (access === "demo") console.log("AUTH=demo: demo mode is on. Anyone can read without a token; writes need a token.");
});

const shutdown = () => {
  stopInbox();
  webhooks.stop();
  server.close(() => service.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
