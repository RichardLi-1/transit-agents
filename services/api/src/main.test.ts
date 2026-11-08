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
async function start() {
  const data = mkdtempSync(join(tmpdir(), "transit-main-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "main.ts")], {
    env: { PATH: process.env.PATH, PORT: "0", HOST: "127.0.0.1", DATA_DIR: data, AUTH: "demo" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push({ child, data });
  let errors = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const found = out.match(/on (http:\/\/\S+)/);
      if (found?.[1]) resolve(found[1]);
    });
    child.on("exit", () => reject(new Error(`The service stopped: ${errors}`)));
  });
  return { child, url, exited, errors: () => errors };
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
