// The display's session, run in Node with just enough of a browser: an address,
// storage, cookies, and a fetch that holds each request until the test answers it,
// so each test decides what lands first. Sign-in runs the real Auth0 SDK, and the
// test plays the tenant.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ServiceConfig, SignIn } from "@transit-agents/contracts";
import type { Session } from "./session.ts";

type Held = { path: string; authorization: string | null; answered: boolean; answer: (status: number, body: unknown) => void };

const requests: Held[] = [];
const navigations: string[] = [];
let address = new URL("http://display.test/");
const cookies = new Map<string, string>();

class MemoryStorage {
  #items = new Map<string, string>();
  getItem = (key: string) => this.#items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.#items.set(key, String(value));
  removeItem = (key: string) => void this.#items.delete(key);
}

const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define("location", {
  get href() {
    return address.href;
  },
  get search() {
    return address.search;
  },
  get hash() {
    return address.hash;
  },
  get pathname() {
    return address.pathname;
  },
  get origin() {
    return address.origin;
  },
  assign: (url: string) => void navigations.push(url),
});
define("history", { replaceState: (_state: unknown, _title: string, next: string) => (address = new URL(next, address)) });
define("sessionStorage", new MemoryStorage());
define("localStorage", new MemoryStorage());
define("window", globalThis);
define("addEventListener", () => {});
define("removeEventListener", () => {});
define("document", {
  get cookie() {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  },
  set cookie(text: string) {
    const [pair = ""] = text.split(";");
    cookies.set(pair.slice(0, pair.indexOf("=")).trim(), pair.slice(pair.indexOf("=") + 1));
  },
  addEventListener: () => {},
  removeEventListener: () => {},
});
define("fetch", (input: string | Request, init: RequestInit = {}) => {
  return new Promise<Response>((resolve) => {
    const held: Held = {
      path: typeof input === "string" ? input : input.url,
      authorization: new Headers(init.headers).get("authorization"),
      answered: false,
      answer: (status, body) => {
        held.answered = true;
        resolve(Response.json(body, { status }));
      },
    };
    requests.push(held);
  });
});

const { forgetTokens, hasToken, setPersonalToken } = await import("./api.ts");

const wait = () => new Promise((resolve) => setTimeout(resolve, 1));

// The next request to a path that hasn't been answered yet.
async function next(path: string): Promise<Held> {
  for (let i = 0; i < 100; i++) {
    const held = requests.find((request) => request.path === path && !request.answered);
    if (held) return held;
    await wait();
  }
  throw new Error(`Nothing asked for ${path}`);
}

async function until(check: () => unknown) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait();
  }
  throw new Error("It never happened");
}

// A session module of its own, as a page load would have, so nothing is fetched yet.
let loads = 0;
const load = async () => (await import(`./session.ts?${++loads}`)) as typeof import("./session.ts");

async function start() {
  const { followSession } = await load();
  const seen: Session[] = [];
  void followSession((session) => seen.push(session));
  return seen;
}

// Goes to sign in from an address, and comes back from the tenant with the given
// answer, as a new page load.
async function signInAndReturn(from: string, answer: Record<string, string>) {
  address = new URL(from);
  await (await load()).signIn(SIGN_IN);
  const authorize = new URL(navigations.at(-1) ?? "");
  const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  for (const [key, value] of Object.entries({ ...answer, state: authorize.searchParams.get("state") ?? "" })) back.searchParams.set(key, value);
  address = back;
  const finished = (await load()).finishSignIn();
  (await next("/v1/config")).answer(200, { auth: "demo", signIn: SIGN_IN });
  return finished;
}

const SIGN_IN: SignIn = { provider: "auth0", domain: "tenant.auth0.test", clientId: "display-client", audience: "https://api.transit.test" };
const DEMO: ServiceConfig = { auth: "demo", signIn: null };

describe("session", () => {
  beforeEach(() => {
    requests.length = 0;
    forgetTokens();
  });

  it("asks who it is while it asks how people sign in, and reads as soon as its token is taken", async () => {
    setPersonalToken(async () => "a-token");
    const seen = await start();
    const me = await next("/v1/me");
    const config = await next("/v1/config");
    assert.equal(me.authorization, "Bearer a-token");
    me.answer(200, { role: "planner", name: "ana" });
    await until(() => seen.at(-1)?.reads);
    assert.equal(config.answered, false);
    config.answer(200, DEMO);
    await until(() => seen.at(-1)?.config);
    assert.deepEqual(seen.at(-1), { config: DEMO, me: { role: "planner", name: "ana" }, anonymous: false, signedIn: false, reads: true });
  });

  it("reads without a token as soon as the service lets anyone, and asks who it is alongside", async () => {
    const seen = await start();
    (await next("/v1/config")).answer(200, DEMO);
    await until(() => seen.at(-1)?.reads);
    assert.equal(seen.at(-1)?.me, null);
    const me = await next("/v1/me");
    assert.equal(me.authorization, null);
    me.answer(200, { role: "viewer", name: "demo" });
    await until(() => seen.at(-1)?.me);
    assert.deepEqual(seen.at(-1), { config: DEMO, me: { role: "viewer", name: "demo" }, anonymous: true, signedIn: false, reads: true });
  });

  it("drops a token the service refuses, and reads without it where anyone may", async () => {
    setPersonalToken(async () => "stale");
    const seen = await start();
    (await next("/v1/config")).answer(200, DEMO);
    (await next("/v1/me")).answer(401, { error: { code: "bad_token", message: "Unknown token" } });
    const again = await next("/v1/me");
    assert.equal(again.authorization, null);
    again.answer(200, { role: "viewer", name: "demo" });
    await until(() => seen.at(-1)?.me);
    assert.equal(hasToken(), false);
    assert.deepEqual(seen.at(-1), { config: DEMO, me: { role: "viewer", name: "demo" }, anonymous: true, signedIn: false, reads: true });
  });

  it("reads nothing, and asks nothing more, where a token is needed and it holds none", async () => {
    const seen = await start();
    (await next("/v1/config")).answer(200, { auth: "token", signIn: SIGN_IN });
    await until(() => seen.length);
    await wait();
    assert.deepEqual(seen.at(-1), { config: { auth: "token", signIn: SIGN_IN }, me: null, anonymous: true, signedIn: false, reads: false });
    assert.equal(requests.some((request) => request.path === "/v1/me"), false);
  });

  it("offers uploads only to roles that can add context, and the chat only to roles that can post to it", async () => {
    const { canAdd, canPost } = await import("./session.ts");
    for (const [role, add, post] of [["viewer", false, false], ["integration", true, false], ["agent", true, true], ["planner", true, true]] as const) {
      assert.equal(canAdd({ role, name: "someone" }), add, role);
      assert.equal(canPost({ role, name: "someone" }), post, role);
    }
    assert.equal(canAdd(null) || canPost(null), false);
  });
});

describe("signing in", () => {
  beforeEach(() => {
    requests.length = 0;
    forgetTokens();
  });

  it("comes back from a cancelled sign-in to the study that was open, with a clean address", async () => {
    await signInAndReturn("http://display.test/#finch", { error: "access_denied", error_description: "User did not authorize the request" });
    assert.equal(address.href, "http://display.test/#finch");
    assert.equal(hasToken(), false);
  });

  it("comes back from a sign-in the tenant fails to finish to the study that was open", async () => {
    const finished = signInAndReturn("http://display.test/#finch", { code: "a-code" });
    (await next(`https://${SIGN_IN.domain}/oauth/token`)).answer(403, { error: "invalid_grant", error_description: "Invalid authorization code" });
    await finished;
    assert.equal(address.href, "http://display.test/#finch");
    assert.equal(hasToken(), false);
  });
});
