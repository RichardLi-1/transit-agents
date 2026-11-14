import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "./app.ts";
import { Service } from "./service.ts";
import { aiFetchMessage, discordUrl, matchAiFetcher, readVisit, scoreVisit, visitMessage, Visits } from "./visits.ts";
import { Webhooks } from "./webhooks.ts";

const BROWSER = new Headers({
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140.0",
  "sec-ch-ua": '"Chromium";v="140"',
  "accept-language": "en-CA",
  "sec-fetch-site": "same-origin",
  "fly-client-ip": "203.0.113.7",
  "fly-region": "yyz",
});
const PERSON = { userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0", languagesCount: 2, screenWidth: 1440, screenHeight: 900, outerWidth: 1440, outerHeight: 860, pluginsCount: 5, pointerMoves: 40, scrolls: 3, msObserved: 5000 };

function setup() {
  const sent: string[] = [];
  const visits = new Visits("https://discord.com/api/webhooks/1/x", {
    post: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).content);
      return new Response(null, { status: 204 });
    },
  });
  const service = new Service(":memory:");
  const app = createApp({ service, webhooks: new Webhooks(service, "https://example.test", async () => new Response("ok")), tokens: new Map(), access: "demo", visits });
  return { app, sent };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("visits", () => {
  it("reads only what a page reports, cut short and without control characters", () => {
    assert.equal(readVisit({ kind: "visit", path: "no-slash" }), null);
    assert.equal(readVisit({ kind: "other", path: "/" }), null);
    const visit = readVisit({ kind: "visit", path: "/docs/", trail: ["/", "/docs/", 4], referral: "Linked\nIn" + "x".repeat(100), signals: { pointerMoves: "9" } });
    assert.deepEqual(visit?.trail, ["/", "/docs/"]);
    assert.equal(visit?.referral, `Linked In${"x".repeat(31)}`);
    assert.equal(visit?.signals?.pointerMoves, undefined);
  });

  it("scores a person who moved and scrolled high, and a headless browser low", () => {
    assert.equal(scoreVisit(PERSON, BROWSER).label, "likely human");
    const headless = scoreVisit({ ...PERSON, userAgent: "HeadlessChrome/140", webdriver: true, pointerMoves: 0, scrolls: 0 }, new Headers());
    assert.equal(headless.label, "likely bot");
    assert.ok(headless.reasons.includes("-50 webdriver flag (automated browser)"));
  });

  it("writes the message, with the address and the edge near the visitor", () => {
    const visit = readVisit({ kind: "visit", path: "/", trail: ["/", "/docs/"], referral: "LinkedIn", device: "🖥️ Desktop · macOS", signals: PERSON });
    const message = visitMessage(visit!, BROWSER, new Date("2026-11-14T00:00:00Z"));
    assert.match(message, /^🔔 \[transit-agents\] 👀 New visitor from \*\*LinkedIn\*\* on \/\n/);
    assert.match(message, /🛤️ Path: \/ → \/docs\//);
    assert.match(message, /🌐 IP: 203\.0\.113\.7/);
    assert.match(message, /📍 Near: Toronto \(yyz\)/);
    assert.match(message, /🧍 Human likelihood: \*\*\d+\/100\*\* \(likely human\)/);
  });

  it("says a quick bounce, with how long", () => {
    const visit = readVisit({ kind: "bounce", path: "/spend", trail: ["/spend"], seconds: 3, ai: "ChatGPT (web, referrer sent)" });
    const message = visitMessage(visit!, new Headers());
    assert.match(message, /👋 Quick bounce from \*\*ChatGPT\*\* \(AI assistant\) on \/spend/);
    assert.match(message, /⏱️ Time on page: 3s/);
  });

  it("takes a page view at /v1/track with no token, and answers 204 sent or not", async () => {
    const { app, sent } = setup();
    const response = await app.request("/v1/track", { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(BROWSER) }, body: JSON.stringify({ kind: "visit", path: "/", trail: ["/"] }) });
    assert.equal(response.status, 204);
    const junk = await app.request("/v1/track", { method: "POST", body: "not json" });
    assert.equal(junk.status, 204);
    await settle();
    assert.equal(sent.length, 1);
  });

  it("refuses a page view another site sends", async () => {
    const { app, sent } = setup();
    const response = await app.request("/v1/track", { method: "POST", headers: { origin: "https://elsewhere.test" }, body: JSON.stringify({ kind: "visit", path: "/" }) });
    assert.equal(response.status, 403);
    await settle();
    assert.equal(sent.length, 0);
  });

  it("is no agent's tool", async () => {
    const { app } = setup();
    const spec = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    assert.equal(spec.paths["/v1/track"], undefined);
  });

  it("logs an AI assistant fetching a page, and tells Discord when a person asked it", async () => {
    const { app, sent } = setup();
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await app.request("/docs/", { headers: { "user-agent": "Mozilla/5.0; ChatGPT-User/1.0" } });
      await app.request("/docs/", { headers: { "user-agent": "GPTBot/1.2" } });
      await app.request("/fonts/x.woff2", { headers: { "user-agent": "ChatGPT-User/1.0" } });
    } finally {
      console.log = log;
    }
    await settle();
    assert.deepEqual(lines.map((line) => JSON.parse(line).kind), ["user", "training"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0] as string, /ChatGPT-User\*\* read \/docs\/ for someone/);
  });

  it("sends at most so many a minute in all, and an hour from one address", () => {
    let now = 0;
    const visits = new Visits("https://discord.com/api/webhooks/1/x", { perMinute: 3, perAddress: 2, clock: () => now });
    assert.deepEqual([visits.take("a"), visits.take("a"), visits.take("a")], [true, true, false]);
    assert.deepEqual([visits.take("b"), visits.take("c")], [true, false]);
    now += 61_000;
    assert.deepEqual([visits.take("a"), visits.take("c")], [false, true]);
  });

  it("posts without @-mentions or link previews", async () => {
    let body: Record<string, unknown> = {};
    const visits = new Visits("https://discord.com/api/webhooks/1/x", {
      post: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
    });
    await visits.send("🔔 @everyone");
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.flags, 4);
  });

  it("takes only a Discord webhook's address", () => {
    assert.equal(discordUrl("https://discord.com/api/webhooks/1/abc"), "https://discord.com/api/webhooks/1/abc");
    assert.equal(discordUrl("https://hooks.slack.com/services/x"), undefined);
    assert.equal(discordUrl("http://discord.com/api/webhooks/1/abc"), undefined);
    assert.equal(discordUrl("https://discord.com.evil.test/api/webhooks/1"), undefined);
  });

  it("knows the AI fetchers by their user agents", () => {
    assert.equal(matchAiFetcher("Mozilla/5.0 Claude-User/1.0")?.kind, "user");
    assert.equal(matchAiFetcher("Mozilla/5.0 Safari"), null);
    assert.match(aiFetchMessage({ token: "Claude-User", vendor: "Anthropic", kind: "user" }, "/docs/?x=1"), /read \/docs\/ for someone/);
  });
});
