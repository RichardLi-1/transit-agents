// The service as a process, as it runs on Fly: it stops when told to, even with
// a display's event stream open.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const started: { child: ChildProcess; data: string }[] = [];
after(() => {
  for (const { child, data } of started) {
    child.kill("SIGKILL");
    rmSync(data, { recursive: true, force: true });
  }
});

// Starts the service on a free port, with a data folder of its own.
async function start(env: Record<string, string> = {}) {
  const data = mkdtempSync(join(tmpdir(), "transit-main-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "main.ts")], {
    env: { PATH: process.env.PATH, PORT: "0", HOST: "127.0.0.1", DATA_DIR: data, AUTH: "demo", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push({ child, data });
  let errors = "";
  let out = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const found = out.match(/on (http:\/\/\S+)/);
      if (found?.[1]) resolve(found[1]);
    });
    child.on("exit", () => reject(new Error(`The service stopped: ${errors}`)));
  });
  return { child, url, exited, errors: () => errors, out: () => out };
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve(`still running after ${ms} ms`), ms).unref())]);

describe("service process", () => {
  it("stops on a signal with an event stream open, and ends the stream", async () => {
    const service = await start();
    const response = await fetch(`${service.url}/v1/events`);
    assert.equal(response.status, 200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    service.child.kill("SIGTERM");
    assert.equal(await within(service.exited, 5000), 0);
    // The stream ends, so a display reconnects to the next service.
    assert.equal(await within(reader.read().then(({ done }) => done, () => true), 1000), true);
    assert.equal(service.errors(), "");
  });

  it("stops once when told twice, as Ctrl-C in the demo does", async () => {
    const service = await start();
    const response = await fetch(`${service.url}/v1/events`);
    service.child.kill("SIGINT");
    service.child.kill("SIGTERM");
    assert.equal(await within(service.exited, 5000), 0);
    await response.body?.cancel().catch(() => {});
    assert.equal(service.errors(), "");
  });
});

describe("guests", () => {
  const SECRET = "a-guest-secret-of-at-least-32-characters";

  it("are on in demo mode with a GUEST_SECRET of 32 or more characters, and says so", async () => {
    const service = await start({ GUEST_SECRET: SECRET });
    const pass = await fetch(`${service.url}/v1/guests`, { method: "POST" });
    assert.equal(pass.status, 201);
    const { token } = await pass.json();
    assert.equal((await (await fetch(`${service.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json()).role, "guest");
    assert.match(service.out(), /Guests are on/);
    service.child.kill("SIGTERM");
    assert.equal(await within(service.exited, 5000), 0);
  });

  it("are off with a short secret, or outside demo mode", async () => {
    const settings: Record<string, string>[] = [{ GUEST_SECRET: SECRET.slice(0, 31) }, { GUEST_SECRET: SECRET, AUTH: "token" }];
    for (const env of settings) {
      const service = await start(env);
      assert.equal((await fetch(`${service.url}/v1/guests`, { method: "POST" })).status, 404, JSON.stringify(env));
      assert.doesNotMatch(service.out(), /Guests are on/);
      service.child.kill("SIGTERM");
      assert.equal(await within(service.exited, 5000), 0);
    }
  });

  it("share $10 a day, and $1 a pass, unless GUEST_DAILY_USD and GUEST_SHARE_USD say otherwise", async () => {
    const settings: [Record<string, string>, number, number][] = [
      [{}, 10, 1],
      [{ GUEST_DAILY_USD: "25", GUEST_SHARE_USD: "5" }, 25, 5],
    ];
    for (const [env, capUsd, leftUsd] of settings) {
      const service = await start({ GUEST_SECRET: SECRET, ...env });
      const { token } = await (await fetch(`${service.url}/v1/guests`, { method: "POST" })).json();
      const budget = await (await fetch(`${service.url}/v1/budget`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.deepEqual(budget, { capped: true, capUsd, leftUsd }, JSON.stringify(env));
      assert.ok(service.out().includes(`share $${capUsd}.00 of agent work a day`), service.out());
      service.child.kill("SIGTERM");
      assert.equal(await within(service.exited, 5000), 0);
    }
  });

  it("refuses a guest token in TRANSIT_TOKENS, without printing it", async () => {
    await assert.rejects(start({ TRANSIT_TOKENS: "guest:kim:not-a-pass-123" }), (error: Error) => {
      assert.match(error.message, /Guests use guest passes/);
      assert.doesNotMatch(error.message, /not-a-pass-123/);
      return true;
    });
  });
});
