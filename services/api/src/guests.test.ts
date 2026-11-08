import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { AccessMode } from "@transit-agents/contracts";
import { createApp, type Actor, type Verified } from "./app.ts";
import { issueGuest, userAudience, verifyGuest } from "./guests.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

const SECRET = "a-guest-secret-of-at-least-32-characters";
const NOW = new Date("2026-11-08T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const TOKENS = new Map<string, Actor>([["agent-token", { role: "agent", name: "lead" }]]);

type Setup = { access?: AccessMode; secret?: string; clock?: () => Date; verifyToken?: (token: string) => Promise<Verified | undefined> };

function setup({ access = "demo", secret = SECRET, clock = () => NOW, verifyToken }: Setup = {}) {
  const service = new Service(":memory:");
  const webhooks = new Webhooks(service, undefined, async () => new Response("ok"));
  const app = createApp({ service, webhooks, tokens: TOKENS, access, verifyToken, guests: secret ? { secret } : undefined, clock });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { service, app, call };
}

// A pass with one part changed, keeping its shape.
const swap = (token: string, part: number, value: string) =>
  token
    .split(".")
    .map((p, i) => (i === part ? value : p))
    .join(".");
const flip = (text: string) => (text.endsWith("A") ? `${text.slice(0, -1)}B` : `${text.slice(0, -1)}A`);
const signed = (secret: string, body: string) => `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;

describe("guest passes", () => {
  it("are signed, last a week, and name a 22-character id", () => {
    const pass = issueGuest(SECRET, NOW);
    assert.match(pass.token, /^g1\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(pass.expiresAt, new Date(NOW.getTime() + 7 * DAY).toISOString());
    const id = pass.token.split(".")[1];
    assert.deepEqual(verifyGuest(SECRET, pass.token, NOW), { id });
    assert.notEqual(issueGuest(SECRET, NOW).token.split(".")[1], id);
  });

  it("refuses a changed, expired, junk or foreign pass", () => {
    const { token } = issueGuest(SECRET, NOW);
    const [, id = "", exp = "", sig = ""] = token.split(".");
    const forged = [
      swap(token, 1, flip(id)),
      swap(token, 2, String(Number(exp) + 1)),
      swap(token, 3, flip(sig)),
      swap(token, 3, sig.slice(1)),
      swap(token, 0, "g2"),
      signed("another-secret-of-at-least-32-characters", `g1.${id}.${exp}`),
      signed(SECRET, `g1.${id.slice(1)}.${exp}`),
      signed(SECRET, `g1.${id}.-1`),
      signed(SECRET, `g1.${id}.1e12`),
      `${token}.extra`,
      "g1.",
      "g1.junk",
      "g1.....",
    ];
    for (const pass of forged) assert.equal(verifyGuest(SECRET, pass, NOW), undefined, pass);
    assert.equal(verifyGuest(SECRET, token, new Date(NOW.getTime() + 7 * DAY)), undefined);
    assert.ok(verifyGuest(SECRET, token, new Date(NOW.getTime() + 7 * DAY - 1000)));
  });

  it("gives someone signed in the same audience each time, without showing who they are", () => {
    const audience = userAudience(SECRET, "auth0|123");
    assert.match(audience, /^user:[A-Za-z0-9_-]{22}$/);
    assert.equal(userAudience(SECRET, "auth0|123"), audience);
    assert.notEqual(userAudience(SECRET, "auth0|124"), audience);
    assert.doesNotMatch(audience, /123/);
  });

  it("keys a signed-in person's audience with the secret, so their subject alone can't give it", () => {
    const audience = userAudience(SECRET, "auth0|123");
    assert.notEqual(userAudience("another-secret-of-at-least-32-characters", "auth0|123"), audience);
    assert.notEqual(`user:${createHash("sha256").update("auth0|123").digest("base64url").slice(0, 22)}`, audience);
  });
});

describe("guest passes over HTTP", () => {
  it("are given to anyone, uncached, and writing nothing", async () => {
    const { call, service } = setup();
    const head = service.log.head();
    const response = await call("POST", "/v1/guests", "stale-token");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const pass = await response.json();
    assert.deepEqual(Object.keys(pass).sort(), ["expiresAt", "token"]);
    assert.deepEqual(service.log.head(), head);
    assert.equal((service.log.db.prepare("SELECT count(*) AS n FROM idempotency").get() as { n: number }).n, 0);
    const me = await call("GET", "/v1/me", pass.token);
    assert.deepEqual(await me.json(), { role: "guest", name: pass.token.split(".")[1] });
    assert.deepEqual(await (await call("GET", "/v1/config")).json(), { auth: "demo", signIn: null, guests: true, executive: null });
  });

  it("refuses a pass that doesn't check out, never reading it as no token", async () => {
    let now = NOW;
    const { call, app } = setup({ clock: () => now });
    const { token } = issueGuest(SECRET, NOW);
    const [, id = "", exp = "", sig = ""] = token.split(".");
    const refused = [
      swap(token, 1, flip(id)),
      swap(token, 2, String(Number(exp) + 60)),
      swap(token, 3, flip(sig)),
      signed("another-secret-of-at-least-32-characters", `g1.${id}.${exp}`),
      "g1.junk",
      "g1.",
    ];
    for (const pass of refused) {
      for (const path of ["/v1/me", "/v1/studies"]) {
        const response = await call("GET", path, pass);
        assert.equal(response.status, 401, `${pass} ${path}`);
        assert.equal((await response.json()).error.code, "bad_token", pass);
      }
      assert.equal((await app.request(`/v1/events?access_token=${encodeURIComponent(pass)}`)).status, 401, pass);
    }
    assert.equal((await call("GET", "/v1/me", token)).status, 200);
    now = new Date(NOW.getTime() + 7 * DAY);
    const expired = await call("GET", "/v1/me", token);
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, "bad_token");
  });

  it("never hands a pass to the sign-in verifier", async () => {
    const asked: string[] = [];
    const verifyToken = async (token: string): Promise<Verified | undefined> => {
      asked.push(token);
      return { role: "planner", name: "ana", subject: "auth0|1" };
    };
    const { call } = setup({ verifyToken });
    const { token } = issueGuest("another-secret-of-at-least-32-characters", NOW);
    assert.equal((await call("GET", "/v1/me", token)).status, 401);
    assert.equal((await call("GET", "/v1/me", "g1.junk")).status, 401);
    assert.deepEqual(asked, []);
  });

  it("gives none out without a secret, and demo mode stays read-only", async () => {
    const { call, service } = setup({ secret: "" });
    const response = await call("POST", "/v1/guests");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
    assert.deepEqual(await (await call("GET", "/v1/config")).json(), { auth: "demo", signIn: null, guests: false, executive: null });
    // A pass the service would have signed, had it a secret, is still refused.
    const { token } = issueGuest(SECRET, NOW);
    assert.equal((await call("GET", "/v1/me", token)).status, 401);
    assert.equal((await call("POST", "/v1/studies", undefined, { id: "lawrence", title: "Lawrence" })).status, 401);
    assert.deepEqual(await (await call("GET", "/v1/me")).json(), { role: "viewer", name: "demo" });
    assert.equal(service.log.head().seq, 0);
  });

  it("gives none out except in demo mode, even with a secret", async () => {
    for (const access of ["token", "open"] as const) {
      const { call } = setup({ access });
      assert.equal((await call("POST", "/v1/guests")).status, 404, access);
      assert.equal((await (await call("GET", "/v1/config")).json()).guests, false, access);
      assert.equal((await call("GET", "/v1/me", issueGuest(SECRET, NOW).token)).status, 401, access);
    }
  });
});
