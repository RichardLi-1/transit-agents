import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AccessMode, SignIn } from "@transit-agents/contracts";
import { createApp, type Actor, type Verified } from "./app.ts";
import { watchInbox } from "./inbox.ts";
import { Service } from "./service.ts";
import { describe as describeEntry, format, sign, Webhooks } from "./webhooks.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);

type Setup = {
  access?: AccessMode;
  signIn?: SignIn;
  verifyToken?: (token: string) => Promise<Actor | undefined>;
  post?: typeof fetch;
  webhookHosts?: string[];
  staticDir?: string;
};

function setup({ access = "token", signIn, verifyToken, post, webhookHosts = ["hook.test"], staticDir }: Setup = {}) {
  const service = new Service(":memory:");
  const webhooks = new Webhooks(service, "https://example.test", post ?? (async () => new Response("ok")));
  const app = createApp({ service, webhooks, tokens: TOKENS, verifyToken, access, signIn, webhookHosts, staticDir });
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
const SIGN_IN: SignIn = { provider: "auth0", domain: "tenant.auth0.test", clientId: "display-client", audience: "https://api.transit.test" };

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

  it("turns away a caller with no token, unless open access was chosen", async () => {
    assert.equal((await setup().call("GET", "/v1/studies")).status, 401);
    assert.equal((await setup({ access: "open" }).call("GET", "/v1/studies")).status, 200);
  });

  it("lets a viewer read and nothing else", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/v1/studies", "viewer-token")).status, 200);
    assert.equal((await call("POST", "/v1/context", "viewer-token", { title: "x" })).status, 403);
  });

  it("refuses a webhook from an agent, and to an unapproved host", async () => {
    const { call } = setup();
    assert.equal((await call("POST", "/v1/subscriptions", "agent-token", { url: "https://hook.test/x" })).status, 403);
    assert.equal((await call("POST", "/v1/subscriptions", "integration-token", { url: "https://attacker.test/x" })).status, 403);
    assert.equal((await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x" })).status, 201);
  });

  it("lets only a planner rate consultation, approve a skill or accept a result", async () => {
    const { call } = setup();
    assert.equal((await call("PUT", "/v1/skills/r5", "agent-token", { version: "1" })).status, 403);
    assert.equal((await call("PUT", "/v1/skills/r5", "planner-token", { version: "1" })).status, 201);
    await call("POST", "/v1/studies", "agent-token", STUDY);
    assert.equal((await call("PUT", "/v1/studies/lawrence/findings/f/tone", "agent-token", { tone: "positive" })).status, 403);
    assert.equal((await call("POST", "/v1/studies/lawrence/figures/f/accept", "agent-token")).status, 403);
  });

  it("rejects an unknown token", async () => {
    const { call } = setup({ access: "open" });
    assert.equal((await call("GET", "/v1/studies", "wrong")).status, 401);
  });

  it("rejects a token its verifier can't check, such as when the keys can't be fetched", async () => {
    const { call } = setup({ access: "demo", verifyToken: () => Promise.reject(new TypeError("fetch failed")) });
    assert.equal((await call("GET", "/v1/studies", "a-person")).status, 401);
    assert.equal((await call("GET", "/v1/studies", "agent-token")).status, 200);
  });

  it("keeps an agent an agent, even when local access is open", async () => {
    const { call } = setup({ access: "open" });
    await call("POST", "/v1/studies", undefined, STUDY);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", "agent-token", DECISION)).status, 403);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", undefined, DECISION)).status, 201);
  });

  it("reads the scheme in any case, and refuses any other Authorization header instead of acting without it", async () => {
    for (const access of ["token", "demo", "open"] as const) {
      const { app } = setup({ access });
      const me = (authorization: string) => app.request("/v1/me", { headers: { authorization } });
      assert.deepEqual(await (await me("bearer agent-token")).json(), { role: "agent", name: "lead" }, access);
      for (const authorization of ["bearer wrong", "Bearer", "Bearer agent-token extra", "Basic YWdlbnQ6dG9rZW4="]) {
        const response = await me(authorization);
        assert.equal(response.status, 401, `${access}: ${authorization}`);
        assert.equal((await response.json()).error.code, "bad_token", `${access}: ${authorization}`);
      }
    }
  });
});

describe("demo mode", () => {
  const PLAN = { id: "plan", title: "2026 Plan", pages: [{ page: 1, text: "a weekly system ridership increase of 1,680 customers" }] };
  const FIGURE = { id: "riders", label: "Riders", value: 1680, basis: { kind: "cited", citation: { contextId: "plan", page: 1, quote: "ridership increase of 1,680 customers" } } };

  // A study with a source and an agent's message, so each write has a real target.
  async function demo() {
    const app = setup({ access: "demo" });
    assert.equal((await app.call("POST", "/v1/context", "integration-token", PLAN)).status, 201);
    assert.equal((await app.call("POST", "/v1/studies", "agent-token", STUDY)).status, 201);
    assert.equal((await app.call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "Reading the plan" })).status, 201);
    return app;
  }

  it("lets anyone read, preview and follow events without a token", async () => {
    const { app, call } = await demo();
    for (const path of ["/v1/studies", "/v1/studies/lawrence", "/v1/context", "/v1/context/plan/pages/1", "/v1/log", "/v1/usage"]) {
      assert.equal((await call("GET", path)).status, 200, path);
    }
    assert.equal((await call("POST", "/v1/studies/lawrence/preview", undefined, { assumptions: {} })).status, 200);
    const controller = new AbortController();
    const events = await app.request("/v1/events?types=study.opened", { signal: controller.signal });
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: study\.opened/);
    await reader.cancel();
    controller.abort();
  });

  it("needs a token for a figure, decision, upload, rule change, webhook or content removal", async () => {
    const { app, call, service } = await demo();
    const head = service.log.head().seq;
    const upload = new FormData();
    upload.set("file", new File(["route,trips\n52,300\n"], "hastus-export.csv"));
    const writes = {
      figure: await call("POST", "/v1/studies/lawrence/figures", undefined, FIGURE),
      decision: await call("POST", "/v1/studies/lawrence/decisions", undefined, DECISION),
      upload: await app.request("/v1/context", { method: "POST", body: upload }),
      rule: await call("PUT", "/v1/assumptions/min-riders-per-100", undefined, { value: 1, reason: "Lower the bar" }),
      webhook: await call("POST", "/v1/subscriptions", undefined, { url: "https://hook.test/x" }),
      removal: await call("POST", `/v1/log/${head}/remove-content`, undefined, { reason: "Privacy request" }),
    };
    for (const [write, response] of Object.entries(writes)) {
      assert.equal(response.status, 401, write);
      assert.equal((await response.json()).error.code, "token_required", write);
    }
    assert.equal(service.log.head().seq, head);
  });

  it("refuses every route a viewer can't call, as token mode does", async () => {
    const { app, call } = setup({ access: "demo" });
    const spec = await (await app.request("/openapi.json")).json();
    for (const [path, operations] of Object.entries(spec.paths as Record<string, Record<string, { "x-roles": string[] }>>)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (operation["x-roles"].includes("viewer")) continue;
        assert.equal((await call(method.toUpperCase(), path.replace(/\{\w+\}/g, "x"), undefined, {})).status, 401, `${method} ${path}`);
      }
    }
  });

  it("keeps no idempotency record for a preview", async () => {
    const { app, service } = await demo();
    const preview = () =>
      app.request("/v1/studies/lawrence/preview", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k1" }, body: "{}" });
    assert.equal((await preview()).status, 200);
    assert.equal((await preview()).headers.get("idempotent-replay"), null);
    assert.equal((service.log.db.prepare("SELECT count(*) AS n FROM idempotency").get() as { n: number }).n, 0);
  });

  it("still takes tokens, and refuses a bad one instead of reading as the demo viewer", async () => {
    const { app, call, service } = setup({ access: "demo" });
    assert.equal((await call("POST", "/v1/studies", "agent-token", STUDY)).status, 201);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", "viewer-token", DECISION)).status, 403);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION)).status, 201);
    assert.equal(service.log.since(0).at(-1)?.actor, "planner:ana");
    assert.equal((await call("GET", "/v1/studies", "wrong")).status, 401);
    assert.equal((await app.request("/v1/events?access_token=wrong")).status, 401);
  });

  it("sends webhooks only to approved hosts, as token mode does", async () => {
    const { call } = setup({ access: "demo" });
    assert.equal((await call("POST", "/v1/subscriptions", "integration-token", { url: "https://attacker.test/x" })).status, 403);
    assert.equal((await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x" })).status, 201);
  });
});

describe("config", () => {
  it("tells anyone how to sign in, even in token mode", async () => {
    const response = await setup({ signIn: SIGN_IN }).call("GET", "/v1/config");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      auth: "token",
      signIn: { provider: "auth0", domain: "tenant.auth0.test", clientId: "display-client", audience: "https://api.transit.test" },
    });
  });

  it("names the mode, and has no sign-in when Auth0 isn't set up", async () => {
    for (const access of ["token", "open", "demo"] as const) {
      assert.deepEqual(await (await setup({ access }).call("GET", "/v1/config")).json(), { auth: access, signIn: null });
    }
  });

  it("reads no token, so a stale one can't hide how to sign in", async () => {
    assert.equal((await setup().call("GET", "/v1/config", "stale-token")).status, 200);
    assert.equal((await setup().call("POST", "/v1/config")).status, 401);
  });
});

describe("me", () => {
  const me = async (options: Setup, token?: string) => (await setup(options).call("GET", "/v1/me", token)).json();

  it("says who the caller is", async () => {
    assert.deepEqual(await me({}, "planner-token"), { role: "planner", name: "ana" });
    assert.deepEqual(await me({}, "viewer-token"), { role: "viewer", name: "auditor" });
    assert.deepEqual(await me({ access: "demo" }, "agent-token"), { role: "agent", name: "lead" });
  });

  it("names whoever a request without a token acts as", async () => {
    assert.deepEqual(await me({ access: "demo" }), { role: "viewer", name: "demo" });
    assert.deepEqual(await me({ access: "open" }), { role: "planner", name: "local" });
    assert.equal((await setup().call("GET", "/v1/me")).status, 401);
  });
});

describe("security headers", () => {
  const policy = async (signIn?: SignIn) => {
    const header = (await setup({ signIn }).app.request("/health")).headers.get("content-security-policy") ?? "";
    return new Map(header.split("; ").map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1).join(" ")]));
  };

  it("keeps the page to its own origin", async () => {
    const response = await setup().app.request("/health");
    assert.equal(
      response.headers.get("content-security-policy"),
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });

  it("lets the page reach and frame the Auth0 tenant once people can sign in, and changes nothing else", async () => {
    const without = await policy();
    const signIn = await policy(SIGN_IN);
    assert.equal(signIn.get("connect-src"), "'self' https://tenant.auth0.test");
    assert.equal(signIn.get("frame-src"), "'self' https://tenant.auth0.test");
    for (const name of ["connect-src", "frame-src"]) {
      signIn.delete(name);
      without.delete(name);
    }
    assert.deepEqual(signIn, without);
  });
});

describe("request bodies", () => {
  it("refuses a body over 1 MB from anyone, whether or not it gives its length", async () => {
    const { app, call } = setup({ access: "demo" });
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const body = JSON.stringify({ assumptions: {}, pad: "a".repeat(1024 * 1024) });
    const preview = (init: RequestInit) => app.request("/v1/studies/lawrence/preview", { method: "POST", ...init });
    const responses = [
      await preview({ headers: { "content-type": "application/json", "content-length": String(body.length) }, body }),
      await preview({ headers: { "content-type": "application/json" }, body: new Blob([body]).stream(), duplex: "half" } as RequestInit),
    ];
    for (const response of responses) {
      assert.equal(response.status, 413);
      assert.equal((await response.json()).error.code, "too_large");
    }
    assert.equal((await call("POST", "/v1/studies/lawrence/preview", undefined, { assumptions: {} })).status, 200);
  });

  it("gives a contributor room to add a whole document as context", async () => {
    const { call } = setup();
    const pages = [{ page: 1, text: "a".repeat(4 * 1024 * 1024) }];
    assert.equal((await call("POST", "/v1/context", "integration-token", { id: "plan", title: "2026 Plan", pages })).status, 201);
  });
});

describe("idempotency", () => {
  it("returns the first response to a retried request, and writes once", async () => {
    const { app, service } = setup();
    const send = () =>
      app.request("/v1/studies", {
        method: "POST",
        headers: { authorization: "Bearer agent-token", "content-type": "application/json", "idempotency-key": "k1" },
        body: JSON.stringify(STUDY),
      });
    const first = await send();
    const second = await send();
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get("idempotent-replay"), "true");
    assert.equal(service.log.since(0).filter((e) => e.type === "study.opened").length, 1);
  });

  it("keeps records per credential, so two people who share a name never get each other's response", async () => {
    const people: Record<string, Verified> = {
      "kim-1": { role: "agent", name: "kim", subject: "auth0|1" },
      "kim-2": { role: "agent", name: "kim", subject: "auth0|2" },
    };
    const { app, service } = setup({ verifyToken: async (token) => people[token] });
    for (const token of ["kim-1", "kim-2"]) {
      const response = await app.request("/v1/studies", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "k1" },
        body: JSON.stringify({ id: token, title: token }),
      });
      assert.equal(response.status, 201, token);
      assert.equal(response.headers.get("idempotent-replay"), null, token);
    }
    assert.deepEqual([...service.state.studies.keys()], ["kim-1", "kim-2"]);
  });
});

describe("errors", () => {
  it("explains invalid input", async () => {
    const { call } = setup();
    const response = await call("POST", "/v1/studies", "agent-token", { id: "BAD ID" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_body");
  });

  it("refuses a page number given twice, and leaves the id free", async () => {
    const { call, service } = setup();
    const context = (pages: { page: number; text: string }[]) => call("POST", "/v1/context", "planner-token", { id: "plan", title: "Plan", pages });
    const repeated = await context([{ page: 1, text: "first" }, { page: 1, text: "second" }]);
    assert.equal(repeated.status, 400);
    assert.match((await repeated.json()).error.message, /Give each page number once/);
    assert.equal((await context([{ page: 1, text: "first" }, { page: 2, text: "second" }])).status, 201);
    assert.deepEqual(service.search("second", 10).map((result) => result.page), [2]);
  });

  it("returns 404 for an unknown study", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/v1/studies/nope", "viewer-token")).status, 404);
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

  it("lists config as needing no token, and me as open to any role", async () => {
    const { app } = setup();
    const spec = await (await app.request("/openapi.json")).json();
    assert.deepEqual(spec.security, [{ token: [] }]);
    assert.deepEqual(spec.paths["/v1/config"].get.security, []);
    assert.deepEqual(spec.paths["/v1/config"].get["x-roles"], ["viewer", "integration", "agent", "planner"]);
    assert.deepEqual(spec.paths["/v1/me"].get["x-roles"], ["viewer", "integration", "agent", "planner"]);
    assert.equal(spec.paths["/v1/me"].get.security, undefined);
  });
});

describe("events", () => {
  it("replays past entries, filtered by type, with a token in the query", async () => {
    const { app, call } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION);
    const controller = new AbortController();
    assert.equal((await app.request("/v1/events")).status, 401);
    const response = await app.request("/v1/events?types=decision.recorded&access_token=viewer-token", { signal: controller.signal });
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

  it("logs only the host of a webhook, since a Slack or Teams address is itself the secret", async () => {
    const { app, call, service } = setup({ access: "demo", webhookHosts: ["hooks.slack.com"] });
    const url = "https://hooks.slack.com/services/T0000000/B0000000/SECRETSECRETSECRETSECRET";
    assert.equal((await call("POST", "/v1/subscriptions", "integration-token", { url, format: "slack" })).status, 201);
    assert.equal((service.log.since(0).at(-1)?.data as { host?: string }).host, "hooks.slack.com");
    const controller = new AbortController();
    const events = await app.request("/v1/events?types=subscription.added", { signal: controller.signal });
    const streamed = new TextDecoder().decode((await (events.body as ReadableStream<Uint8Array>).getReader().read()).value);
    controller.abort();
    for (const read of [await (await call("GET", "/v1/log")).text(), streamed]) assert.doesNotMatch(read, /SECRET/);
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

  it("treats a changed file with no readable text as new", async () => {
    const service = new Service(":memory:");
    const stop = watchInbox(service, dir);
    const wait = async (count: number) => {
      const deadline = Date.now() + 7000;
      while (service.state.contexts.size < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    };
    writeFileSync(join(dir, "ridership.xlsx"), "first version");
    await wait(1);
    writeFileSync(join(dir, "ridership.xlsx"), "second version");
    await wait(2);
    stop();
    assert.equal(service.state.contexts.size, 2);
  });

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

describe("static files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-static-"));
    mkdirSync(join(dir, "site/spend"), { recursive: true });
    mkdirSync(join(dir, "site/assets"));
    mkdirSync(join(dir, "private"));
    writeFileSync(join(dir, "site/index.html"), "main page");
    writeFileSync(join(dir, "site/spend/index.html"), "spend page");
    writeFileSync(join(dir, "site/assets/app.js"), "script");
    writeFileSync(join(dir, "private/index.html"), "private page");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves a folder's own index.html, and the main page for anything else", async () => {
    const { app } = setup({ staticDir: join(dir, "site") });
    const body = async (path: string) => (await app.request(path)).text();
    assert.equal(await body("/"), "main page");
    assert.equal(await body("/spend"), "spend page");
    assert.equal(await body("/spend/"), "spend page");
    assert.equal((await app.request("/spend")).headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await body("/assets/app.js"), "script");
    assert.equal(await body("/assets"), "main page");
    assert.equal(await body("/spend/elsewhere"), "main page");
    assert.equal(await body("/..%2Fprivate"), "main page");
  });

  it("serves the main page for an address it can't decode", async () => {
    const { app } = setup({ staticDir: join(dir, "site") });
    for (const path of ["/%zz", "/spend/%zz", "/%E0%A4%A"]) {
      const response = await app.request(path);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "main page");
    }
  });
});
