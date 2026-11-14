import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NeedView, StudyView } from "@transit-agents/contracts";
import { createApp, type Actor } from "./app.ts";
import { issueGuest } from "./guests.ts";
import { GIS_SKILL_TOOLS } from "./gis-skills.ts";
import { NOT_TOOLS, TOOLS } from "./mcp.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);

const PAGE = "Weekly ridership rose by 1,680 customers in the first month.";
const FIGURE = {
  id: "riders",
  label: "Weekly riders",
  value: 1680,
  basis: { kind: "cited", citation: { contextId: "plan", page: 1, quote: "ridership rose by 1,680 customers" } },
};
const PLANNER_ONLY = ["accept_figure", "approve_skill", "rate_finding", "record_decision", "remove_content", "request_engagement_media", "set_rule"];
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
};

const GUEST_SECRET = "a-guest-secret-of-at-least-32-characters";
// A visitor the lead agent acts for.
const VISITOR = { "x-on-behalf-of": `guest:${"A".repeat(22)}` };

// The app on an ephemeral port, seeded through the API the way app.test.ts does.
// With guests, it is a public demo that gives out guest passes.
async function start({ publicUrl, openAccess = false, guests = false }: { publicUrl?: string; openAccess?: boolean; guests?: boolean } = {}) {
  const service = new Service(":memory:");
  const webhooks = new Webhooks(service, "https://example.test", async () => new Response("ok"));
  const app = createApp({
    service,
    webhooks,
    tokens: TOKENS,
    access: openAccess ? "open" : guests ? "demo" : "token",
    publicUrl,
    visitorAgents: ["lead"],
    ...(guests ? { guests: { secret: GUEST_SECRET } } : {}),
  });
  const call = (method: string, path: string, token: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  await call("POST", "/v1/context", "planner-token", { id: "plan", title: "Plan", pages: [{ page: 1, text: PAGE }] });
  await call("POST", "/v1/studies", "agent-token", { id: "lawrence", title: "Lawrence–Sunnybrook" });

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await once(server, "listening");
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mcp`);
  const clients: Client[] = [];
  const connect = async (token?: string, extra: Record<string, string> = {}) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const headers = token ? { authorization: `Bearer ${token}`, ...extra } : undefined;
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    clients.push(client);
    return client;
  };
  // A raw MCP request, for what the SDK client doesn't let a test set. It gives up
  // after 2 seconds, so a request that never gets an answer fails the test.
  const post = async (headers: Record<string, string>, message: unknown = INITIALIZE) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(2000),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  const stop = async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    webhooks.stop();
  };
  return { service, url, connect, post, stop };
}

// A page's POST to its own origin, with the Host a browser sends, which fetch can't
// set. After DNS rebinding, the host is the attacker's name.
const postFromPage = (url: URL, host: string, message: unknown) =>
  new Promise<number>((resolve, reject) => {
    const headers = { host, origin: `http://${host}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    request(url, { method: "POST", headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on("error", reject)
      .end(JSON.stringify(message));
  });

const callTool = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

const textOf = (result: CallToolResult) => (result.content[0] as { text: string }).text;

describe("mcp", () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start();
  });
  afterEach(() => env.stop());

  it("tells a model the rules when it connects", async () => {
    const instructions = (await env.connect("agent-token")).getInstructions() ?? "";
    assert.match(instructions, /Find pages with search_sources/);
    assert.match(instructions, /read_page before citing/);
    assert.match(instructions, /only from list_rules/);
    assert.match(instructions, /Only planners decide/);
    assert.match(instructions, /add_engagement_need\. Only a planner asks for it to be made/);
    // A model can't see its own token counts, so the agent's code reports them.
    assert.match(instructions, /never report usage numbers you weren't given/);
  });

  it("lists only the tools each role may call", async () => {
    const names = async (token: string) => (await (await env.connect(token)).listTools()).tools.map((tool) => tool.name);
    const [planner, agent, integration, viewer] = await Promise.all(
      ["planner-token", "agent-token", "integration-token", "viewer-token"].map(names),
    );
    // 52 and 43 with the safety and active transportation tools; the equity, jobs and stop
    // accessibility skills each add their GIS tools for agents and planners too.
    const skills = Object.keys(GIS_SKILL_TOOLS).length;
    assert.equal(planner?.length, 52 + skills);
    assert.equal(agent?.length, 43 + skills);
    assert.ok(["route_stops", "buffer", "overlay", "points_within", "summarise_layer"].every((name) => agent?.includes(name)));
    assert.ok(agent?.includes("propose_alignment"));
    assert.ok(agent?.includes("create_document") && planner?.includes("create_document"));
    assert.ok(!integration?.includes("create_document") && !viewer?.includes("create_document"));
    assert.ok(agent?.includes("whoami"));
    assert.deepEqual(agent?.filter((name) => PLANNER_ONLY.includes(name)), []);
    assert.ok(agent?.includes("record_figure") && agent.includes("report_activity"));
    assert.equal(integration?.length, 21);
    assert.ok(integration?.includes("add_source") && !integration.includes("record_figure"));
    assert.equal(viewer?.length, 20);
    assert.ok(viewer?.includes("list_layers") && !viewer.includes("overlay"));
    assert.ok(viewer?.includes("read_page") && !viewer.includes("add_source"));
    for (const names of [planner, agent, integration, viewer]) assert.ok(names?.includes("search_sources"));
  });

  it("finds the page that mentions something, and needs a query", async () => {
    const client = await env.connect("agent-token");
    const tool = (await client.listTools()).tools.find((t) => t.name === "search_sources");
    assert.deepEqual(tool?.inputSchema.required, ["q"]);
    const found = await callTool(client, "search_sources", { q: "riders", limit: 5 });
    assert.deepEqual(found.structuredContent, {
      results: [{ contextId: "plan", title: "Plan", page: 1, snippet: "Weekly [ridership] rose by 1,680 customers in the first month.", citable: true }],
    });
    const missing = await callTool(client, "search_sources", {});
    assert.equal(missing.isError, true);
    assert.equal(textOf(missing), "400 invalid_query: Say what to look for in q");
  });

  it("reads a page", async () => {
    const result = await callTool(await env.connect("agent-token"), "read_page", { contextId: "plan", page: 1 });
    assert.deepEqual(JSON.parse(textOf(result)), { text: PAGE });
    assert.deepEqual(result.structuredContent, { text: PAGE });
  });

  it("records a cited figure as the caller, and shows it in the study", async () => {
    const client = await env.connect("agent-token");
    const recorded = await callTool(client, "record_figure", { studyId: "lawrence", ...FIGURE });
    assert.equal(recorded.isError, undefined);
    const study = (await callTool(client, "get_study", { studyId: "lawrence" })).structuredContent as StudyView;
    assert.equal(study.figures[0]?.value, 1680);
    assert.equal(study.figures[0]?.recordedBy, "agent:lead");
  });

  it("returns the API's reason when a quote isn't on the page", async () => {
    const result = await callTool(await env.connect("agent-token"), "record_figure", {
      studyId: "lawrence",
      ...FIGURE,
      basis: { kind: "cited", citation: { contextId: "plan", page: 1, quote: "ridership fell by 1,680 customers" } },
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), '422 quote_not_found: Quote not found on page 1 of "plan"');
    assert.equal(env.service.log.since(0).at(-1)?.type, "figure.rejected");
  });

  it("refuses a decision from an agent that calls the tool by name", async () => {
    const result = await callTool(await env.connect("agent-token"), "record_decision", {
      studyId: "lawrence",
      outcome: "adopt",
      reason: "Passes the tests",
      decidedBy: "Ana Ruiz",
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "403 forbidden: This needs a planner token, not agent");
    assert.equal(env.service.state.studies.get("lawrence")?.decisions.length, 0);
  });

  it("lets an agent propose an engagement need, and only a planner ask for it to be made", async () => {
    const agent = await env.connect("agent-token");
    const need = {
      studyId: "lawrence",
      id: "poster",
      title: "Engagement poster",
      place: "Sunnybrook Hospital",
      lon: -79.375262,
      lat: 43.722663,
      kinds: ["image"],
      reason: "More riders are on the way.",
      citations: [FIGURE.basis.citation],
    };
    const added = await callTool(agent, "add_engagement_need", need);
    assert.equal(added.isError, undefined);
    assert.equal((added.structuredContent as NeedView).status, "needed");
    const refused = await callTool(agent, "request_engagement_media", { studyId: "lawrence", need: "poster" });
    assert.equal(textOf(refused), "403 forbidden: This needs a planner or guest token, not agent");
    const planner = await env.connect("planner-token");
    const ask = () => callTool(planner, "request_engagement_media", { studyId: "lawrence", need: "poster" });
    const first = await ask();
    assert.equal((first.structuredContent as NeedView).status, "creating");
    assert.deepEqual((await ask()).structuredContent, first.structuredContent);
    assert.equal(env.service.log.since(0).filter((entry) => entry.type === "need.create.requested").length, 1);
    const study = (await callTool(agent, "get_study", { studyId: "lawrence" })).structuredContent as StudyView;
    assert.equal(study.needs[0]?.status, "creating");

    // Only the media agent's own code takes a request on or says it failed, so no
    // model can close a planner's request. After a failure, a planner asks again.
    const names = (await agent.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.filter((name) => /claim|fail/.test(name)), []);
    const claim = { claim: "claim-of-the-media-agent" };
    env.service.claimCreation("agent:media", "lawrence", "poster", claim);
    env.service.failCreation("agent:media", "lawrence", "poster", { reason: "image: the image model made no image", ...claim });
    assert.equal((await ask()).structuredContent?.status, "creating");
    assert.equal(env.service.log.since(0).filter((entry) => entry.type === "need.create.requested").length, 2);
  });

  it("asks a model for where a need is, which kinds it wants and why", async () => {
    const tools = (await (await env.connect("agent-token")).listTools()).tools;
    const schema = tools.find((tool) => tool.name === "add_engagement_need")?.inputSchema;
    assert.deepEqual(schema?.required, ["studyId", "id", "title", "place", "lon", "lat", "kinds", "reason"]);
    assert.deepEqual((schema?.properties?.kinds as { items: unknown }).items, { type: "string", enum: ["image", "video"] });
  });

  it("returns an error for an unknown tool", async () => {
    const client = await env.connect("planner-token");
    await assert.rejects(
      client.callTool({ name: "launch_rockets", arguments: {} }),
      (error) => error instanceof McpError && error.code === ErrorCode.InvalidParams && /Unknown tool: launch_rockets/.test(error.message),
    );
  });

  it("turns away a caller with no token", async () => {
    await assert.rejects(env.connect());
  });

  it("says why it refused a request, as a JSON-RPC error an MCP client reads", async () => {
    const refusal = async (headers: Record<string, string>) => {
      const { status, body } = await env.post(headers);
      return { status, ...JSON.parse(body) };
    };
    assert.deepEqual(await refusal({ authorization: "Bearer wrong" }), {
      status: 401,
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "401 bad_token: Unknown token" },
    });
    assert.equal((await refusal({})).error.message, "401 token_required: A token is required");
    assert.equal(
      (await refusal({ authorization: "Bearer agent-token", origin: "https://attacker.example" })).error.message,
      "403 forbidden_origin: Requests from https://attacker.example are not allowed",
    );
  });

  it("refuses a page on another site, and allows its own origin or none", async () => {
    const agent = { authorization: "Bearer agent-token" };
    assert.equal((await env.post({ ...agent, origin: "https://attacker.example" })).status, 403);
    assert.equal((await env.post(agent)).status, 200);
    assert.equal((await env.post({ ...agent, origin: env.url.origin })).status, 200);
  });

  it("refuses a page that DNS rebinding points here, even with open access", async () => {
    const open = await start({ openAccess: true });
    try {
      const decide = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "record_decision", arguments: { studyId: "lawrence", outcome: "reject", reason: "Rebound", decidedBy: "attacker" } },
      };
      assert.equal(await postFromPage(open.url, `rebind.attacker.example:${open.url.port}`, decide), 403);
      assert.equal(open.service.state.studies.get("lawrence")?.decisions.length, 0);
      // The service's own page, at localhost or an IP address, is still allowed.
      assert.equal(await postFromPage(open.url, `localhost:${open.url.port}`, INITIALIZE), 200);
      assert.equal(await postFromPage(open.url, `[::1]:${open.url.port}`, INITIALIZE), 200);
    } finally {
      await open.stop();
    }
  });

  it("also allows the public URL's origin", async () => {
    const proxied = await start({ publicUrl: "https://transit.example/display" });
    try {
      const agent = { authorization: "Bearer agent-token" };
      assert.equal((await proxied.post({ ...agent, origin: "https://transit.example" })).status, 200);
      assert.equal((await proxied.post({ ...agent, origin: "https://attacker.example" })).status, 403);
    } finally {
      await proxied.stop();
    }
  });

  it("keeps no sessions or streams", async () => {
    const initialized = await env.post({ authorization: "Bearer agent-token" });
    assert.equal(initialized.headers.get("mcp-session-id"), null);
    const stream = await fetch(env.url, { headers: { authorization: "Bearer agent-token", accept: "text/event-stream" } });
    assert.equal(stream.status, 405);
    assert.equal(stream.headers.get("allow"), "POST");
    assert.equal((await stream.json()).error.message, "405 method_not_allowed: Send MCP messages with POST");
  });

  it("answers each message, though an Idempotency-Key repeats", async () => {
    const headers = { authorization: "Bearer agent-token", "idempotency-key": "K-1" };
    await env.post(headers, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_log_head", arguments: {} } });
    const second = await env.post(headers, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(JSON.parse(second.body).id, 2);
    assert.equal(second.headers.get("idempotent-replay"), null);
  });

  it("answers a batch that cancels its own tool call", async () => {
    const before = env.service.log.head().seq;
    const { status, body } = await env.post({ authorization: "Bearer agent-token" }, [
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "report_activity", arguments: { studyId: "lawrence", kind: "message", text: "Cancelled" } } },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
    ]);
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).id, 7);
    assert.equal(env.service.log.head().seq, before + 1);
  });
});

describe("mcp for visitors", () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start({ guests: true });
  });
  afterEach(() => env.stop());

  it("runs each tool call in the sandbox of the visitor the session acts for", async () => {
    const forVisitor = await env.connect("agent-token", VISITOR);
    const recorded = await callTool(forVisitor, "record_figure", { studyId: "lawrence", ...FIGURE });
    assert.equal(recorded.isError, undefined);
    assert.equal(env.service.log.head().seq, env.service.log.since(0, 1000, VISITOR["x-on-behalf-of"]).at(-1)?.seq);
    const figures = async (client: Client) => ((await callTool(client, "get_study", { studyId: "lawrence" })).structuredContent as StudyView).figures;
    assert.equal((await figures(forVisitor))[0]?.value, 1680);
    assert.deepEqual(await figures(await env.connect("agent-token")), []);
    assert.deepEqual(await figures(await env.connect("planner-token")), []);
    // What is left of the budget, for the visitor it acts for.
    assert.deepEqual((await callTool(forVisitor, "get_budget", {})).structuredContent, { capped: false });
  });

  it("reads every visitor's entries for everyone, and writes nothing", async () => {
    await callTool(await env.connect("agent-token", VISITOR), "report_activity", { studyId: "lawrence", kind: "message", text: "For a visitor" });
    const everyone = await env.connect("agent-token", { "x-on-behalf-of": "*" });
    assert.match(textOf(await callTool(everyone, "read_log", { limit: 1000 })), /For a visitor/);
    assert.doesNotMatch(textOf(await callTool(await env.connect("agent-token"), "read_log", { limit: 1000 })), /For a visitor/);
    // Its head is the newest entry of all, for a listener to read on from. Anyone
    // else's stays at the shared record's.
    const head = env.service.log.head();
    assert.notDeepEqual(env.service.log.headFor(null), head);
    assert.deepEqual((await callTool(everyone, "get_log_head", {})).structuredContent, head);
    assert.deepEqual((await callTool(await env.connect("agent-token"), "get_log_head", {})).structuredContent, env.service.log.headFor(null));
    const refused = await callTool(everyone, "report_activity", { studyId: "lawrence", kind: "message", text: "For everyone" });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /^400 read_only: /);
    assert.deepEqual(env.service.log.head(), head);
  });

  it("refuses the header from anyone but the service's own agents", async () => {
    const { token } = issueGuest(GUEST_SECRET, new Date());
    for (const caller of [token, "planner-token"]) {
      const { status, body } = await env.post({ authorization: `Bearer ${caller}`, ...VISITOR });
      assert.equal(status, 403);
      assert.match(JSON.parse(body).error.message, /^403 forbidden: /);
    }
  });

  it("lets a visitor do what a planner does but decide, with a guest pass", async () => {
    const { token } = issueGuest(GUEST_SECRET, new Date());
    const guest = await env.connect(token);
    const names = (await guest.listTools()).tools.map((t) => t.name);
    assert.ok(["get_study", "report_activity", "rate_finding", "accept_figure", "set_rule", "request_engagement_media", "get_budget"].every((name) => names.includes(name)));
    assert.deepEqual(names.filter((name) => ["record_decision", "record_figure", "add_source", "open_study", "approve_skill", "remove_content"].includes(name)), []);
    const decided = await callTool(guest, "record_decision", { studyId: "lawrence", outcome: "adopt", reason: "Passes the tests", decidedBy: "A visitor" });
    assert.equal(textOf(decided), "403 sign_in_required: Only planners decide. Sign in to decide.");
    assert.equal((await callTool(guest, "report_activity", { studyId: "lawrence", kind: "message", text: "Hello" })).isError, undefined);
    assert.equal(env.service.state.studies.get("lawrence")?.decisions.length, 0);
  });
});

describe("mcp drift", () => {
  it("makes every /v1 route a tool, or says why it isn't one", () => {
    const service = new Service(":memory:");
    const app = createApp({ service, webhooks: new Webhooks(service), tokens: TOKENS, access: "token" });
    const routes = app.routes
      .filter((route) => route.path.startsWith("/v1/") && !route.path.endsWith("*"))
      .map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(
      routes.filter((key) => !(key in TOOLS) && !(key in NOT_TOOLS)),
      [],
    );
    assert.deepEqual(
      Object.keys({ ...TOOLS, ...NOT_TOOLS }).filter((key) => !routes.includes(key)),
      [],
    );
    const names = Object.values(TOOLS).map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(TOOLS["GET /v1/budget"]?.name, "get_budget");
    assert.ok(NOT_TOOLS["POST /v1/guests"]);
  });
});

describe("README's MCP section", () => {
  const readme = readFileSync(join(import.meta.dirname, "../../../README.md"), "utf8");
  const prose = readme.slice(readme.indexOf("Python agents can connect over MCP")).replace(/\s+/g, " ");
  const python = readme.match(/```python\n([\s\S]*?)```/)?.[1] ?? "";

  it("says which routes aren't tools", () => {
    assert.match(prose, /Every route except the event stream, webhook subscriptions, guest passes, page views, and file uploads and downloads is a tool/);
  });

  it("holds the Gemini client open while it runs", () => {
    // google-genai closes a client's connections once nothing holds the client, so a
    // call on a temporary genai.Client() fails before it reaches Gemini.
    assert.doesNotMatch(python, /genai\.Client\(\)\.aio\.models/);
    assert.match(python, /genai\.Client\(\)\.aio as gemini/);
  });

  it("warns off the chat API and the sync client, which fail with an MCP session", () => {
    const comments = python.replace(/\s*#\s*/g, " ");
    assert.match(comments, /A GenerateContentConfig or the chat API copies the config, which fails with a live session/);
    assert.match(comments, /the sync client refuses MCP sessions/);
  });

  it("runs the tool loop itself, and reports each model call's tokens", async () => {
    // google-genai's own loop returns only the last call's usage and stops after 10
    // calls, and a model can't see its tokens.
    assert.match(python, /"automatic_function_calling": \{"disable": True\}/);
    const loop = python.slice(python.indexOf("for _ in range("));
    assert.ok(loop.indexOf("generate_content") < loop.indexOf('call_tool("report_activity"'));
    assert.match(loop, /usage_metadata[\s\S]*"kind": "usage"/);
    assert.match(loop, /else:\s+print\("Stopped after/);
    // Every tool it calls by name is an agent's, with arguments that tool takes.
    const env = await start();
    try {
      const tools = (await (await env.connect("agent-token")).listTools()).tools;
      const calls = [...python.matchAll(/call_tool\("(\w+)", \{([^}]*)\}/g)];
      assert.deepEqual(
        calls.map(([, name]) => name),
        ["open_study", "report_activity"],
      );
      for (const [, name, args = ""] of calls) {
        const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
        for (const [, key = ""] of args.matchAll(/"(\w+)":/g)) assert.ok(key in properties, `${name} takes no "${key}"`);
      }
    } finally {
      await env.stop();
    }
  });
});
