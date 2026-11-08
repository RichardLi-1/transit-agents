import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccessMode } from "@transit-agents/contracts";
import { createLocalJWKSet, exportJWK, exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT, type JWTPayload } from "jose";
import { createApp, type Actor } from "./app.ts";
import { auth0Settings, verifyAuth0 } from "./auth0.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

const DOMAIN = "tenant.auth0.test";
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = "https://api.transit.test";
const NAME = "https://transit-agents/name";

// The tenant's signing keys, as a local key set, so no test touches the network.
// They name no algorithm, so only the verifier holds tokens to RS256.
const tenant = await generateKeyPair("RS256");
const other = await generateKeyPair("RS512");
const keys = createLocalJWKSet({
  keys: [
    { ...(await exportJWK(tenant.publicKey)), kid: "tenant-key", use: "sig" },
    { ...(await exportJWK(other.publicKey)), kid: "other-key", use: "sig" },
  ],
});

function setup({ access = "token", nameClaim }: { access?: AccessMode; nameClaim?: string } = {}) {
  const service = new Service(":memory:");
  const webhooks = new Webhooks(service, "https://example.test", async () => new Response("ok"));
  const tokens = new Map<string, Actor>([["agent-token", { role: "agent", name: "lead" }]]);
  const verifyToken = verifyAuth0({ domain: DOMAIN, audience: AUDIENCE, nameClaim, keys });
  const app = createApp({ service, webhooks, tokens, verifyToken, access });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { service, app, call };
}

type Signing = {
  key?: CryptoKey | Uint8Array;
  alg?: string;
  kid?: string;
  issuer?: string;
  audience?: string | string[];
  expires?: number | string | null;
  notBefore?: number;
};

// An access token as the tenant issues one, unless a test changes something.
function accessToken(claims: JWTPayload = {}, signing: Signing = {}) {
  const { key = tenant.privateKey, alg = "RS256", kid = "tenant-key", issuer = ISSUER, audience = AUDIENCE, expires = "5m", notBefore } = signing;
  const jwt = new SignJWT({ sub: "auth0|ana", ...claims }).setProtectedHeader({ alg, kid }).setIssuer(issuer).setAudience(audience).setIssuedAt();
  if (expires !== null) jwt.setExpirationTime(expires);
  if (notBefore !== undefined) jwt.setNotBefore(notBefore);
  return jwt.sign(key);
}

const now = () => Math.floor(Date.now() / 1000);

// Every failure gets the same short answer, which says nothing about why.
async function refused(response: Response) {
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: "bad_token", message: "Unknown token" } });
}

const STUDY = { id: "lawrence", title: "Lawrence–Sunnybrook" };
const DECISION = { outcome: "adopt", reason: "Passes the tests", decidedBy: "Ana Ruiz" };

describe("auth0", () => {
  it("lets a planner decide, and names them in the log", async () => {
    const { call, service } = setup();
    assert.equal((await call("POST", "/v1/studies", "agent-token", STUDY)).status, 201);
    // Auth0 adds its userinfo audience when the display asks for openid.
    const token = await accessToken({ permissions: ["planner"], [NAME]: "ana.ruiz@ttc.ca" }, { audience: [AUDIENCE, `${ISSUER}userinfo`] });
    assert.equal((await call("POST", "/v1/studies/lawrence/decisions", token, DECISION)).status, 201);
    assert.equal(service.log.since(0).at(-1)?.actor, "planner:ana.ruiz@ttc.ca");
  });

  it("makes a person with no permissions a viewer, who can read but not decide", async () => {
    const { call } = setup();
    await call("POST", "/v1/studies", "agent-token", STUDY);
    const token = await accessToken();
    assert.deepEqual(await (await call("GET", "/v1/me", token)).json(), { role: "viewer", name: "auth0-ana" });
    assert.equal((await call("GET", "/v1/studies/lawrence", token)).status, 200);
    const response = await call("POST", "/v1/studies/lawrence/decisions", token, DECISION);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "forbidden");
  });

  it("takes the first of planner, integration and agent that the person holds", async () => {
    const { call } = setup();
    const roleOf = async (permissions: unknown) => (await (await call("GET", "/v1/me", await accessToken({ permissions }))).json()).role;
    assert.equal(await roleOf(["agent", "planner"]), "planner");
    assert.equal(await roleOf(["agent", "integration"]), "integration");
    assert.equal(await roleOf(["agent"]), "agent");
    assert.equal(await roleOf(["read:studies"]), "viewer");
    assert.equal(await roleOf("planner"), "viewer");
  });

  it("follows events with a token in the query", async () => {
    const { app } = setup();
    const controller = new AbortController();
    const response = await app.request(`/v1/events?access_token=${await accessToken()}`, { signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    await response.body?.cancel();
    controller.abort();
  });

  it("refuses a token that expired, or isn't valid yet, more than 30 seconds ago or ahead", async () => {
    const { call } = setup();
    await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { expires: now() - 45 })));
    await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { notBefore: now() + 45 })));
    await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { expires: null })));
  });

  it("refuses a token for another API, or from another issuer", async () => {
    const { call } = setup();
    await refused(await call("GET", "/v1/me", await accessToken({}, { audience: "https://other-api.test" })));
    await refused(await call("GET", "/v1/me", await accessToken({}, { issuer: "https://attacker.auth0.test/" })));
  });

  it("refuses HS256 signed with a guessed secret, such as the tenant's public key", async () => {
    const { call } = setup();
    for (const secret of ["secret", await exportSPKI(tenant.publicKey)]) {
      await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { alg: "HS256", key: new TextEncoder().encode(secret) })));
    }
  });

  it("refuses alg none", async () => {
    const { call } = setup();
    const token = new UnsecuredJWT({ sub: "auth0|ana", permissions: ["planner"] }).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m").encode();
    await refused(await call("GET", "/v1/me", token));
  });

  it("accepts RS256 only, even from a key the tenant publishes", async () => {
    const { call } = setup();
    await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { alg: "RS512", key: other.privateKey, kid: "other-key" })));
  });

  it("refuses a token whose payload was changed after signing", async () => {
    const { call } = setup();
    const [header, payload, signature] = (await accessToken()).split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, permissions: ["planner"] })).toString("base64url");
    await refused(await call("GET", "/v1/me", [header, forged, signature].join(".")));
  });

  it("refuses a token signed with a key the tenant doesn't publish", async () => {
    const { call } = setup();
    const stranger = await generateKeyPair("RS256");
    await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { key: stranger.privateKey, kid: "unknown-key" })));
    await refused(await call("GET", "/v1/me", await accessToken({ permissions: ["planner"] }, { key: stranger.privateKey })));
  });

  it("refuses a person who would act as a static token or as a caller without one, so the log tells them apart", async () => {
    const { call } = setup({ access: "open" });
    for (const [permissions, name] of [[["agent"], "lead"], [["planner"], "local"], [[], "demo"]] as const) {
      await refused(await call("GET", "/v1/me", await accessToken({ permissions, [NAME]: name })));
    }
    // The same name in another role is someone else.
    assert.deepEqual(await (await call("GET", "/v1/me", await accessToken({ permissions: ["planner"], [NAME]: "lead" }))).json(), { role: "planner", name: "lead" });
  });

  it("refuses a bad token in demo mode, instead of reading as the demo viewer", async () => {
    const { app, call } = setup({ access: "demo" });
    const expired = await accessToken({}, { expires: now() - 45 });
    await refused(await call("GET", "/v1/studies", expired));
    await refused(await app.request(`/v1/events?access_token=${expired}`));
  });

  describe("settings", () => {
    it("takes AUTH0_DOMAIN in any case, since the tenant's tokens name it in lowercase", async () => {
      const { verifyToken, signIn } = auth0Settings({ AUTH0_DOMAIN: "Tenant.Auth0.TEST", AUTH0_AUDIENCE: AUDIENCE, AUTH0_CLIENT_ID: "display-client" }, keys);
      assert.deepEqual(signIn, { provider: "auth0", domain: DOMAIN, clientId: "display-client", audience: AUDIENCE });
      assert.equal((await verifyToken?.(await accessToken({ permissions: ["planner"] })))?.role, "planner");
    });

    it("refuses a domain that isn't a host name, and offers sign-in only with all three set", () => {
      assert.throws(() => auth0Settings({ AUTH0_DOMAIN: "https://tenant.auth0.test/", AUTH0_AUDIENCE: AUDIENCE }), /AUTH0_DOMAIN should be a host name/);
      assert.equal(auth0Settings({ AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: AUDIENCE }).signIn, null);
      assert.equal(auth0Settings({ AUTH0_DOMAIN: DOMAIN }).verifyToken, undefined);
    });
  });

  describe("names", () => {
    const nameOf = async (claims: JWTPayload, nameClaim?: string) =>
      (await (await setup({ nameClaim }).call("GET", "/v1/me", await accessToken(claims))).json()).name;

    it("keeps letters, digits and . _ @ -, and makes anything else a -", async () => {
      assert.equal(await nameOf({ [NAME]: "Ana Ruiz <ana_ruiz@ttc.ca>" }), "Ana-Ruiz--ana_ruiz@ttc.ca-");
      assert.equal(await nameOf({ [NAME]: "planner:boss" }), "planner-boss");
      assert.equal(await nameOf({ [NAME]: "Zoë \u{1F68C}" }), "Zo---");
    });

    it("cuts a name to 80 characters", async () => {
      assert.equal(await nameOf({ [NAME]: "a".repeat(100) }), "a".repeat(80));
    });

    it("falls back to the subject, then to user", async () => {
      assert.equal(await nameOf({}), "auth0-ana");
      assert.equal(await nameOf({ [NAME]: 42 }), "auth0-ana");
      assert.equal(await nameOf({ sub: undefined }), "user");
    });

    it("reads another claim when AUTH0_NAME_CLAIM names one", async () => {
      assert.equal(await nameOf({ email: "ana@ttc.ca", [NAME]: "Ana" }, "email"), "ana@ttc.ca");
    });
  });
});
