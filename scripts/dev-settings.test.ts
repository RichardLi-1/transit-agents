import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileSetting, fromFile, setting } from "./dev-settings.ts";

const file = [
  "GEMINI_API_KEY=abc",
  "export SLACK_BOT_TOKEN='xoxb-1'",
  'SLACK_WEBHOOK_URL="https://hooks.example/x"',
  "PUBLIC_URL=http://example.test # where links open",
  "SLACK_EXECUTIVE=",
].join("\n");

describe("dev settings", () => {
  it("reads a file's values, with quotes and comments taken off", () => {
    assert.equal(fileSetting(file, "SLACK_BOT_TOKEN"), "xoxb-1");
    assert.equal(fileSetting(file, "SLACK_WEBHOOK_URL"), "https://hooks.example/x");
    assert.equal(fileSetting(file, "PUBLIC_URL"), "http://example.test");
    assert.equal(fileSetting(file, "SLACK_EXECUTIVE"), undefined);
    assert.equal(fileSetting(file, "SLACK_APP_TOKEN"), undefined);
  });

  it("lets the environment win, even when it sets a name empty", () => {
    assert.equal(setting({}, file, "SLACK_BOT_TOKEN"), "xoxb-1");
    assert.equal(setting({ SLACK_BOT_TOKEN: "xoxb-2" }, file, "SLACK_BOT_TOKEN"), "xoxb-2");
    assert.equal(setting({ SLACK_BOT_TOKEN: "" }, file, "SLACK_BOT_TOKEN"), undefined);
  });

  it("hands on only the file's values the environment doesn't set", () => {
    const env = { SLACK_WEBHOOK_URL: "", PUBLIC_URL: "http://127.0.0.1:4610" };
    assert.deepEqual(fromFile(env, file, ["SLACK_WEBHOOK_URL", "SLACK_EXECUTIVE", "PUBLIC_URL", "GEMINI_API_KEY"]), { GEMINI_API_KEY: "abc" });
  });
});
