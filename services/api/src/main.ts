import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { AccessMode, Role } from "@transit-agents/contracts";
import { mkdirSync } from "node:fs";
import { createApp, type Actor } from "./app.ts";
import { auth0Settings } from "./auth0.ts";
import { VisitorBudget } from "./budget.ts";
import { loadSchedule, Measurements, openMeasurements } from "./collector.ts";
import { watchInbox } from "./inbox.ts";
import { VisitorLimits } from "./limits.ts";
import { Service } from "./service.ts";
import { Slack, slackUrl } from "./slack.ts";
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
    // A guest's sandbox comes from a guest pass. A static guest token would share
    // one sandbox among everyone who held it.
    if (role === "guest") throw new Error(`Bad token entry for guest:${name}. Guests use guest passes, not tokens`);
    tokens.set(token, { role: Role.parse(role), name });
  }
  return tokens;
}

// GUEST_DAILY_USD=10, say. Unset, it is the fallback.
function dollars(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${name} should be a number of dollars, such as ${fallback}, not "${value}"`);
  return amount;
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

// Visitors get guest passes only in demo mode, and only with a secret long enough
// that nobody can guess it and sign passes of their own.
const guestSecret = process.env.GUEST_SECRET ?? "";
const guests = access === "demo" && guestSecret.length >= 32 ? { secret: guestSecret } : undefined;
// Visitors share a daily Gemini budget, counted from the log as the service starts.
const budget = new VisitorBudget({
  capUsd: dollars("GUEST_DAILY_USD", 10),
  marginUsd: dollars("GUEST_MARGIN_USD", 2),
  shareUsd: dollars("GUEST_SHARE_USD", 1),
});
// The static agent tokens, by name, that may act for a visitor.
const visitorAgents = (process.env.VISITOR_AGENTS ?? "lead,media")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

mkdirSync(dataDir, { recursive: true });

const service = new Service(join(dataDir, "log.db"), { mediaDir: join(dataDir, "media"), budget });
const webhooks = new Webhooks(service, process.env.PUBLIC_URL);
// Notices to one Slack channel. The address is a secret, so no line here prints it.
const slackAddress = slackUrl(process.env.SLACK_WEBHOOK_URL);
const slack = slackAddress ? new Slack(service, slackAddress, { publicUrl: process.env.PUBLIC_URL }) : null;
if (slack) console.log("Slack is on: the shared record's notices go to SLACK_WEBHOOK_URL.");
else if (process.env.SLACK_WEBHOOK_URL) console.warn("Slack is off: SLACK_WEBHOOK_URL must be a Slack incoming webhook, https://hooks.slack.com/services/...");
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
  timeline: (id, view) => buildTimeline(view, measurements, id),
  publicUrl: process.env.PUBLIC_URL,
  guests,
  budget,
  limits: new VisitorLimits(),
  visitorAgents,
});

// HTTP/1.1, so it can close every connection. PORT=0 takes any free port.
const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Transit Agents on http://${host}:${info.port}`);
  if (access === "open") {
    console.warn("AUTH=open: requests without a token act as a planner. Use only on a machine you control.");
  }
  if (access === "demo") console.log("AUTH=demo: demo mode is on. Anyone can read without a token; writes need a token.");
  if (guests) console.log(`Guests are on: visitors get guest passes, and share $${budget.capUsd.toFixed(2)} of agent work a day.`);
  else if (access === "demo") console.log("Guests are off. Set GUEST_SECRET, 32 or more characters, to turn them on.");
}) as Server;

// Stops once, though it can be told twice: Ctrl-C in `npm run demo` sends
// SIGINT here, and the demo script sends SIGTERM as well.
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stopInbox();
  webhooks.stop();
  slack?.stop();
  server.close(() => service.close());
  // An open event stream never ends by itself, and would keep the service
  // running and a display listening to it. Ending it lets the display
  // reconnect to the next service.
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
