import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTestBuild, webUrl } from "./host.ts";

describe("isTestBuild", () => {
  it("marks a display served from this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "::1", "display.localhost"]) assert.ok(isTestBuild(host), host);
  });

  it("never marks the deployed display, or a name that only looks local", () => {
    for (const host of ["transit-agents.fly.dev", "localhost.fly.dev", "notlocalhost", "127.0.0.1.nip.io"]) assert.ok(!isTestBuild(host), host);
  });
});

describe("webUrl", () => {
  it("keeps a web address", () => {
    for (const url of ["https://cdn.ttc.ca/plan.pdf", "http://127.0.0.1:4100/a"]) assert.equal(webUrl(url), url);
  });

  it("drops any other scheme, and what isn't an address", () => {
    for (const url of ["javascript:alert(document.domain)", "data:text/html,<script>1</script>", "file:///etc/passwd", "not a url", "", undefined]) {
      assert.equal(webUrl(url), undefined, String(url));
    }
  });
});
