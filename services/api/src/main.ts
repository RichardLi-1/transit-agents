import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Role } from "@transit-agents/contracts";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createApp, type Actor } from "./app.ts";
import { Collector, loadSchedule } from "./collector.ts";
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

mkdirSync(dataDir, { recursive: true });

const service = new Service(join(dataDir, "log.db"));
const webhooks = new Webhooks(service, process.env.PUBLIC_URL);
const stopInbox = watchInbox(service, join(dataDir, "inbox"));
// Measurements live apart from the log, so a demo can reset one without losing the other.
const measurements = new DatabaseSync(join(dataDir, "measurements.db"));
const collector = new Collector(measurements, loadSchedule(join(import.meta.dirname, "../assets/departures.json.gz")));
if (process.env.LIVE_FEED !== "off") collector.start();

const app = createApp({
  service,
  webhooks,
  tokens: parseTokens(process.env.TRANSIT_TOKENS),
  openAccess: process.env.AUTH !== "required",
  staticDir: join(root, "apps/display/dist"),
  live: collector,
  timeline: (id) => buildTimeline(service, collector, id),
});

const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`Transit Agents on http://${host}:${port}`);
});

const shutdown = () => {
  stopInbox();
  collector.stop();
  webhooks.stop();
  server.close(() => service.close());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
