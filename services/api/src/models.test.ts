import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp, modelChoices, type Actor } from "./app.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

const PLANNER = "planner-token";

function setup(raw: string | undefined) {
  const service = new Service(":memory:");
  service.openStudy("agent:lead", { id: "lawrence", title: "Lawrence–Sunnybrook", brief: "", routes: [], watch: [], project: [] });
  const tokens = new Map<string, Actor>([[PLANNER, { role: "planner", name: "ana" }]]);
  const app = createApp({ service, webhooks: new Webhooks(service, "https://example.test", async () => new Response("ok")), tokens, access: "token", models: modelChoices(raw) });
  const post = (body: unknown) =>
    app.request("/v1/studies/lawrence/activity", {
      method: "POST",
      headers: { authorization: `Bearer ${PLANNER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, post };
}

describe("the agents' model, chosen in the display's Settings", () => {
  it("reads MODEL_CHOICES, the first the default, dropping what isn't a model's name", () => {
    assert.deepEqual(modelChoices("gemini-3.6-flash, qwen3.5:9b,,Not A Model,gemini-3.6-flash"), {
      choices: ["gemini-3.6-flash", "qwen3.5:9b"],
      default: "gemini-3.6-flash",
    });
    assert.equal(modelChoices(""), undefined);
  });

  it("tells the display the choices", async () => {
    const { app } = setup("gemini-3.6-flash,gemini-3.8-flash");
    const config = (await (await app.request("/v1/config")).json()) as { models: unknown };
    assert.deepEqual(config.models, { choices: ["gemini-3.6-flash", "gemini-3.8-flash"], default: "gemini-3.6-flash" });
  });

  it("takes a message that asks for one of them, or for none", async () => {
    const { post } = setup("gemini-3.6-flash,gemini-3.8-flash");
    assert.equal((await post({ kind: "message", text: "Riders?", model: "gemini-3.8-flash" })).status, 201);
    assert.equal((await post({ kind: "message", text: "Riders?" })).status, 201);
  });

  it("refuses one this service doesn't offer, such as an open model where no model server runs", async () => {
    const { post } = setup("gemini-3.6-flash");
    const response = await post({ kind: "message", text: "Riders?", model: "qwen3.5:9b" });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "unknown_model");
    assert.equal((await setup(undefined).post({ kind: "message", text: "Riders?", model: "gemini-3.6-flash" })).status, 400);
  });
});
