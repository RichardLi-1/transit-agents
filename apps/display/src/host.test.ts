import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTestBuild } from "./host.ts";

describe("isTestBuild", () => {
  it("marks a display served from this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "::1", "display.localhost"]) assert.ok(isTestBuild(host), host);
  });

  it("never marks the deployed display, or a name that only looks local", () => {
    for (const host of ["transit-agents.fly.dev", "localhost.fly.dev", "notlocalhost", "127.0.0.1.nip.io"]) assert.ok(!isTestBuild(host), host);
  });
});
