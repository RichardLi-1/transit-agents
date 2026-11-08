import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DOCUMENT_LABEL, type DocumentView } from "@transit-agents/contracts";
import { createApp, type Actor } from "./app.ts";
import { printable } from "./document.ts";
import { EVERYONE } from "./log.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);
const GUEST_SECRET = "a-guest-secret-of-at-least-32-characters";

const PAGES = [
  { page: 1, text: "The Ontario Line would carry 388,000 daily riders by 2041." },
  { page: 2, text: "Construction would close two lanes of Don Mills Road for 18 months." },
];
const CITED = { text: "About 388,000 riders a day by 2041", citation: { contextId: "ibc", page: 1, quote: "388,000 daily riders by 2041" } };
const BRIEF = {
  kind: "report",
  title: "TPAP brief",
  sections: [
    { heading: "Project description", points: [CITED, "A subway line from Exhibition to the Science Centre (ibc p. 1)"] },
    {
      heading: "Potential impacts and mitigation",
      points: [{ text: "Two lanes closed for 18 months", citation: { contextId: "ibc", page: 2, quote: "close two lanes of Don Mills Road for 18 months" } }],
    },
    { heading: "To confirm", points: ["TPAP timelines: no study source covers them yet"] },
  ],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "transit-documents-"));
  const service = new Service(":memory:", { mediaDir: join(dir, "media") });
  const webhooks = new Webhooks(service, "https://example.test", async () => new Response("ok"));
  const app = createApp({
    service,
    webhooks,
    tokens: TOKENS,
    access: "demo",
    guests: { secret: GUEST_SECRET },
    visitorAgents: ["lead"],
    publicUrl: "https://transit.test",
  });
  const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const stop = () => {
    webhooks.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { service, app, call, dir, stop };
}

async function seeded() {
  const env = setup();
  await env.call("POST", "/v1/context", "planner-token", { id: "ibc", title: "Ontario Line Initial Business Case", pages: PAGES });
  await env.call("POST", "/v1/studies", "agent-token", { id: "ontario", title: "Ontario Line to Don Mills" });
  return env;
}

const documentsIn = (env: Awaited<ReturnType<typeof seeded>>) => env.service.log.since(0, 1000, EVERYONE).filter((entry) => entry.type === "document.created");

describe("documents", () => {
  const envs: Awaited<ReturnType<typeof seeded>>[] = [];
  after(() => envs.forEach((env) => env.stop()));
  const fresh = async () => {
    const env = await seeded();
    envs.push(env);
    return env;
  };

  it("makes a report as a PDF in the media store, and logs it with its sources", async () => {
    const env = await fresh();
    const response = await env.call("POST", "/v1/studies/ontario/documents", "agent-token", BRIEF);
    assert.equal(response.status, 201, await response.clone().text());
    const document = (await response.json()) as DocumentView;
    assert.equal(document.kind, "report");
    assert.equal(document.url, `/v1/media/${document.id}`);
    assert.equal(document.link, `https://transit.test/v1/media/${document.id}`);
    assert.ok(document.pages >= 2);

    const served = await env.call("GET", document.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "application/pdf");
    assert.equal(served.headers.get("content-disposition"), 'inline; filename="tpap-brief-draft.pdf"');
    // Chrome's viewer runs as a plugin, which the display's own policy blocks.
    assert.doesNotMatch(served.headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.match(served.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const bytes = new Uint8Array(await served.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
    assert.equal(bytes.length, document.size);

    const [entry] = documentsIn(env);
    assert.equal(entry?.actor, "agent:lead");
    assert.equal(entry?.studyId, "ontario");
    assert.equal(entry?.audience, null);
    assert.deepEqual(entry?.data, {
      sha256: document.id,
      url: document.url,
      kind: "report",
      title: "TPAP brief",
      size: document.size,
      pages: document.pages,
      sections: 3,
      cites: [{ contextId: "ibc", pages: [1, 2] }],
    });
  });

  it("makes slides, five points to a slide at most, with a title slide and a sources slide", async () => {
    const env = await fresh();
    const points = Array.from({ length: 7 }, (_, i) => `Point ${i + 1}`);
    const response = await env.call("POST", "/v1/studies/ontario/documents", "planner-token", {
      kind: "slides",
      title: "TPAP slides",
      sections: [{ heading: "Need and justification", points: [CITED, ...points.slice(1)] }],
    });
    assert.equal(response.status, 201, await response.clone().text());
    const document = (await response.json()) as DocumentView;
    // A title slide, two for the seven points, and the sources.
    assert.equal(document.pages, 4);
    const bytes = new Uint8Array(await (await env.call("GET", document.url)).arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    assert.match(text, /\/MediaBox \[0 0 960 540\]/);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  });

  it("refuses a point whose quote isn't on its page, saying which, and keeps nothing", async () => {
    const env = await fresh();
    const wrong = { ...BRIEF, sections: [{ heading: "Need", points: [{ text: "Riders", citation: { contextId: "ibc", page: 2, quote: "388,000 daily riders by 2041" } }] }] };
    const response = await env.call("POST", "/v1/studies/ontario/documents", "agent-token", wrong);
    assert.equal(response.status, 422);
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(error.code, "quote_not_found");
    assert.match(error.message, /^Section "Need", point 1: Quote not found on page 2 of "ibc"\. Quote the page word for word/);
    assert.deepEqual(documentsIn(env), []);
    assert.deepEqual(readdirSync(join(env.dir, "media")), []);
  });

  it("refuses a page cite in a point's words that names no such page or source", async () => {
    const env = await fresh();
    const page = await env.call("POST", "/v1/studies/ontario/documents", "agent-token", { ...BRIEF, sections: [{ heading: "Need", points: ["Riders (ibc p. 9)"] }] });
    assert.equal(page.status, 422);
    assert.match(((await page.json()) as { error: { message: string } }).error.message, /point 1: "ibc" has no page 9/);
    const source = await env.call("POST", "/v1/studies/ontario/documents", "agent-token", { ...BRIEF, sections: [{ heading: "Need", points: ["Riders (made-up p. 1)"] }] });
    assert.equal(source.status, 422);
    assert.equal(((await source.json()) as { error: { code: string } }).error.code, "unknown_source");
  });

  it("checks the shape: a kind it knows, a title and sections of points", async () => {
    const env = await fresh();
    const post = (body: unknown) => env.call("POST", "/v1/studies/ontario/documents", "agent-token", body);
    assert.equal((await post({ ...BRIEF, kind: "memo" })).status, 400);
    assert.equal((await post({ ...BRIEF, title: "" })).status, 400);
    assert.equal((await post({ ...BRIEF, sections: [] })).status, 400);
    assert.equal((await post({ ...BRIEF, sections: [{ heading: "Need", points: [] }] })).status, 400);
    assert.equal((await env.call("POST", "/v1/studies/nowhere/documents", "agent-token", BRIEF)).status, 404);
    // Agents and planners make documents; nobody else.
    assert.equal((await env.call("POST", "/v1/studies/ontario/documents", "viewer-token", BRIEF)).status, 403);
    assert.equal((await env.call("POST", "/v1/studies/ontario/documents", "integration-token", BRIEF)).status, 403);
    assert.equal((await env.call("POST", "/v1/studies/ontario/documents", undefined, BRIEF)).status, 401);
    assert.deepEqual(documentsIn(env), []);
  });

  it("keeps a visitor's document in their sandbox: only they see it, and its file is served privately", async () => {
    const env = await fresh();
    const pass = async () => ((await (await env.call("POST", "/v1/guests")).json()) as { token: string }).token;
    const [a, b] = [await pass(), await pass()];
    const audience = `guest:${a.split(".")[1]}`;
    const response = await env.call("POST", "/v1/studies/ontario/documents", "agent-token", BRIEF, { "x-on-behalf-of": audience });
    assert.equal(response.status, 201, await response.clone().text());
    const document = (await response.json()) as DocumentView;

    const [entry] = documentsIn(env);
    assert.equal(entry?.audience, audience);
    assert.equal(env.service.state.documents.has(document.id), false);
    const sees = async (token: string) => {
      const log = (await (await env.call("GET", "/v1/log?limit=1000", token)).json()) as { type: string }[];
      return log.some((e) => e.type === "document.created");
    };
    assert.equal(await sees(a), true);
    assert.equal(await sees(b), false);
    assert.equal(await sees("planner-token"), false);
    assert.equal(await sees("viewer-token"), false);
    // Whoever has its hash, which only the visitor's sandbox shows, reads it privately.
    const served = await env.call("GET", document.url);
    assert.equal(served.status, 200);
    assert.match(served.headers.get("cache-control") ?? "", /^private/);
  });

  it("is an MCP tool for agents, whose refusal says what to fix", async () => {
    const env = await fresh();
    const server = serve({ fetch: env.app.fetch, port: 0, hostname: "127.0.0.1" });
    await once(server, "listening");
    const client = new Client({ name: "test", version: "1.0.0" });
    try {
      const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer agent-token" } } }));
      const tool = (await client.listTools()).tools.find((t) => t.name === "create_document");
      assert.deepEqual(tool?.inputSchema.required, ["studyId", "kind", "title", "sections"]);
      const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "create_document", arguments: args })) as CallToolResult;
      const bad = await call({ studyId: "ontario", ...BRIEF, sections: [{ heading: "Need", points: [{ text: "x", citation: { ...CITED.citation, quote: "400,000 riders" } }] }] });
      assert.equal(bad.isError, true);
      assert.match((bad.content[0] as { text: string }).text, /^422 quote_not_found: Section "Need", point 1/);
      const good = await call({ studyId: "ontario", ...BRIEF, kind: "slides" });
      assert.equal(good.isError, undefined);
      assert.equal((good.structuredContent as DocumentView).kind, "slides");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("writes text the built-in fonts can draw", () => {
    assert.equal(printable("Don Mills → Sheppard, ≥ 5 min — “fast” now"), "Don Mills to Sheppard, >= 5 min — “fast” now");
    assert.equal(printable("Line 5 🚇 opens"), "Line 5 opens");
  });

  it("labels every document a draft", () => {
    assert.equal(DOCUMENT_LABEL, "Draft first pass for planners, not a final answer");
  });
});
