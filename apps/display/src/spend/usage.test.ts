import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { Usage } from "@transit-agents/contracts";
import { forgetTokens, hasToken, setPersonalToken } from "../api.ts";
import { spentUsd } from "../money.ts";
import { watchUsage } from "./usage.ts";

// Just enough of the browser for the spend screen's requests.
class FakeEventSource {
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = 1;
  url: URL;
  private listeners = new Map<string, (event: { data: string }) => void>();
  constructor(url: URL) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }
  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  send(kind: string) {
    this.listeners.get("activity")?.({ data: JSON.stringify({ type: "activity", data: { kind } }) });
  }
  // A model call made in a sandbox the screen can't read.
  sendUnseen() {
    this.listeners.get("usage")?.({ data: "{}" });
  }
}

const total = (calls: number): Usage => ({ inputTokens: 100 * calls, outputTokens: 0, costUsd: calls / 1000, computeSeconds: 0, calls });

describe("spend screen's dollars", () => {
  it("shows no sum while a model call has no price, rather than one that's too low", () => {
    assert.equal(spentUsd({ ...total(3), unpricedCalls: 0 }), 0.003);
    assert.equal(spentUsd({ ...total(3), unpricedCalls: 1 }), null);
    assert.equal(spentUsd(null), null);
  });
});

describe("spend screen's requests", () => {
  let mode: "demo" | "token" = "demo";
  let head = 0;
  let calls = 0;
  let headReply: Promise<void> = Promise.resolve();
  let requested: string[] = [];
  // Tokens the service refuses, as "Bearer <token>".
  let refused = new Set<string>();
  let shown: (number | null)[] = [];
  let stop = () => {};

  // Lets the fake requests and their callbacks finish.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  const start = async () => {
    stop = watchUsage((usage) => shown.push(usage ? usage.calls : null));
    await settle();
  };

  beforeEach(() => {
    mode = "demo";
    head = 41;
    calls = 3;
    headReply = Promise.resolve();
    requested = [];
    refused = new Set();
    shown = [];
    FakeEventSource.opened = [];
    Object.assign(globalThis, { window: globalThis, location: { href: "http://display.test/spend" }, EventSource: FakeEventSource });
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
      requested.push(path);
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (path === "/v1/config") return Response.json({ auth: mode, signIn: null });
      if (authorization && refused.has(authorization)) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      if (path === "/v1/log/head") {
        await headReply;
        return Response.json({ seq: head, hash: "" });
      }
      return Response.json({ total: total(calls), byStudy: {} });
    });
  });

  afterEach(() => {
    stop();
    forgetTokens();
    mock.timers.reset();
    mock.restoreAll();
  });

  it("starts the stream at the log's head, read before the totals", async () => {
    let reply = () => {};
    headReply = new Promise((resolve) => (reply = resolve));
    await start();
    assert.deepEqual(requested, ["/v1/config", "/v1/log/head"]);
    reply();
    await settle();
    assert.deepEqual(requested, ["/v1/config", "/v1/log/head", "/v1/usage"]);
    assert.deepEqual(shown, [3]);
    assert.equal(FakeEventSource.opened.length, 1);
    const url = FakeEventSource.opened[0]?.url;
    assert.equal(url?.searchParams.get("after"), "41");
    assert.equal(url?.searchParams.get("types"), "activity");
  });

  it("sends the token in the stream's address, since a stream can't send headers", async () => {
    setPersonalToken(async () => "secret");
    await start();
    assert.equal(FakeEventSource.opened[0]?.url.searchParams.get("access_token"), "secret");
  });

  it("drops a token the service refuses, and reads without it", async () => {
    refused.add("Bearer stale");
    setPersonalToken(async () => "stale");
    await start();
    assert.equal(hasToken(), false);
    assert.deepEqual(requested, ["/v1/log/head", "/v1/config", "/v1/log/head", "/v1/usage"]);
    assert.deepEqual(shown, [3]);
    assert.equal(FakeEventSource.opened.length, 1);
    assert.equal(FakeEventSource.opened[0]?.url.searchParams.has("access_token"), false);
  });

  it("drops a token refused later, as after a restart with new tokens", async () => {
    setPersonalToken(async () => "old");
    await start();
    assert.deepEqual(shown, [3]);
    // The restarted service refuses the token, and the stream with it.
    refused.add("Bearer old");
    FakeEventSource.opened[0]?.close();
    calls = 5;
    mock.timers.tick(30_000);
    await settle();
    assert.equal(hasToken(), false);
    assert.deepEqual(shown, [3, 5]);
    assert.equal(FakeEventSource.opened.length, 2);
    assert.equal(FakeEventSource.opened[1]?.url.searchParams.has("access_token"), false);
  });

  it("asks nothing in token mode without a token", async () => {
    mode = "token";
    await start();
    mock.timers.tick(60_000);
    await settle();
    assert.deepEqual(requested, ["/v1/config"]);
    assert.equal(FakeEventSource.opened.length, 0);
    assert.deepEqual(shown, [null]);
  });

  it("shows no numbers, and stops asking, once token mode refuses the screen's token", async () => {
    mode = "token";
    setPersonalToken(async () => "old");
    await start();
    assert.deepEqual(shown, [3]);
    refused.add("Bearer old");
    mock.timers.tick(30_000);
    await settle();
    assert.equal(hasToken(), false);
    assert.deepEqual(shown, [3, null]);
    assert.equal(FakeEventSource.opened[0]?.readyState, FakeEventSource.CLOSED);
    const asked = requested.length;
    mock.timers.tick(60_000);
    await settle();
    assert.equal(requested.length, asked);
  });

  it("loads the totals once, soon after a burst of usage reports", async () => {
    await start();
    const [source] = FakeEventSource.opened;
    calls = 5;
    source?.send("usage");
    source?.send("message");
    source?.send("usage");
    mock.timers.tick(499);
    await settle();
    assert.deepEqual(requested, ["/v1/config", "/v1/log/head", "/v1/usage"]);
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(requested, ["/v1/config", "/v1/log/head", "/v1/usage", "/v1/usage"]);
    assert.deepEqual(shown, [3, 5]);
  });

  it("loads the totals soon after a model call made for a visitor, which the stream only counts", async () => {
    await start();
    const [source] = FakeEventSource.opened;
    calls = 4;
    source?.sendUnseen();
    source?.sendUnseen();
    mock.timers.tick(500);
    await settle();
    assert.deepEqual(requested, ["/v1/config", "/v1/log/head", "/v1/usage", "/v1/usage"]);
    assert.deepEqual(shown, [3, 4]);
  });

  it("reopens a refused stream at the new head on the next poll", async () => {
    await start();
    FakeEventSource.opened[0]?.close();
    head = 57;
    mock.timers.tick(30_000);
    await settle();
    assert.deepEqual(requested, ["/v1/config", "/v1/log/head", "/v1/usage", "/v1/log/head", "/v1/usage"]);
    assert.equal(FakeEventSource.opened.length, 2);
    assert.equal(FakeEventSource.opened[1]?.url.searchParams.get("after"), "57");
    // An open stream stays open: the poll only loads the totals.
    mock.timers.tick(30_000);
    await settle();
    assert.equal(FakeEventSource.opened.length, 2);
    assert.equal(requested.at(-1), "/v1/usage");
  });
});
