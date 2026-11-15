import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BUDGET_SPENT, RATE_LIMITED, SIGN_IN_TO_DECIDE, type AccessMode, type NeedView, type SignIn } from "@transit-agents/contracts";
import { createApp, plannerName, type Actor, type Verified } from "./app.ts";
import { VisitorBudget } from "./budget.ts";
import { issueGuest, userAudience } from "./guests.ts";
import { watchInbox } from "./inbox.ts";
import { VisitorLimits } from "./limits.ts";
import { padded, SAMPLE } from "./sample-media.ts";
import { Service } from "./service.ts";
import { describe as describeEntry, format, sign, Webhooks } from "./webhooks.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
  ["replay-token", { role: "agent", name: "replay" }],
]);

const GUEST_SECRET = "a-guest-secret-of-at-least-32-characters";
// Two skill versions: content hashes, as agents/skills.py computes them.
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

type Setup = {
  access?: AccessMode;
  openName?: string;
  publicUrl?: string;
  signIn?: SignIn;
  verifyToken?: (token: string) => Promise<Verified | undefined>;
  post?: typeof fetch;
  webhookHosts?: string[];
  mediaDir?: string;
  staticDir?: string;
  guests?: boolean;
  budget?: VisitorBudget;
  limits?: VisitorLimits;
};

function setup({ access = "token", openName, signIn, verifyToken, post, webhookHosts = ["hook.test"], mediaDir, staticDir, publicUrl, guests, budget, limits }: Setup = {}) {
  const service = new Service(":memory:", { mediaDir, budget });
  const webhooks = new Webhooks(service, "https://example.test", post ?? (async () => new Response("ok")));
  const app = createApp({
    service,
    webhooks,
    tokens: TOKENS,
    verifyToken,
    access,
    openName,
    signIn,
    webhookHosts,
    staticDir,
    publicUrl,
    ...(guests ? { guests: { secret: GUEST_SECRET }, budget, limits, visitorAgents: ["lead", "media"] } : {}),
  });
  const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
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
    assert.equal((await call("PUT", "/v1/skills/r5", "agent-token", { version: HASH_A })).status, 403);
    assert.equal((await call("PUT", "/v1/skills/r5", "integration-token", { version: HASH_A })).status, 403);
    assert.equal((await call("PUT", "/v1/skills/r5", "planner-token", { version: HASH_A })).status, 201);
    await call("POST", "/v1/studies", "agent-token", STUDY);
    assert.equal((await call("PUT", "/v1/studies/lawrence/findings/f/tone", "agent-token", { tone: "positive" })).status, 403);
    assert.equal((await call("POST", "/v1/studies/lawrence/figures/f/accept", "agent-token")).status, 403);
  });

  it("approves only a skill's content hash, as its one current version, and lists them for anyone who reads", async () => {
    const { call, service } = setup();
    // A label, such as a version number a script could report for itself, isn't a hash.
    for (const version of ["1", "1.0.0", HASH_A.slice(0, 12), HASH_A.toUpperCase()]) {
      assert.equal((await call("PUT", "/v1/skills/r5", "planner-token", { version })).status, 400, version);
    }
    assert.deepEqual(await (await call("GET", "/v1/skills", "agent-token")).json(), { current: {} });
    assert.equal((await call("PUT", "/v1/skills/r5", "planner-token", { version: HASH_A })).status, 201);
    const replaced = await call("PUT", "/v1/skills/r5", "planner-token", { version: HASH_B });
    assert.deepEqual(await replaced.json(), { name: "r5", version: HASH_B, previous: HASH_A });
    assert.equal(service.log.since(0, 1000).at(-1)?.type, "skill.registered");
    assert.equal((await call("PUT", "/v1/skills/gis", "planner-token", { version: HASH_A })).status, 201);
    for (const token of ["agent-token", "viewer-token", "planner-token"]) {
      assert.deepEqual(await (await call("GET", "/v1/skills", token)).json(), { current: { r5: HASH_B, gis: HASH_A } });
    }
  });

  it("lets only a planner revoke a skill's current version, after which none is current", async () => {
    const { call, service } = setup();
    await call("PUT", "/v1/skills/r5", "planner-token", { version: HASH_A });
    for (const token of ["agent-token", "integration-token", "viewer-token"]) {
      assert.equal((await call("POST", "/v1/skills/r5/revoke", token, { reason: "Wrong" })).status, 403, token);
    }
    assert.equal((await call("POST", "/v1/skills/r5/revoke", "planner-token", { reason: "x" })).status, 400);
    assert.equal((await call("POST", "/v1/skills/r5/revoke", "planner-token", { reason: "Wrong", version: HASH_B })).status, 409);
    const revoked = await call("POST", "/v1/skills/r5/revoke", "planner-token", { reason: "Gives wrong travel times" });
    assert.equal(revoked.status, 201);
    assert.equal((await revoked.json()).revoked, HASH_A);
    const entry = service.log.since(0, 1000).at(-1);
    assert.equal(entry?.type, "skill.revoked");
    assert.equal(entry?.actor, "planner:ana");
    assert.deepEqual(await (await call("GET", "/v1/skills", "agent-token")).json(), { current: {} });
    assert.equal((await call("POST", "/v1/skills/r5/revoke", "planner-token", { reason: "Again" })).status, 404);
  });

  it("lets an agent put a skill version forward, which approves nothing until a planner does", async () => {
    const { call, service } = setup();
    const candidate = { version: HASH_B, parent: HASH_A, summary: "Hands over split consultation", dev: { candidate: { passed: 4, total: 5 }, parent: { passed: 3, total: 5 } } };
    const proposed = await call("POST", "/v1/skills/consultation/candidates", "agent-token", candidate);
    assert.equal(proposed.status, 201);
    assert.equal((await proposed.json()).approved, false);
    const entry = service.log.since(0, 1000).at(-1);
    assert.equal(entry?.type, "skill.proposed");
    assert.equal(entry?.actor, "agent:lead");
    assert.deepEqual(entry?.data, { name: "consultation", ...candidate });
    assert.equal(service.state.skills.get("consultation"), undefined);
    // Proposing again is no way round: only a planner's PUT approves it.
    assert.equal((await call("PUT", "/v1/skills/consultation", "agent-token", { version: HASH_B })).status, 403);
    assert.equal((await call("PUT", "/v1/skills/consultation", "planner-token", { version: HASH_B })).status, 201);
    assert.equal(service.state.skills.get("consultation"), HASH_B);
    // Planners and integrations approve or add; they don't put a version forward here.
    assert.equal((await call("POST", "/v1/skills/consultation/candidates", "planner-token", candidate)).status, 403);
    assert.equal((await call("POST", "/v1/skills/consultation/candidates", "integration-token", candidate)).status, 403);
    assert.equal((await call("POST", "/v1/skills/consultation/candidates", "agent-token", { ...candidate, version: HASH_A })).status, 422);
  });

  it("lets an agent hand a question to a planner as its own entry, which decides nothing", async () => {
    const { call, service } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const question = { id: "split", kind: "judgement", question: "Weigh split consultation against the tests?", detail: "Two channels disagree." };
    for (const token of ["planner-token", "integration-token", "viewer-token"]) {
      assert.equal((await call("POST", "/v1/studies/lawrence/questions", token, question)).status, 403, token);
    }
    assert.equal((await call("POST", "/v1/studies/lawrence/questions", "agent-token", { ...question, kind: "approve" })).status, 400);
    const asked = await call("POST", "/v1/studies/lawrence/questions", "agent-token", question);
    assert.equal(asked.status, 201);
    const entry = service.log.since(0, 1000).at(-1);
    assert.equal(entry?.type, "question.asked");
    assert.equal(entry?.actor, "agent:lead");
    assert.equal(entry?.studyId, "lawrence");
    assert.deepEqual(entry?.data, question);
    // Asking again changes nothing, and the study has no decision.
    assert.equal((await (await call("POST", "/v1/studies/lawrence/questions", "agent-token", question)).json()).seq, entry?.seq);
    assert.equal(service.log.since(0, 1000).at(-1)?.seq, entry?.seq);
    assert.equal(service.viewStudy("lawrence").decision, undefined);
  });

  it("names the open planner after PLANNER_NAME, so the presenter's decisions carry their name", async () => {
    const { call, service } = setup({ access: "open", openName: "Richard Li" });
    assert.deepEqual(await (await call("GET", "/v1/me")).json(), { role: "planner", name: "Richard Li" });
    await call("POST", "/v1/studies", undefined, STUDY);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", undefined, { ...DECISION, decidedBy: "Richard Li" })).status, 201);
    assert.equal(service.log.since(0).at(-1)?.actor, "planner:Richard Li");
    // Without a name it stays the local planner, and only open mode takes one.
    assert.deepEqual(await (await setup({ access: "open" }).call("GET", "/v1/me")).json(), { role: "planner", name: "local" });
    assert.deepEqual(await (await setup({ access: "demo", openName: "Richard Li" }).call("GET", "/v1/me")).json(), { role: "viewer", name: "demo" });
  });

  it("takes a planner's name of plain characters only", () => {
    assert.equal(plannerName("  Richard   Li "), "Richard Li");
    assert.equal(plannerName("Zoë O'Neil-Smith"), "Zoë O'Neil-Smith");
    for (const bad of [undefined, "", "   ", "a:b", "<script>", "x".repeat(81)]) assert.equal(plannerName(bad), undefined, String(bad));
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
      guests: false,
      executive: null,
    });
  });

  it("names the mode, and has no sign-in when Auth0 isn't set up", async () => {
    for (const access of ["token", "open", "demo"] as const) {
      assert.deepEqual(await (await setup({ access }).call("GET", "/v1/config")).json(), { auth: access, signIn: null, guests: false, executive: null });
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
      "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'",
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

  it("takes a source's address only if it's a web page", async () => {
    const { call } = setup();
    for (const url of ["javascript:alert(document.domain)", "data:text/html,<script>1</script>", "file:///etc/passwd"]) {
      const response = await call("POST", "/v1/context", "integration-token", { title: "Plan", text: "rows", url });
      assert.equal(response.status, 400, url);
    }
    assert.equal((await call("POST", "/v1/context", "integration-token", { title: "Plan", text: "rows", url: "https://cdn.ttc.ca/plan.pdf" })).status, 201);
  });

  it("gives a contributor room to add a whole document as context", async () => {
    const { call } = setup();
    const pages = [{ page: 1, text: "a".repeat(4 * 1024 * 1024) }];
    assert.equal((await call("POST", "/v1/context", "integration-token", { id: "plan", title: "2026 Plan", pages })).status, 201);
  });
});

describe("pages on other sites", () => {
  const send = (app: ReturnType<typeof setup>["app"], headers: Record<string, string>, url = "/v1/studies", id = "x") =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ...STUDY, id }) });
  const code = async (response: Response | Promise<Response>) => (await (await response).json()).error?.code;
  const MESSAGE = JSON.stringify({ kind: "message", text: "Run up the bill" });

  it("can't write under open access, though the service's own pages can", async () => {
    const { app, call, service } = setup({ access: "open" });
    await call("POST", "/v1/studies", undefined, STUDY);
    const post = (path: string, headers: Record<string, string>, body = MESSAGE) =>
      app.request(`http://127.0.0.1:4100${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const before = service.log.head().seq;

    for (const path of ["/v1/studies/lawrence/activity", "/v1/studies/lawrence/decisions", "/v1/studies"]) {
      const response = await post(path, { origin: "https://evil.example" }, path.endsWith("decisions") ? JSON.stringify(DECISION) : MESSAGE);
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, "forbidden_origin");
    }
    assert.equal(service.log.head().seq, before);

    assert.equal((await post("/v1/studies/lawrence/activity", { origin: "http://127.0.0.1:4100" })).status, 201);
    assert.equal((await post("/v1/studies/lawrence/activity", {})).status, 201); // not a browser
    assert.equal((await app.request("http://127.0.0.1:4100/v1/studies", { headers: { origin: "https://evil.example" } })).status, 200); // reads stay open
  });

  it("can write from PUBLIC_URL, and a name other than it counts as another site", async () => {
    const { app, call } = setup({ access: "open", publicUrl: "https://transit.example" });
    await call("POST", "/v1/studies", undefined, STUDY);
    const post = (origin: string) =>
      app.request("https://transit.example/v1/studies/lawrence/activity", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: MESSAGE,
      });
    assert.equal((await post("https://transit.example")).status, 201);
    // After DNS rebinding, the request's own name and origin agree, but it isn't PUBLIC_URL's.
    const rebound = await app.request("http://rebound.example/v1/studies/lawrence/activity", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://rebound.example" },
      body: MESSAGE,
    });
    assert.equal(rebound.status, 403);
  });

  it("can't send JSON as plain text, which a page needs no permission to send", async () => {
    const { app, call, service } = setup({ access: "open" });
    await call("POST", "/v1/studies", undefined, STUDY);
    const before = service.log.head().seq;
    for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", ""]) {
      const response = await app.request("/v1/studies/lawrence/activity", {
        method: "POST",
        headers: type ? { "content-type": type } : {},
        body: MESSAGE,
      });
      assert.equal(response.status, 415, type);
      assert.equal((await response.json()).error.code, "unsupported_media_type");
    }
    assert.equal(service.log.head().seq, before);
    const charset = await app.request("/v1/studies/lawrence/activity", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: MESSAGE });
    assert.equal(charset.status, 201);
  });

  it("can't write from another port, or as a browser that says cross-site, even with a token", async () => {
    const { app } = setup({ access: "open", publicUrl: "https://transit.example" });
    assert.equal(await code(send(app, { origin: "http://localhost:4314" })), "forbidden_origin");
    assert.equal(await code(send(app, { "sec-fetch-site": "cross-site" })), "forbidden_origin");
    assert.equal(await code(send(app, { origin: "https://evil.example", authorization: "Bearer planner-token" })), "forbidden_origin");
    // Its own pages, and a client with no Origin.
    assert.equal((await send(app, { origin: "http://localhost" }, "/v1/studies", "a")).status, 201);
    assert.equal((await send(app, { origin: "https://transit.example" }, "/v1/studies", "b")).status, 201);
    assert.equal((await send(app, { "sec-fetch-site": "same-origin" }, "/v1/studies", "c")).status, 201);
    assert.equal((await send(app, { authorization: "Bearer planner-token" }, "/v1/studies", "d")).status, 201);
  });

  it("answers no request without a token in open mode at a name that isn't this service's", async () => {
    const { app } = setup({ access: "open", publicUrl: "https://transit.example" });
    // After DNS rebinding, a name that isn't this service's is answered nothing.
    assert.equal(await code(app.request("http://evil.example/v1/studies")), "forbidden_host");
    assert.equal(await code(send(app, {}, "http://evil.example/v1/studies")), "forbidden_host");
    assert.equal((await app.request("https://transit.example/v1/studies")).status, 200);
    assert.equal((await app.request("http://127.0.0.1:4100/v1/studies")).status, 200);
    // A token is no browser's to send unasked.
    assert.equal((await app.request("http://evil.example/v1/studies", { headers: { authorization: "Bearer viewer-token" } })).status, 200);
  });

  it("in demo mode, can't even preview from another site", async () => {
    const { app } = setup({ access: "demo" });
    const preview = (origin: string) =>
      app.request("/v1/studies/lawrence/preview", { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
    assert.equal(await code(preview("https://evil.example")), "forbidden_origin");
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

  it("lists config and guest passes as needing no token, and me as open to any role", async () => {
    const { app } = setup();
    const spec = await (await app.request("/openapi.json")).json();
    assert.deepEqual(spec.security, [{ token: [] }]);
    assert.deepEqual(spec.paths["/v1/config"].get.security, []);
    assert.deepEqual(spec.paths["/v1/guests"].post.security, []);
    assert.deepEqual(spec.paths["/v1/config"].get["x-roles"], ["viewer", "integration", "agent", "planner", "guest"]);
    assert.deepEqual(spec.paths["/v1/me"].get["x-roles"], ["viewer", "integration", "agent", "planner", "guest"]);
    assert.equal(spec.paths["/v1/me"].get.security, undefined);
  });
});

describe("usage", () => {
  it("sends each total with an estimate that says it's a floor, and its source", async () => {
    const { call } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const used = { kind: "usage", model: "gemini", inputTokens: 900, outputTokens: 100, costUsd: 0.001 };
    for (let i = 0; i < 2; i++) assert.equal((await call("POST", "/v1/studies/lawrence/activity", "agent-token", used)).status, 201);
    const { total, byStudy } = await (await call("GET", "/v1/usage", "viewer-token")).json();
    // What older clients read is unchanged.
    assert.equal(total.calls, 2);
    assert.equal(total.inputTokens, 1800);
    const { basis, ...amounts } = total.estimate;
    assert.deepEqual(amounts, { atLeast: true, energyWh: 0.48, co2eGrams: 0.06, waterMl: 0.52 });
    assert.deepEqual(Object.keys(basis.source), ["title", "url", "date", "quote"]);
    assert.equal(basis.source.url, "https://arxiv.org/abs/2508.15734");
    assert.deepEqual(byStudy.lawrence.estimate, total.estimate);
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

  it("sends an entry written while it replays the log", async () => {
    const { app, call, service } = setup();
    for (let i = 0; i < 50; i += 1) service.log.append({ actor: "agent:lead", type: "note", data: { i } });
    const controller = new AbortController();
    const response = await app.request("/v1/events?access_token=viewer-token", { signal: controller.signal });
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes("study.opened") && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 100))]);
      if (chunk?.value) text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    assert.match(text, /event: study\.opened/);
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

  it("gives the shared record's head as the witness, which visitors' work doesn't move", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const sent: string[] = [];
    const post = (async (_url: string, init: RequestInit) => {
      await gate;
      sent.push(init.body as string);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const { call, service } = setup({ post });
    await call("POST", "/v1/studies", "agent-token", STUDY);
    await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x", types: ["*"] });
    // While the receiver is slow, a planner writes twice, then a visitor works.
    await call("PUT", "/v1/assumptions/growth", "planner-token", { value: 1, reason: "No growth" });
    await call("PUT", "/v1/assumptions/growth", "planner-token", { value: 2, reason: "Some growth" });
    const shared = service.log.head();
    service.log.append({ actor: "guest:a", type: "activity", studyId: "lawrence", data: { kind: "message", text: "Hello" }, audience: `guest:${"a".repeat(22)}` });
    open();
    await settle();
    const heads = sent.map((body) => (JSON.parse(body) as { head: { seq: number; hash: string } }).head);
    assert.equal(heads.length, 3);
    assert.deepEqual(heads.slice(1), [shared, shared]);
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

describe("engagement", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-media-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const PLAN = { id: "plan", title: "2026 Plan", pages: [{ page: 1, text: "Service on the 52F Lawrence West would be extended to Sunnybrook Hospital." }] };
  const CITATION = { contextId: "plan", page: 1, quote: "would be extended to Sunnybrook Hospital" };
  const NEED = {
    id: "poster",
    title: "Engagement poster",
    place: "Sunnybrook Hospital",
    lon: -79.375262,
    lat: 43.722663,
    kinds: ["image", "video"],
    reason: "Riders can now ride straight to the hospital.",
    citations: [CITATION],
  };
  const ASK = "/v1/studies/lawrence/needs/poster/create";
  const CLAIM = "/v1/studies/lawrence/needs/poster/claim";
  const claim = { claim: "claim-of-the-agent-token" };

  // A study with a need in it, and a way to upload a file for the need as a form.
  async function engagement(access: AccessMode = "token") {
    const env = setup({ access, mediaDir: join(dir, "media") });
    assert.equal((await env.call("POST", "/v1/context", "integration-token", PLAN)).status, 201);
    assert.equal((await env.call("POST", "/v1/studies", "agent-token", STUDY)).status, 201);
    assert.equal((await env.call("POST", "/v1/studies/lawrence/needs", "agent-token", NEED)).status, 201);
    const upload = async (file: Uint8Array, { token = "agent-token", type = "", need = "poster", ...fields }: Record<string, string> = {}) => {
      const form = new FormData();
      const values = { ...claim, kind: "image", model: "gemini-3.1-flash-image", prompt: "A poster", inputs: JSON.stringify([{ citation: CITATION }]), ...fields };
      for (const [name, value] of Object.entries(values)) form.set(name, value);
      form.set("file", new Blob([file.slice()], { type }), "upload");
      // As a client sends it, with its length.
      const encoded = new Response(form);
      const body = new Uint8Array(await encoded.arrayBuffer());
      const headers: Record<string, string> = {
        "content-type": encoded.headers.get("content-type") as string,
        "content-length": String(body.length),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      return env.app.request(`/v1/studies/lawrence/needs/${need}/media`, { method: "POST", headers, body });
    };
    // A planner asks, and the agent takes the request on.
    const ask = async () => {
      assert.equal((await env.call("POST", ASK, "planner-token")).status, 202);
      assert.equal((await env.call("POST", CLAIM, "agent-token", claim)).status, 200);
    };
    return { ...env, upload, ask };
  }

  it("lets agents and planners propose a need, and only a planner ask for it to be made", async () => {
    const { call, service } = await engagement();
    for (const token of ["integration-token", "viewer-token"]) {
      assert.equal((await call("POST", "/v1/studies/lawrence/needs", token, { ...NEED, id: "other" })).status, 403, token);
    }
    assert.equal((await call("POST", "/v1/studies/lawrence/needs", "planner-token", { ...NEED, id: "other" })).status, 201);
    const refused = await call("POST", ASK, "agent-token");
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, "forbidden");
    const asked = await call("POST", ASK, "planner-token");
    assert.equal(asked.status, 202);
    assert.equal((await asked.json()).status, "creating");
    const head = service.log.head().seq;
    assert.equal((await call("POST", ASK, "planner-token")).status, 202);
    assert.equal(service.log.head().seq, head);
    assert.equal((await call("POST", "/v1/studies/lawrence/needs/nope/create", "planner-token")).status, 404);
  });

  it("keeps what a need's render shows, and takes a need from before subjects", async () => {
    const { call } = await engagement();
    const viaduct = { ...NEED, id: "viaduct", subject: "guideway" };
    assert.equal((await call("POST", "/v1/studies/lawrence/needs", "agent-token", viaduct)).status, 201);
    const refused = await call("POST", "/v1/studies/lawrence/needs", "agent-token", { ...NEED, id: "street-scene", subject: "people-walking" });
    assert.equal(refused.status, 400);
    const { needs } = await (await call("GET", "/v1/studies/lawrence", "viewer-token")).json();
    assert.deepEqual(
      needs.map((need: { id: string; subject?: string }) => [need.id, need.subject]),
      [
        ["poster", undefined],
        ["viaduct", "guideway"],
      ],
    );
  });

  it("lets an agent say why it made nothing, and a planner ask again", async () => {
    const { call, service } = await engagement();
    const FAILED = "/v1/studies/lawrence/needs/poster/failed";
    const failure = { reason: "image: the image model made no image: IMAGE_SAFETY", ...claim };
    assert.equal((await call("POST", FAILED, "agent-token", failure)).status, 409);
    await call("POST", ASK, "planner-token");
    const unclaimed = await call("POST", FAILED, "agent-token", failure);
    assert.equal((await unclaimed.json()).error.code, "not_claimed");
    assert.equal((await call("POST", CLAIM, "agent-token", claim)).status, 200);
    for (const token of ["viewer-token", "integration-token"]) assert.equal((await call("POST", FAILED, token, failure)).status, 403, token);
    assert.equal((await call("POST", FAILED, "agent-token", { ...claim, reason: "" })).status, 400);
    const failed = await call("POST", FAILED, "agent-token", failure);
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json().then((need) => [need.status, need.failure]), ["failed", failure.reason]);
    const study = await (await call("GET", "/v1/studies/lawrence", "viewer-token")).json();
    assert.equal(study.needs[0].status, "failed");
    const head = service.log.head().seq;
    const asked = await call("POST", ASK, "planner-token");
    assert.equal((await asked.json()).status, "creating");
    assert.equal(service.log.head().seq, head + 1);
  });

  it("takes a file as a form, and serves it to anyone with its type, lasting caching and nosniff", async () => {
    const { app, call, upload, ask } = await engagement();
    await ask();
    const response = await upload(SAMPLE.png, { type: "image/png" });
    assert.equal(response.status, 201);
    const media = await response.json();
    assert.equal(media.type, "image/png");
    assert.equal(media.label, "Illustrative");
    assert.deepEqual(media.inputs, [{ citation: CITATION }]);
    for (const headers of [{}, { authorization: "Bearer stale" }] as Record<string, string>[]) {
      const served = await app.request(media.url, { headers });
      assert.equal(served.status, 200);
      assert.equal(served.headers.get("content-type"), "image/png");
      assert.equal(served.headers.get("cache-control"), "public, no-cache");
      assert.equal(served.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(new Uint8Array(await served.arrayBuffer()), SAMPLE.png);
    }
    // The need asks for a video too, so it is still being made.
    const study = await (await call("GET", "/v1/studies/lawrence", "viewer-token")).json();
    assert.equal(study.needs[0].status, "creating");
    assert.deepEqual(study.needs[0].media, [media]);
    // A file can say what it shows, for people who can't see it.
    assert.equal(media.alt, undefined);
    const described = await (await upload(SAMPLE.mp4, { kind: "video", alt: "A bus pulls in at a hospital entrance." })).json();
    assert.equal(described.alt, "A bus pulls in at a hospital entrance.");
  });

  it("lets a browser keep, play and seek a video", async () => {
    const { app, upload, ask } = await engagement();
    await ask();
    const video = await (await upload(SAMPLE.mp4, { kind: "video", type: "video/mp4" })).json();
    const get = (headers: Record<string, string>) => app.request(video.url, { headers });
    const part = await get({ range: "bytes=4-11" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 4-11/${SAMPLE.mp4.length}`);
    assert.equal(part.headers.get("accept-ranges"), "bytes");
    assert.equal(new TextDecoder().decode(await part.arrayBuffer()), "ftypisom");
    const past = await get({ range: `bytes=${SAMPLE.mp4.length}-` });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${SAMPLE.mp4.length}`);
    assert.equal((await get({ "if-none-match": `"${video.id}"` })).status, 304);
    const head = await app.request(video.url, { method: "HEAD", headers: { "idempotency-key": "k1" } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "video/mp4");
    assert.equal(head.headers.get("content-length"), String(SAMPLE.mp4.length));
  });

  it("refuses a file that isn't PNG, JPEG, WebP or MP4, whatever the upload says it is", async () => {
    const { service, upload, ask } = await engagement();
    await ask();
    for (const [file, type] of [[SAMPLE.svg, "image/svg+xml"], [SAMPLE.html, "image/png"], [SAMPLE.gif, "image/gif"], [SAMPLE.heic, ""]] as const) {
      const response = await upload(file, { type });
      assert.equal(response.status, 415, type);
      assert.equal((await response.json()).error.code, "unsupported_media", type);
    }
    const mislabelled = await upload(SAMPLE.jpeg, { type: "image/png" });
    assert.equal(mislabelled.status, 415);
    assert.equal((await mislabelled.json()).error.code, "type_mismatch");
    assert.equal(service.state.media.size, 0);
    assert.deepEqual(readdirSync(join(dir, "media")), []);
  });

  it("refuses a file over its kind's limit, and gives only media uploads more room", async () => {
    const { call, upload, ask } = await engagement();
    await ask();
    const image = await upload(padded(SAMPLE.png, 10 * 1024 * 1024 + 1));
    assert.equal(image.status, 413);
    assert.match((await image.json()).error.message, /over 10 MB/);
    const video = await upload(padded(SAMPLE.mp4, 40 * 1024 * 1024 + 1), { kind: "video" });
    assert.equal(video.status, 413);
    assert.match((await video.json()).error.message, /over 40 MB/);
    assert.equal((await upload(padded(SAMPLE.mp4, 42 * 1024 * 1024), { kind: "video" })).status, 413);
    assert.equal((await upload(padded(SAMPLE.png, 2 * 1024 * 1024))).status, 201);
    const need = await call("POST", "/v1/studies/lawrence/needs", "agent-token", { ...NEED, id: "long", reason: "a".repeat(2 * 1024 * 1024) });
    assert.equal(need.status, 413);
    assert.equal((await upload(padded(SAMPLE.png, 2 * 1024 * 1024), { token: "viewer-token" })).status, 413);
  });

  it("lets one agent take on a request, and no planner", async () => {
    const { call } = await engagement();
    assert.equal((await call("POST", CLAIM, "agent-token", claim)).status, 409);
    await call("POST", ASK, "planner-token");
    for (const token of ["planner-token", "viewer-token", "integration-token"]) assert.equal((await call("POST", CLAIM, token, claim)).status, 403, token);
    assert.equal((await call("POST", CLAIM, "agent-token", { claim: "short" })).status, 400);
    const claimed = await call("POST", CLAIM, "agent-token", claim);
    assert.equal(claimed.status, 200);
    assert.deepEqual(await claimed.json().then((need) => [need.status, need.claimedBy]), ["creating", "agent:lead"]);
    const taken = await call("POST", CLAIM, "agent-token", { claim: "claim-of-another-process" });
    assert.equal(taken.status, 409);
    assert.equal((await taken.json()).error.code, "claimed");
  });

  it("lets an agent attach one file of each kind", async () => {
    const { upload, ask } = await engagement();
    await ask();
    assert.equal((await upload(SAMPLE.png)).status, 201);
    const again = await upload(SAMPLE.jpeg);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, "already_made");
  });

  it("needs an agent's token to upload", async () => {
    const { upload, ask } = await engagement("demo");
    await ask();
    const anonymous = await upload(SAMPLE.png, { token: "" });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, "token_required");
    assert.equal((await upload(SAMPLE.png, { token: "viewer-token" })).status, 403);
    assert.equal((await upload(SAMPLE.png, { token: "integration-token" })).status, 403);
    assert.equal((await upload(SAMPLE.png, { token: "planner-token" })).status, 403);
    assert.equal((await upload(SAMPLE.png)).status, 201);
  });

  it("credits the site photos a file was made with, linking only to a page on the web", async () => {
    const { call, upload, ask } = await engagement();
    await ask();
    const photo = {
      file: "thorncliffe-park-aerial.jpg",
      credit: "Thorncliffe Park in 2023, by Canmenwalker, CC BY 4.0, via Wikimedia Commons",
      licence: "CC BY 4.0",
      source: "https://commons.wikimedia.org/wiki/File:Thorncliffe_Park_in_2023.jpg",
    };
    for (const source of ["javascript:alert(1)", "http://commons.wikimedia.org/wiki/File:Thorncliffe_Park_in_2023.jpg", "https://localhost/photo.jpg"]) {
      const refused = await upload(SAMPLE.png, { inputs: JSON.stringify([{ photo: { ...photo, source } }]) });
      assert.equal((await refused.json()).error.code, "invalid_body", source);
    }
    const media = await (await upload(SAMPLE.png, { inputs: JSON.stringify([{ citation: CITATION }, { photo }]) })).json();
    assert.deepEqual(media.inputs, [{ citation: CITATION }, { photo }]);
    const study = await (await call("GET", "/v1/studies/lawrence", "viewer-token")).json();
    assert.deepEqual(study.needs[0].media[0].inputs, [{ citation: CITATION }, { photo }]);
  });

  it("says what's wrong with an upload it can't use", async () => {
    const { app, call, upload, ask } = await engagement();
    const code = async (response: Response | Promise<Response>) => (await (await response).json()).error.code;
    assert.equal(await code(upload(SAMPLE.png)), "not_requested");
    await ask();
    assert.equal(await code(upload(SAMPLE.png, { claim: "claim-of-somebody-else" })), "not_claimed");
    assert.equal(await code(call("POST", "/v1/studies/lawrence/needs/poster/media", "agent-token", { kind: "image" })), "invalid_body");
    assert.equal(await code(upload(SAMPLE.png, { inputs: "[{" })), "invalid_body");
    assert.equal(await code(upload(SAMPLE.png, { kind: "poster" })), "invalid_body");
    assert.equal(await code(upload(SAMPLE.png, { need: "nope" })), "not_found");
    assert.equal(await code(upload(SAMPLE.png, { inputs: JSON.stringify([{ figure: "nope" }]) })), "unknown_input");
    const form = new FormData();
    form.set("kind", "image");
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    const headers = { authorization: "Bearer agent-token", "content-type": encoded.headers.get("content-type") as string, "content-length": String(body.length) };
    const noFile = await app.request("/v1/studies/lawrence/needs/poster/media", { method: "POST", headers, body });
    assert.equal(await code(noFile), "invalid_body");
  });

  it("lets only a planner take a file down or drop a need", async () => {
    const { app, call, upload, ask } = await engagement();
    await ask();
    const image = await (await upload(SAMPLE.png)).json();
    const reason = { reason: "Shows a route number the plan never gives" };
    const WITHDRAW = `/v1/studies/lawrence/needs/poster/media/${image.id}/withdraw`;
    for (const token of ["agent-token", "viewer-token", "integration-token"]) assert.equal((await call("POST", WITHDRAW, token, reason)).status, 403, token);
    const withdrawn = await call("POST", WITHDRAW, "planner-token", reason);
    assert.equal(withdrawn.status, 200);
    assert.deepEqual((await withdrawn.json()).media, []);
    assert.equal((await app.request(image.url)).status, 404);
    const DISMISS = "/v1/studies/lawrence/needs/poster/dismiss";
    assert.equal((await call("POST", DISMISS, "agent-token", reason)).status, 403);
    assert.deepEqual(await (await call("POST", DISMISS, "planner-token", reason)).json(), { dismissed: "poster" });
    assert.deepEqual((await (await call("GET", "/v1/studies/lawrence", "viewer-token")).json()).needs, []);
  });

  it("refuses an upload before reading it, unless it's asked for and claimed", async () => {
    const { app, call, upload, ask } = await engagement();
    // A body that never ends: answered at once means it was never read.
    const endless = (token = "agent-token", need = "poster") =>
      app.request(`/v1/studies/lawrence/needs/${need}/media`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=x" },
        body: new ReadableStream({ pull: () => new Promise(() => {}) }),
        duplex: "half",
      } as RequestInit);
    const code = async (response: Response | Promise<Response>) => (await (await response).json()).error.code;
    assert.equal(await code(endless("agent-token", "nope")), "not_found");
    assert.equal(await code(endless()), "not_requested");
    await call("POST", ASK, "planner-token");
    assert.equal(await code(endless()), "not_claimed");
    await ask();
    assert.equal((await upload(SAMPLE.mp4, { kind: "video" })).status, 201);
    const sized = (bytes: number) =>
      app.request("/v1/studies/lawrence/needs/poster/media", {
        method: "POST",
        headers: { authorization: "Bearer agent-token", "content-type": "multipart/form-data; boundary=x", "content-length": String(bytes) },
        body: new ReadableStream({ pull: () => new Promise(() => {}) }),
        duplex: "half",
      } as RequestInit);
    // The need lacks only its image now, so it gets an image's room.
    assert.equal(await code(sized(20 * 1024 * 1024)), "too_large");
    assert.equal(await code(endless()), "length_required");
  });

  it("reads only two uploads at once", async () => {
    const { app, upload, ask } = await engagement();
    await ask();
    const held: ReadableStreamDefaultController[] = [];
    const slow = () =>
      app.request("/v1/studies/lawrence/needs/poster/media", {
        method: "POST",
        headers: { authorization: "Bearer agent-token", "content-type": "multipart/form-data; boundary=x", "content-length": "100" },
        body: new ReadableStream({ start: (controller) => void held.push(controller) }),
        duplex: "half",
      } as RequestInit);
    const reading = [slow(), slow()];
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await upload(SAMPLE.png);
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error.code, "busy");
    for (const controller of held) controller.close();
    for (const response of await Promise.all(reading)) assert.equal(response.status, 400);
    assert.equal((await upload(SAMPLE.png)).status, 201);
  });

  it("refuses a file with anything after its end, and names a saved file for its need, as illustrative", async () => {
    const { app, upload, ask } = await engagement();
    await ask();
    const tail = (file: Uint8Array) => new Uint8Array([...file, ...Buffer.from("<html><script>alert(1)</script>")]);
    for (const [file, kind] of [[SAMPLE.png, "image"], [SAMPLE.jpeg, "image"], [SAMPLE.webp, "image"], [SAMPLE.mp4, "video"]] as const) {
      const response = await upload(tail(file), { kind });
      assert.equal(response.status, 422, kind);
      assert.equal((await response.json()).error.code, "malformed_media");
    }
    const media = await (await upload(SAMPLE.jpeg)).json();
    const served = await app.request(media.url);
    assert.equal(served.headers.get("content-disposition"), 'inline; filename="poster-illustrative.jpg"');
  });

  it("never serves a file the log doesn't name", async () => {
    const { app } = await engagement();
    for (const id of ["f".repeat(64), "..%2F..%2Fpackage.json", "log.db"]) {
      const response = await app.request(`/v1/media/${id}`);
      assert.equal(response.status, 404, id);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  });

  it("documents the upload as a form, and media as needing no token", async () => {
    const { app } = await engagement();
    const spec = await (await app.request("/openapi.json")).json();
    const upload = spec.paths["/v1/studies/{id}/needs/{need}/media"].post;
    assert.deepEqual(upload["x-roles"], ["agent"]);
    const form = upload.requestBody.content["multipart/form-data"];
    assert.deepEqual(form.schema.properties.file, { type: "string", format: "binary" });
    assert.deepEqual(form.schema.required, ["claim", "kind", "model", "prompt", "file"]);
    assert.deepEqual(form.encoding, { inputs: { contentType: "application/json" } });
    assert.deepEqual(spec.paths["/v1/media/{id}"].get.security, []);
    assert.deepEqual(spec.paths["/v1/studies/{id}/needs/{need}/create"].post["x-roles"], ["planner", "guest"]);
    assert.deepEqual(spec.paths["/v1/studies/{id}/needs/{need}/claim"].post["x-roles"], ["agent"]);
    assert.deepEqual(spec.paths["/v1/studies/{id}/needs/{need}/failed"].post["x-roles"], ["agent"]);
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

  it("serves the app's manifest, icons and page images as what they are", async () => {
    mkdirSync(join(dir, "site/icons"));
    mkdirSync(join(dir, "site/sources"));
    writeFileSync(join(dir, "site/manifest.webmanifest"), "{}");
    writeFileSync(join(dir, "site/icons/icon-192.png"), "png");
    writeFileSync(join(dir, "site/sources/p1.webp"), "webp");
    const { app } = setup({ staticDir: join(dir, "site") });
    const type = async (path: string) => (await app.request(path)).headers.get("content-type");
    assert.equal(await type("/manifest.webmanifest"), "application/manifest+json");
    assert.equal(await type("/icons/icon-192.png"), "image/png");
    assert.equal(await type("/sources/p1.webp"), "image/webp");
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

describe("visitors", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-visitors-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const PLAN = {
    id: "plan",
    title: "2026 Plan",
    pages: [{ page: 1, text: "Service on the 52F Lawrence West would be extended to Sunnybrook Hospital, adding 1,680 weekly riders." }],
  };
  const CITATION = { contextId: "plan", page: 1, quote: "adding 1,680 weekly riders" };
  const FIGURE = { id: "riders", label: "Weekly riders", value: 1680, basis: { kind: "cited", citation: CITATION } };
  const NEED = {
    id: "poster",
    title: "Engagement poster",
    place: "Sunnybrook Hospital",
    lon: -79.375262,
    lat: 43.722663,
    kinds: ["image"],
    reason: "Riders can now ride straight to the hospital.",
    citations: [CITATION],
  };
  const FINDING = { id: "survey", label: "Survey", text: "Riders asked for it.", tone: "positive", citation: CITATION };
  const MESSAGE = { kind: "message", text: "Will this help?" };

  // A shared study with something of each kind, and two visitors' passes.
  async function visitors(options: Setup = {}) {
    const env = setup({ access: "demo", guests: true, mediaDir: join(dir, "media"), ...options });
    const { call } = env;
    const ok = async (response: Response | Promise<Response>) => assert.ok((await response).ok);
    await ok(call("POST", "/v1/context", "integration-token", PLAN));
    await ok(call("POST", "/v1/studies", "agent-token", STUDY));
    await ok(call("PUT", "/v1/assumptions/min-riders", "planner-token", { value: 1000, reason: "The service standard" }));
    await ok(call("POST", "/v1/studies/lawrence/figures", "agent-token", FIGURE));
    await ok(call("POST", "/v1/studies/lawrence/checks", "agent-token", { id: "enough", label: "Enough riders", figure: "riders", op: ">=", threshold: { assumption: "min-riders" } }));
    await ok(call("POST", "/v1/studies/lawrence/findings", "agent-token", FINDING));
    await ok(call("POST", "/v1/studies/lawrence/needs", "agent-token", NEED));
    const pass = async () => (await (await call("POST", "/v1/guests")).json()).token as string;
    const a = await pass();
    const b = await pass();
    const audience = (token: string) => `guest:${token.split(".")[1]}`;
    // The lead agent, acting for a visitor.
    const forVisitor = (token: string) => ({ "x-on-behalf-of": audience(token) });
    // The media agent, acting for whoever the headers name: it takes the request on, then
    // sends the file with its claim and its length, as a client does.
    const upload = async (headers: Record<string, string>) => {
      const claim = "claim-of-the-agent-token";
      assert.equal((await call("POST", "/v1/studies/lawrence/needs/poster/claim", "agent-token", { claim }, headers)).status, 200);
      const form = new FormData();
      const fields = { claim, kind: "image", model: "gemini-3.1-flash-image", prompt: "A poster", inputs: JSON.stringify([{ citation: CITATION }]) };
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      form.set("file", new Blob([SAMPLE.png.slice()], { type: "image/png" }), "poster.png");
      const encoded = new Response(form);
      const body = new Uint8Array(await encoded.arrayBuffer());
      const sent = { "content-type": encoded.headers.get("content-type") as string, "content-length": String(body.length) };
      return env.app.request("/v1/studies/lawrence/needs/poster/media", { method: "POST", headers: { authorization: "Bearer agent-token", ...sent, ...headers }, body });
    };
    return { ...env, a, b, audience, forVisitor, upload };
  }

  // A tool call over MCP, as JSON-RPC, with what came back.
  const tool = async (env: { app: { request: (path: string, init: RequestInit) => Response | Promise<Response> } }, token: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await env.app.request("/v1/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: result.content[0]?.text ?? "", isError: result.isError === true };
  };

  it("lets a visitor do what a planner does, but decide, in a sandbox nobody else sees", async () => {
    const { call, service, a, b, audience } = await visitors();
    const shared = structuredClone(service.state);
    const writes = {
      message: await call("POST", "/v1/studies/lawrence/activity", a, MESSAGE),
      rating: await call("PUT", "/v1/studies/lawrence/findings/survey/tone", a, { tone: "negative" }),
      accept: await call("POST", "/v1/studies/lawrence/figures/riders/accept", a),
      assumption: await call("PUT", "/v1/assumptions/min-riders", a, { value: 2000, reason: "A visitor's stricter bar" }),
      create: await call("POST", "/v1/studies/lawrence/needs/poster/create", a),
      preview: await call("POST", "/v1/studies/lawrence/preview", a, { assumptions: { "min-riders": 3000 } }),
    };
    for (const [write, response] of Object.entries(writes)) assert.ok(response.ok, `${write}: ${response.status}`);
    assert.deepEqual(service.state, shared);

    const study = async (token?: string) => (await call("GET", "/v1/studies/lawrence", token)).json();
    const mine = await study(a);
    assert.equal(mine.findings[0].tone, "negative");
    assert.equal(mine.checks[0].status, "fail");
    assert.equal(mine.needs[0].status, "creating");
    for (const other of [b, "planner-token", undefined]) {
      const theirs = await study(other);
      assert.equal(theirs.findings[0].tone, "unrated");
      assert.equal(theirs.checks[0].status, "pass");
      assert.equal(theirs.needs[0].status, "needed");
    }
    const log = async (token?: string) => (await call("GET", "/v1/log?limit=1000", token)).json() as Promise<{ audience?: string | null; actor: string }[]>;
    // Accepting a figure already accepted writes nothing.
    assert.equal((await log(a)).filter((entry) => entry.audience === audience(a)).length, 4);
    for (const other of [b, "planner-token", "agent-token", undefined]) {
      const entries = await log(other);
      assert.equal(entries.filter((entry) => entry.audience).length, 0);
      assert.ok(!entries.some((entry) => entry.actor === audience(a)));
    }
  });

  it("refuses a visitor's decision, over REST and MCP, and writes nothing", async () => {
    const env = await visitors();
    const head = env.service.log.head();
    const response = await env.call("POST", "/v1/studies/lawrence/decisions", env.a, DECISION);
    assert.equal(response.status, 403);
    assert.deepEqual((await response.json()).error, { code: "sign_in_required", message: SIGN_IN_TO_DECIDE });
    const result = await tool(env, env.a, "record_decision", { studyId: "lawrence", ...DECISION });
    assert.equal(result.isError, true);
    assert.equal(result.text, `403 sign_in_required: ${SIGN_IN_TO_DECIDE}`);
    assert.deepEqual(env.service.log.head(), head);
    // Without a token, a decision still needs one.
    assert.equal((await env.call("POST", "/v1/studies/lawrence/decisions", undefined, DECISION)).status, 401);
  });

  it("lets a visitor only chat, of the activity kinds, and not do an agent's or a planner's other work", async () => {
    const { app, call, service, a } = await visitors({ limits: new VisitorLimits({ perMinute: 100 }) });
    const head = service.log.head();
    const refused = {
      usage: await call("POST", "/v1/studies/lawrence/activity", a, { kind: "usage", model: "gemini", inputTokens: 1, outputTokens: 1, costUsd: 9 }),
      reading: await call("POST", "/v1/studies/lawrence/activity", a, { kind: "reading", contextId: "plan" }),
      "run.started": await call("POST", "/v1/studies/lawrence/activity", a, { kind: "run.started" }),
      context: await call("POST", "/v1/context", a, { title: "Mine", text: "words" }),
      study: await call("POST", "/v1/studies", a, { id: "mine", title: "Mine" }),
      figure: await call("POST", "/v1/studies/lawrence/figures", a, { ...FIGURE, id: "mine" }),
      check: await call("POST", "/v1/studies/lawrence/checks", a, { id: "mine", label: "Mine", figure: "riders", op: ">=", threshold: { assumption: "min-riders" } }),
      finding: await call("POST", "/v1/studies/lawrence/findings", a, { ...FINDING, id: "mine" }),
      need: await call("POST", "/v1/studies/lawrence/needs", a, { ...NEED, id: "mine" }),
      claim: await call("POST", "/v1/studies/lawrence/needs/poster/claim", a, { claim: "claim-of-a-visitor-0001" }),
      failed: await call("POST", "/v1/studies/lawrence/needs/poster/failed", a, { reason: "Nothing made", claim: "claim-of-a-visitor-0001" }),
      upload: await app.request("/v1/studies/lawrence/needs/poster/media", { method: "POST", headers: { authorization: `Bearer ${a}` }, body: new FormData() }),
      dismiss: await call("POST", "/v1/studies/lawrence/needs/poster/dismiss", a, { reason: "Not wanted" }),
      withdraw: await call("POST", `/v1/studies/lawrence/needs/poster/media/${"0".repeat(64)}/withdraw`, a, { reason: "Not wanted" }),
      skill: await call("PUT", "/v1/skills/r5", a, { version: HASH_A }),
      revoke: await call("POST", "/v1/skills/r5/revoke", a, { reason: "Not wanted" }),
      subscription: await call("POST", "/v1/subscriptions", a, { url: "https://hook.test/x" }),
      removal: await call("POST", `/v1/log/${head.seq}/remove-content`, a, { reason: "Privacy request" }),
    };
    for (const [write, response] of Object.entries(refused)) {
      assert.equal(response.status, 403, write);
      assert.deepEqual((await response.json()).error, { code: "sign_in_required", message: "Sign in as a planner to do this." }, write);
    }
    assert.deepEqual(service.log.head(), head);
  });

  it("lets only the service's own static agents act for a visitor", async () => {
    const people: Record<string, Verified> = { "auth0-agent": { role: "agent", name: "bot", subject: "auth0|bot" } };
    const { call, service, a, audience, forVisitor } = await visitors({ verifyToken: async (token) => people[token] });
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "For A" }, forVisitor(a))).status, 201);
    const head = service.log.head();
    for (const token of [a, "planner-token", "auth0-agent", "replay-token", "integration-token", "viewer-token", undefined]) {
      for (const [method, path] of [["GET", "/v1/log"], ["GET", "/v1/studies/lawrence"], ["POST", "/v1/studies/lawrence/activity"]]) {
        const response = await call(method as string, path as string, token, method === "POST" ? MESSAGE : undefined, forVisitor(a));
        assert.equal(response.status, 403, `${token} ${method} ${path}`);
        assert.equal((await response.json()).error.code, "forbidden");
      }
    }
    for (const value of ["", "guest:short", `user:${"x".repeat(23)}`, `planner:${"x".repeat(22)}`, "guest:*", "*,guest:x"]) {
      const response = await call("GET", "/v1/log", "agent-token", undefined, { "x-on-behalf-of": value });
      assert.equal(response.status, 400, value);
      assert.equal((await response.json()).error.code, "bad_audience", value);
    }
    // Everyone, only to read the log.
    const everyone = { "x-on-behalf-of": "*" };
    for (const [method, path, body] of [
      ["POST", "/v1/studies/lawrence/activity", MESSAGE],
      ["POST", "/v1/studies/lawrence/figures", { ...FIGURE, id: "all" }],
      ["PUT", "/v1/assumptions/min-riders", { value: 1, reason: "For everyone" }],
      ["POST", "/v1/studies/lawrence/preview", {}],
    ] as const) {
      const response = await call(method, path, "agent-token", body, everyone);
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, "read_only", path);
    }
    assert.deepEqual(service.log.head(), head);
    const read = async (path: string, headers: Record<string, string> = {}) => (await call("GET", path, "agent-token", undefined, headers)).text();
    assert.match(await read("/v1/log?limit=1000", everyone), /For A/);
    assert.doesNotMatch(await read("/v1/log?limit=1000"), /For A/);
    assert.match(await read("/v1/log?limit=1000", forVisitor(a)), /For A/);
    assert.equal(JSON.parse(await read("/v1/log?limit=1000", everyone)).at(-1).audience, audience(a));
    for (const path of ["/v1/studies", "/v1/studies/lawrence", "/v1/usage", "/v1/assumptions"]) {
      assert.equal(await read(path, everyone), await read(path), path);
    }
  });

  it("writes what an agent does for a visitor into that visitor's sandbox, and keeps sources and studies shared", async () => {
    const { call, service, a, b, audience, forVisitor, upload } = await visitors();
    assert.equal((await call("POST", "/v1/studies/lawrence/figures", "agent-token", { ...FIGURE, id: "theirs", label: "Their riders" }, forVisitor(a))).status, 201);
    assert.equal((await call("POST", "/v1/studies/lawrence/needs/poster/create", a)).status, 202);
    const made = await upload(forVisitor(a));
    assert.equal(made.status, 201);
    const media = await made.json();
    const served = await call("GET", media.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("cache-control"), "private, no-cache");
    // The claim and the file are A's: everyone else sees the need as nobody asked for it.
    const poster = async (token: string) => ((await (await call("GET", "/v1/studies/lawrence", token)).json()).needs as NeedView[])[0];
    const mine = await poster(a);
    assert.deepEqual([mine?.status, mine?.claimedBy, mine?.media.map((m) => m.id)], ["ready", "agent:lead", [media.id]]);
    for (const other of [b, "planner-token"]) {
      const theirs = await poster(other);
      assert.deepEqual([theirs?.status, theirs?.claimedBy, theirs?.media], ["needed", undefined, []], other);
    }
    // An agent acting for B can't take A's request on.
    const taken = await call("POST", "/v1/studies/lawrence/needs/poster/claim", "agent-token", { claim: "claim-of-the-agent-for-b" }, forVisitor(b));
    assert.equal((await taken.json()).error.code, "not_requested");
    const figures = async (token: string) => ((await (await call("GET", "/v1/studies/lawrence", token)).json()).figures as { id: string }[]).map((f) => f.id);
    assert.deepEqual(await figures(a), ["riders", "theirs"]);
    assert.deepEqual(await figures(b), ["riders"]);
    assert.deepEqual(await figures("planner-token"), ["riders"]);
    assert.equal(service.log.since(0, 1000, audience(a)).at(-1)?.audience, audience(a));
    for (const [method, path, body] of [
      ["POST", "/v1/studies", { id: "theirs", title: "Theirs" }],
      ["POST", "/v1/context", { title: "Theirs", text: "words" }],
    ] as const) {
      const response = await call(method, path, "agent-token", body, forVisitor(a));
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, "shared_only", path);
    }
  });

  it("makes someone signed in who isn't a planner a visitor, with a sandbox of their own", async () => {
    const people: Record<string, Verified> = {
      kim: { role: "viewer", name: "kim", subject: "auth0|kim" },
      ana: { role: "planner", name: "ana-ruiz", subject: "auth0|ana" },
    };
    const verifyToken = async (token: string) => people[token];
    const { call, service } = await visitors({ verifyToken });
    const audience = userAudience(GUEST_SECRET, "auth0|kim");
    assert.deepEqual(await (await call("GET", "/v1/me", "kim")).json(), { role: "guest", name: audience.slice("user:".length) });
    assert.deepEqual(await (await call("GET", "/v1/me", "ana")).json(), { role: "planner", name: "ana-ruiz" });
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", "kim", MESSAGE)).status, 201);
    const entry = service.log.since(0, 1000, audience).at(-1);
    assert.equal(entry?.audience, audience);
    assert.equal(entry?.actor, `guest:${audience.slice("user:".length)}`);
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", "kim", DECISION)).status, 403);
    // With guests off, they stay a viewer.
    const off = setup({ access: "demo", verifyToken });
    assert.deepEqual(await (await off.call("GET", "/v1/me", "kim")).json(), { role: "viewer", name: "kim" });
  });

  it("keeps what someone signed in does in their sandbox from being guessed from the chain by someone who knows who they are", async () => {
    const verifyToken = async (token: string): Promise<Verified | undefined> =>
      token === "kim" ? { role: "viewer", name: "kim", subject: "auth0|kim" } : undefined;
    const { call, b } = await visitors({ verifyToken });
    type Shared = { seq: number; at: string; hash: string; prevHash: string };
    await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "Shared before" });
    const previous = ((await (await call("GET", "/v1/log?limit=1000", b)).json()) as Shared[]).at(-1) as Shared;
    assert.equal((await call("PUT", "/v1/studies/lawrence/findings/survey/tone", "kim", { tone: "negative" })).status, 200);
    await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "Shared after" });
    const [next] = (await (await call("GET", `/v1/log?after=${previous.seq}`, b)).json()) as Shared[];
    assert.equal(next?.seq, previous.seq + 2);
    // Visitor B knows Kim's subject, and tries each tone at each millisecond between
    // the shared entries on either side of Kim's rating.
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    const guess = (audience: string) => {
      const seq = previous.seq + 1;
      for (let at = Date.parse(previous.at); at <= Date.parse(next?.at ?? ""); at += 1) {
        for (const tone of ["positive", "mixed", "negative", "neutral"]) {
          const payloadHash = sha256(`${seq}:${JSON.stringify({ finding: "survey", tone })}`);
          const fields = [seq, new Date(at).toISOString(), `guest:${audience.slice("user:".length)}`, "finding.rated", "lawrence", payloadHash, previous.hash, audience];
          if (sha256(JSON.stringify(fields)) === next?.prevHash) return tone;
        }
      }
      return undefined;
    };
    assert.equal(guess(`user:${createHash("sha256").update("auth0|kim").digest("base64url").slice(0, 22)}`), undefined);
    // The same search finds it only with the secret.
    assert.equal(guess(userAudience(GUEST_SECRET, "auth0|kim")), "negative");
  });

  it("lets a planner remove what a visitor wrote only given their audience, and answers otherwise as for a made-up position", async () => {
    const { call, service, a, b, audience } = await visitors();
    const { seq } = await (await call("POST", "/v1/studies/lawrence/activity", a, { kind: "message", text: "Call me on 416-555-0100" })).json();
    const remove = (at: number, body: Record<string, unknown> = {}) =>
      call("POST", `/v1/log/${at}/remove-content`, "planner-token", { reason: "Personal data", ...body });
    const nobody = await remove(seq + 1000);
    const asNobody = { status: nobody.status, body: (await nobody.text()).replaceAll(String(seq + 1000), String(seq)) };
    assert.equal(asNobody.status, 404);
    for (const body of [{}, { audience: audience(b) }]) {
      const response = await remove(seq, body);
      assert.deepEqual({ status: response.status, body: await response.text() }, asNobody);
    }
    assert.equal((await remove(seq, { audience: audience(a) })).status, 201);
    const log = async (token: string) => JSON.stringify(await (await call("GET", "/v1/log?limit=1000", token)).json());
    assert.equal((await log(a)).includes("416-555-0100"), false);
    assert.ok((await log(a)).includes("content.removed"));
    for (const token of [b, "planner-token"]) assert.equal((await log(token)).includes("content.removed"), false);
    assert.equal(service.log.verify().ok, true);
  });

  it("keeps no idempotency record for a visitor, and an agent's apart for each visitor", async () => {
    const { call, service, a, b, forVisitor } = await visitors();
    const key = { "idempotency-key": "k1" };
    for (let i = 0; i < 2; i += 1) {
      const response = await call("POST", "/v1/studies/lawrence/activity", a, MESSAGE, key);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("idempotent-replay"), null);
    }
    assert.equal((service.log.db.prepare("SELECT count(*) AS n FROM idempotency").get() as { n: number }).n, 0);
    const forA = await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "For A" }, { ...key, ...forVisitor(a) });
    const forB = await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "For B" }, { ...key, ...forVisitor(b) });
    assert.equal(forB.headers.get("idempotent-replay"), null);
    assert.notDeepEqual(await forB.json(), await forA.json());
    const again = await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "For A" }, { ...key, ...forVisitor(a) });
    assert.equal(again.headers.get("idempotent-replay"), "true");
  });

  it("returns at most 1000 log entries, whatever the limit asks", async () => {
    const { call, service } = setup({ access: "demo" });
    for (let i = 0; i < 1005; i += 1) service.log.append({ actor: "agent:lead", type: "note", data: { i } });
    const count = async (query: string) => ((await (await call("GET", `/v1/log${query}`)).json()) as unknown[]).length;
    assert.equal(await count("?limit=-1"), 1);
    assert.equal(await count("?limit=5000"), 1000);
    assert.equal(await count("?limit=0"), 1);
    assert.equal(await count("?limit=abc"), 200);
    assert.equal(await count(""), 200);
    assert.equal(await count("?after=-5&limit=3"), 3);
    assert.equal(await count("?after=1000&limit=1000"), 5);
  });

  it("limits how often a visitor writes, and not how often they read or preview", async () => {
    const { call, service, a, b } = await visitors();
    for (let i = 0; i < 10; i += 1) assert.equal((await call("POST", "/v1/studies/lawrence/activity", a, MESSAGE)).status, 201, String(i));
    const head = service.log.head();
    const eleventh = await call("POST", "/v1/studies/lawrence/activity", a, MESSAGE);
    assert.equal(eleventh.status, 429);
    assert.deepEqual((await eleventh.json()).error, { code: "rate_limited", message: RATE_LIMITED });
    assert.equal((await call("PUT", "/v1/assumptions/min-riders", a, { value: 1, reason: "One more" })).status, 429);
    assert.deepEqual(service.log.head(), head);
    assert.equal((await call("GET", "/v1/studies/lawrence", a)).status, 200);
    assert.equal((await call("POST", "/v1/studies/lawrence/preview", a, {})).status, 200);
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", b, MESSAGE)).status, 201);
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", "planner-token", MESSAGE)).status, 201);
  });

  it("holds visitors to the daily budget at the door, and never planners", async () => {
    const budget = new VisitorBudget({ capUsd: 1, marginUsd: 0.2, shareUsd: 0.5 });
    const { call, service, a, b, forVisitor } = await visitors({ budget });
    const usage = (costUsd: number) => ({ kind: "usage", model: "gemini-3-flash", inputTokens: 100, outputTokens: 10, costUsd });
    assert.deepEqual(await (await call("GET", "/v1/budget", a)).json(), { capped: true, capUsd: 1, leftUsd: 0.5 });
    assert.deepEqual(await (await call("GET", "/v1/budget", "planner-token")).json(), { capped: false });
    assert.deepEqual(await (await call("GET", "/v1/budget", "agent-token", undefined, forVisitor(b))).json(), { capped: true, capUsd: 1, leftUsd: 0.5 });

    // A usage report made for a visitor says what is left; a planner's doesn't.
    const reported = await call("POST", "/v1/studies/lawrence/activity", "agent-token", usage(0.45), forVisitor(a));
    assert.equal(reported.status, 201);
    const { budgetLeftUsd } = await reported.json();
    assert.ok(Math.abs(budgetLeftUsd - 0.05) < 1e-9, String(budgetLeftUsd));
    assert.deepEqual(Object.keys(await (await call("POST", "/v1/studies/lawrence/activity", "agent-token", usage(5))).json()), ["seq"]);
    assert.deepEqual(Object.keys(await (await call("POST", "/v1/studies/lawrence/activity", "planner-token", usage(5))).json()), ["seq"]);

    // A has too little left for a message or media. B, with the day's budget, has room.
    const head = service.log.head();
    for (const response of [
      await call("POST", "/v1/studies/lawrence/activity", a, MESSAGE),
      await call("POST", "/v1/studies/lawrence/needs/poster/create", a),
    ]) {
      assert.equal(response.status, 429);
      assert.deepEqual((await response.json()).error, { code: "budget_spent", message: BUDGET_SPENT });
    }
    assert.deepEqual(service.log.head(), head);
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", b, MESSAGE)).status, 201);

    // Once the day's budget is spent, no visitor has room, and planners still do.
    await call("POST", "/v1/studies/lawrence/activity", "agent-token", usage(0.4), forVisitor(b));
    const spent = service.log.head();
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", b, MESSAGE)).status, 429);
    assert.equal((await call("POST", "/v1/studies/lawrence/needs/poster/create", b)).status, 429);
    assert.deepEqual(await (await call("GET", "/v1/budget", b)).json(), { capped: true, capUsd: 1, leftUsd: 0 });
    assert.deepEqual(service.log.head(), spent);
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", "planner-token", MESSAGE)).status, 201);
    assert.equal((await call("POST", "/v1/studies/lawrence/needs/poster/create", "planner-token")).status, 202);
    // An agent can still tell a visitor why it stopped.
    assert.equal((await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: BUDGET_SPENT }, forVisitor(b))).status, 201);
  });

  it("streams a visitor's entries only to that visitor", async () => {
    const { app, call, a, b } = await visitors();
    const read = async (token: string) => {
      const controller = new AbortController();
      const response = await app.request(`/v1/events?types=activity&access_token=${encodeURIComponent(token)}`, { signal: controller.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let text = "";
      while (!text.includes("Shared after")) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return text;
    };
    await call("POST", "/v1/studies/lawrence/activity", a, { kind: "message", text: "Replayed for A" });
    const [mine, theirs] = [read(a), read(b)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    await call("POST", "/v1/studies/lawrence/activity", a, { kind: "message", text: "Live for A" });
    await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "Shared after" });
    const [forA, forB] = await Promise.all([mine, theirs]);
    assert.match(forA, /Replayed for A[\s\S]*Live for A[\s\S]*Shared after/);
    assert.doesNotMatch(forB, /for A/);
  });

  it("never delivers a visitor's entry to a webhook, and still delivers the shared entry after it", async () => {
    const sent: string[] = [];
    const post = (async (_url: string, init: RequestInit) => {
      sent.push(init.body as string);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const { call, a, forVisitor } = await visitors({ post });
    await call("POST", "/v1/subscriptions", "integration-token", { url: "https://hook.test/x", types: ["*"] });
    await call("POST", "/v1/studies/lawrence/activity", a, { kind: "message", text: "Only for A" });
    await call("POST", "/v1/studies/lawrence/activity", "agent-token", { kind: "message", text: "Also for A" }, forVisitor(a));
    await call("POST", "/v1/studies/lawrence/decisions", "planner-token", DECISION);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      sent.map((body) => JSON.parse(body).entry.type),
      ["subscription.added", "decision.recorded"],
    );
    assert.doesNotMatch(sent.join("\n"), /for A|guest:/);
  });
});
