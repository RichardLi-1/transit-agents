import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp, type Actor } from "./app.ts";
import { watchInbox } from "./inbox.ts";
import { Service } from "./service.ts";
import { describe as describeEntry, format, sign, Webhooks } from "./webhooks.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);

function setup({ openAccess = false, post }: { openAccess?: boolean; post?: typeof fetch } = {}) {
  const service = new Service(":memory:");
  const webhooks = new Webhooks(service, "https://example.test", post ?? (async () => new Response("ok")));
  const app = createApp({ service, webhooks, tokens: TOKENS, openAccess });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { service, webhooks, app, call };
}

const STUDY = { id: "lawrence", title: "Lawrence–Sunnybrook" };
const DECISION = { outcome: "adopt", reason: "Passes the tests", decidedBy: "Ana Ruiz" };

describe("roles", () => {
  it("refuses a decision from an agent", async () => {
    const { call, service } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const response = await call("POST", "/v1/studies/lawrence/decisions", "agent-token", DECISION);
    assert.equal(response.status, 403);
    assert.deepEqual((await response.json()).error.code, "forbidden");
    assert.equal(service.state.studies.get("lawrence")?.decisions.length, 0);
  });

  it("accepts a decision from a planner, and records who sent it", async () => {
    const { call, service } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const response = await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION);
    assert.equal(response.status, 201);
    assert.equal(service.log.since(0).at(-1)?.actor, "planner:ana");
  });

  it("refuses an assumption change from an agent", async () => {
    const { call } = setup();
    assert.equal((await call("PUT", "/v1/assumptions/k", "agent-token", { value: 1, reason: "Because" })).status, 403);
  });

  it("lets an integration add context, and nothing else", async () => {
    const { call } = setup();
    assert.equal((await call("POST", "/v1/context", "integration-token", { title: "Export", text: "rows" })).status, 201);
    assert.equal((await call("POST", "/v1/studies", "integration-token", STUDY)).status, 403);
  });

  it("gives an anonymous caller read access only", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/v1/studies")).status, 200);
    assert.equal((await call("POST", "/v1/context", undefined, { title: "x" })).status, 403);
  });

  it("rejects an unknown token", async () => {
    const { call } = setup({ openAccess: true });
    assert.equal((await call("GET", "/v1/studies", "wrong")).status, 401);
  });

  it("keeps an agent an agent, even when local access is open", async () => {
    const { call } = setup({ openAccess: true });
    await call("POST", "/v1/studies", undefined, STUDY);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", "agent-token", DECISION)).status, 403);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", undefined, DECISION)).status, 201);
  });
});

describe("errors", () => {
  it("explains invalid input", async () => {
    const { call } = setup();
    const response = await call("POST", "/v1/studies", "agent-token", { id: "BAD ID" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_body");
  });

  it("returns 404 for an unknown study", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/v1/studies/nope")).status, 404);
  });
});

describe("openapi", () => {
  it("publishes every route, with roles", async () => {
    const { app } = setup();
    const spec = await (await app.request("/openapi.json")).json();
    const decisions = spec.paths["/v1/studies/{id}/decisions"].post;
    assert.deepEqual(decisions["x-roles"], ["planner"]);
    assert.ok(decisions.requestBody);
    assert.ok(spec.paths["/v1/events"]);
  });
});

describe("events", () => {
  it("replays past entries, filtered by type", async () => {
    const { app, call } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION);
    const controller = new AbortController();
    const response = await app.request("/v1/events?types=decision.recorded", { signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: decision\.recorded/);
    assert.doesNotMatch(text, /study\.opened/);
    await reader.cancel();
    controller.abort();
  });
});

describe("webhooks", () => {
  type Sent = { url: string; body: string; headers: Record<string, string> };

  function recorder(failures = 0) {
    const sent: Sent[] = [];
    let remaining = failures;
    const post = (async (url: string, init: RequestInit) => {
      if (remaining-- > 0) return new Response("down", { status: 503 });
      sent.push({ url, body: init.body as string, headers: init.headers as Record<string, string> });
      return new Response("ok");
    }) as unknown as typeof fetch;
    return { sent, post };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("delivers decisions, signed, with the log head as a witness", async () => {
    const { sent, post } = recorder();
    const { call } = setup({ post });
    await call("POST", "/v1/studies", "agent-token", STUDY);
    await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x", secret: "a-long-shared-secret" });
    await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION);
    await settle();
    assert.equal(sent.length, 1);
    const [delivery] = sent;
    assert.ok(delivery);
    assert.equal(delivery.headers["x-transit-signature"], sign("a-long-shared-secret", delivery.body));
    const payload = JSON.parse(delivery.body);
    assert.equal(payload.entry.type, "decision.recorded");
    assert.equal(payload.head.seq, payload.entry.seq);
  });

  it("never writes the secret to the log", async () => {
    const { call, service } = setup();
    await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x", secret: "a-long-shared-secret" });
    assert.doesNotMatch(JSON.stringify(service.log.since(0)), /a-long-shared-secret/);
  });

  it("only sends subscribed types", async () => {
    const { sent, post } = recorder();
    const { call } = setup({ post });
    await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x" });
    await call("POST", "/v1/studies", "agent-token", STUDY);
    await settle();
    assert.equal(sent.length, 0);
  });

  it("catches up after a receiver comes back", async () => {
    const { sent, post } = recorder(1);
    const { call, webhooks } = setup({ post });
    await call("POST", "/v1/studies", "agent-token", STUDY);
    await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x" });
    await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION);
    await settle();
    assert.equal(sent.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(sent.length, 1);
    webhooks.stop();
  });

  it("formats for Slack and Teams, and flags an override", async () => {
    const { call, service } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const entry = service.log.append({
      actor: "planner:ana",
      type: "decision.recorded",
      studyId: "lawrence",
      data: { outcome: "reject", decidedBy: "Ana Ruiz", override: true },
    });
    assert.equal(describeEntry(entry, service), "Lawrence–Sunnybrook: reject, decided by Ana Ruiz. Override of the analysis.");
    assert.match((format(entry, service, "slack", "https://x.test") as { text: string }).text, /<https:\/\/x\.test\|Open>/);
    const teams = format(entry, service, "teams") as { attachments: { contentType: string }[] };
    assert.equal(teams.attachments[0]?.contentType, "application/vnd.microsoft.card.adaptive");
  });
});

describe("inbox", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-inbox-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ingests a dropped file once it stops changing, and moves it aside", async () => {
    const service = new Service(":memory:");
    const stop = watchInbox(service, dir);
    writeFileSync(join(dir, "hastus-export.csv"), "route,trips\n52,300\n");
    const deadline = Date.now() + 7000;
    while (!service.state.contexts.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    stop();
    const [context] = [...service.state.contexts.values()];
    assert.equal(context?.title, "hastus-export.csv");
    assert.equal(context?.addedBy, "integration:inbox");
    assert.equal(context?.pageCount, 1);
    assert.equal(existsSync(join(dir, "hastus-export.csv")), false);
    assert.equal(readdirSync(join(dir, "processed")).length, 1);
  });
});
