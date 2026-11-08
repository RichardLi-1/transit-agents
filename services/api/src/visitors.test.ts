// The privacy sweep: one visitor works in their sandbox, with an agent acting for
// them, and nobody else can find any of it, through any read the service offers.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp, type Actor } from "./app.ts";
import { VisitorBudget } from "./budget.ts";
import { VisitorLimits } from "./limits.ts";
import { TOOLS } from "./mcp.ts";
import { padded, SAMPLE } from "./sample-media.ts";
import { Service } from "./service.ts";
import { buildTimeline } from "./timeline.ts";
import { Webhooks } from "./webhooks.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
]);

const PAGE = "Service on the 52F Lawrence West would be extended to Sunnybrook Hospital, adding 1,680 weekly riders.";
const CITATION = { contextId: "plan", page: 1, quote: "adding 1,680 weekly riders" };

// A slug no one has used, as long as `like`.
const madeUp = (like: string) => `z${randomBytes(like.length).toString("hex").slice(0, like.length - 1)}`;

describe("visitors' privacy", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-sweep-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const canary = `canary${randomBytes(8).toString("hex")}`;
  const deliveries: string[] = [];
  const service = new Service(":memory:", { mediaDir: join(dir, "media"), budget: new VisitorBudget() });
  const webhooks = new Webhooks(service, "https://example.test", (async (_url: string, init: RequestInit) => {
    deliveries.push(init.body as string);
    return new Response("ok");
  }) as unknown as typeof fetch);
  const app = createApp({
    service,
    webhooks,
    tokens: TOKENS,
    access: "demo",
    webhookHosts: ["hook.test"],
    guests: { secret: "a-guest-secret-of-at-least-32-characters" },
    limits: new VisitorLimits({ perMinute: 1000 }),
    visitorAgents: ["lead"],
    timeline: (id, view) => buildTimeline(view, { reliability: () => [] } as never, id),
  });
  after(() => webhooks.stop());

  type Who = { name: string; token?: string; headers?: Record<string, string> };
  const request = (who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(who.token ? { authorization: `Bearer ${who.token}` } : {}), "content-type": "application/json", ...who.headers, ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const ok = async (response: Response | Promise<Response>) => {
    const answer = await response;
    assert.ok(answer.ok, `${answer.status} ${await answer.clone().text()}`);
    return answer;
  };

  const planner: Who = { name: "a planner", token: "planner-token" };
  const lead: Who = { name: "the lead agent", token: "agent-token" };
  const integration: Who = { name: "an integration", token: "integration-token" };
  let a: Who;
  let b: Who;
  let aId: string;
  let observers: Who[];
  // A's own ids, none of them holding the canary, so a refusal that names one
  // shows only what the caller sent.
  const ids = { figure: `fig${randomBytes(4).toString("hex")}`, need: `need${randomBytes(4).toString("hex")}`, finding: `find${randomBytes(4).toString("hex")}` };
  // A whole PNG of A's own: its private chunk a length nobody else's has.
  const png = padded(SAMPLE.png, SAMPLE.png.length + 12 + 16 + (randomBytes(1)[0] as number));
  const sha = createHash("sha256").update(png).digest("hex");
  let before_: unknown;
  // The log position before A's work, to compare from.
  let from = 0;

  // What nobody but A may see.
  const secrets = () => [canary, sha, aId];
  const leaks = (text: string) => secrets().filter((secret) => text.includes(secret));

  before(async () => {
    // The shared record: a study with a figure, a forecast that rests on a rule,
    // a check, a finding and a need.
    await ok(request(integration, "POST", "/v1/context", { id: "plan", title: "2026 Plan", pages: [{ page: 1, text: PAGE }] }));
    await ok(request(lead, "POST", "/v1/studies", { id: "lawrence", title: "Lawrence–Sunnybrook", project: ["forecast", ids.figure] }));
    await ok(request(planner, "PUT", "/v1/assumptions/growth", { value: 1, reason: "No growth" }));
    await ok(request(planner, "PUT", "/v1/assumptions/min-riders", { value: 2000, reason: "The service standard" }));
    await ok(request(lead, "POST", "/v1/studies/lawrence/figures", { id: "riders", label: "Weekly riders", value: 1680, basis: { kind: "cited", citation: CITATION } }));
    await ok(
      request(lead, "POST", "/v1/studies/lawrence/figures", {
        id: "forecast",
        label: "Forecast riders",
        basis: { kind: "derived", formula: "riders * growth", inputs: { riders: { figure: "riders" }, growth: { assumption: "growth" } } },
      }),
    );
    await ok(request(lead, "POST", "/v1/studies/lawrence/checks", { id: "enough", label: "Enough riders", figure: "forecast", op: ">=", threshold: { assumption: "min-riders" } }));
    await ok(request(lead, "POST", "/v1/studies/lawrence/findings", { id: "survey", label: "Survey", text: "Riders asked for it.", tone: "positive", citation: CITATION }));
    const need = { title: "Engagement poster", place: "Sunnybrook Hospital", lon: -79.375262, lat: 43.722663, kinds: ["image"], reason: "Riders can ride to the hospital.", citations: [CITATION] };
    await ok(request(lead, "POST", "/v1/studies/lawrence/needs", { id: "poster", ...need }));
    await ok(request(integration, "POST", "/v1/subscriptions", { url: "https://hook.test/x", types: ["*"] }));

    const pass = async () => (await (await ok(request({ name: "anyone" }, "POST", "/v1/guests"))).json()).token as string;
    a = { name: "visitor A", token: await pass() };
    b = { name: "visitor B", token: await pass() };
    aId = (a.token as string).split(".")[1] as string;
    const forA: Who = { name: "the lead agent for A", token: "agent-token", headers: { "x-on-behalf-of": `guest:${aId}` } };
    observers = [
      b,
      { name: "no token" },
      planner,
      lead,
      { name: "the lead agent for B", token: "agent-token", headers: { "x-on-behalf-of": `guest:${(b.token as string).split(".")[1]}` } },
    ];
    before_ = structuredClone(service.state);
    from = service.log.head().seq;

    // A's own work, and the agent's for A.
    await ok(request(a, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: `Hello ${canary}` }));
    await ok(request(a, "PUT", "/v1/assumptions/growth", { value: 2, reason: `Growth ${canary}` }));
    await ok(request(a, "PUT", "/v1/studies/lawrence/findings/survey/tone", { tone: "negative" }));
    await ok(request(a, "POST", "/v1/studies/lawrence/needs/poster/create"));
    await ok(request(forA, "POST", "/v1/studies/lawrence/figures", { id: ids.figure, label: `Riders ${canary}`, value: 1680, basis: { kind: "cited", citation: CITATION } }));
    await ok(request(forA, "POST", "/v1/studies/lawrence/needs", { id: ids.need, ...need, title: `Poster ${canary}` }));
    await ok(request(forA, "POST", "/v1/studies/lawrence/findings", { id: ids.finding, label: "Visitor", text: `Said ${canary}`, tone: "mixed", citation: CITATION }));
    await ok(request(forA, "POST", "/v1/studies/lawrence/activity", { kind: "usage", model: "gemini-3-flash", inputTokens: 1000, outputTokens: 100, costUsd: 0.01 }));
    // The media agent takes A's request on, then sends the file with its claim.
    const claim = "claim-of-the-lead-agent-for-a";
    await ok(request(forA, "POST", "/v1/studies/lawrence/needs/poster/claim", { claim }));
    const form = new FormData();
    for (const [name, value] of Object.entries({ claim, kind: "image", model: "gemini-3.1-flash-image", prompt: `A poster ${canary}`, inputs: "[]" })) form.set(name, value);
    form.set("file", new Blob([png.slice()], { type: "image/png" }), "poster.png");
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    const sent = { "content-type": encoded.headers.get("content-type") as string, "content-length": String(body.length) };
    await ok(app.request("/v1/studies/lawrence/needs/poster/media", { method: "POST", headers: { authorization: "Bearer agent-token", ...sent, ...forA.headers }, body }));
  });

  it("leaves the shared record as it was", () => {
    assert.deepEqual(service.state, before_);
  });

  // Every GET route, its path filled from the shared record, and from A's ids.
  async function reads(): Promise<{ path: string; named?: string }[]> {
    const spec = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, Record<string, unknown>> };
    const out: { path: string; named?: string }[] = [];
    const queries: Record<string, string> = {
      "/v1/search": `?q=${canary}`,
      "/v1/log": "?limit=1000",
      "/v1/studies/{id}/compare": `?from=${from}`,
      "/v1/live/vehicles": "?routes=52",
    };
    for (const [template, operations] of Object.entries(spec.paths)) {
      if (!operations.get || template === "/v1/events") continue;
      const query = queries[template] ?? "";
      const id = template.startsWith("/v1/context") ? "plan" : "lawrence";
      const fill = (figure: string, mediaId = id) =>
        template
          .replace("{id}", template.startsWith("/v1/media") ? mediaId : id)
          .replace("{page}", "1")
          .replace("{figure}", figure);
      out.push({ path: fill("riders") + query });
      if (template.includes("{figure}")) out.push({ path: fill(ids.figure) + query, named: ids.figure });
      if (template.startsWith("/v1/media")) for (const own of Object.values(ids)) out.push({ path: fill("riders", own), named: own });
    }
    if (out.length < 20) throw new Error("Too few routes to sweep");
    return out;
  }

  // The same request, naming a made-up id instead of A's, gets the same answer.
  async function sameAsMadeUp(who: Who, method: string, path: string, named: string, body?: unknown) {
    const real = await request(who, method, path, body);
    const fake = madeUp(named);
    const fakePath = path.replaceAll(named, fake);
    const fakeBody = body === undefined ? undefined : JSON.parse(JSON.stringify(body).replaceAll(named, fake));
    const other = await request(who, method, fakePath, fakeBody);
    assert.equal(real.status, other.status, `${who.name}: ${method} ${path}`);
    assert.equal(await real.text(), (await other.text()).replaceAll(fake, named), `${who.name}: ${method} ${path}`);
  }

  it("shows nobody else A's work through any GET route", async () => {
    for (const who of observers) {
      for (const { path, named } of await reads()) {
        const response = await request(who, "GET", path);
        const text = await response.text();
        assert.deepEqual(leaks(text), [], `${who.name}: GET ${path}`);
        if (named) await sameAsMadeUp(who, "GET", path, named);
      }
    }
  });

  it("shows nobody else A's work in a preview, or in a write that names A's work", async () => {
    for (const who of observers) {
      const preview = await request(who, "POST", "/v1/studies/lawrence/preview", { assumptions: { growth: 3 } });
      assert.equal(preview.status, 200, who.name);
      assert.deepEqual(leaks(await preview.text()), [], who.name);
      await sameAsMadeUp(who, "POST", "/v1/studies/lawrence/preview", ids.figure, { figures: { [ids.figure]: 1 } });
    }
    for (const who of [b, planner]) {
      const head = service.log.head();
      await sameAsMadeUp(who, "PUT", `/v1/studies/lawrence/findings/${ids.finding}/tone`, ids.finding, { tone: "positive" });
      await sameAsMadeUp(who, "POST", `/v1/studies/lawrence/needs/${ids.need}/create`, ids.need);
      await sameAsMadeUp(who, "POST", `/v1/studies/lawrence/figures/${ids.figure}/accept`, ids.figure);
      await sameAsMadeUp(who, "POST", `/v1/studies/lawrence/needs/${ids.need}/dismiss`, ids.need, { reason: "Not wanted" });
      await sameAsMadeUp(who, "POST", `/v1/studies/lawrence/needs/poster/media/${sha}/withdraw`, sha, { reason: "Not wanted" });
      assert.deepEqual(service.log.head(), head, who.name);
    }
    // An agent acting for B, taking on A's need.
    const forB = observers.at(-1) as Who;
    const head = service.log.head();
    await sameAsMadeUp(forB, "POST", `/v1/studies/lawrence/needs/${ids.need}/claim`, ids.need, { claim: "claim-of-the-lead-agent-for-b" });
    assert.deepEqual(service.log.head(), head);
  });

  it("streams nobody else A's work, as it happens", async () => {
    let n = 0;
    for (const who of observers) {
      n += 1;
      const controller = new AbortController();
      const response = await app.request("/v1/events", {
        headers: { ...(who.token ? { authorization: `Bearer ${who.token}` } : {}), ...who.headers },
        signal: controller.signal,
      });
      assert.equal(response.status, 200, who.name);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const marker = `Shared ${n}`;
      await ok(request(a, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: `Again ${canary}` }));
      await ok(request(lead, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: marker }));
      let text = "";
      const deadline = Date.now() + 3000;
      while (!text.includes(marker) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      assert.match(text, new RegExp(marker), who.name);
      assert.deepEqual(leaks(text), [], who.name);
    }
  });

  // A tool call over MCP, as JSON-RPC.
  const rpc = async (who: Who, method: string, params: unknown) => {
    const response = await request(who, "POST", "/v1/mcp", { jsonrpc: "2.0", id: 1, method, params }, { accept: "application/json, text/event-stream" });
    return response.text();
  };

  it("shows nobody else A's work through any MCP read tool", async () => {
    const readTools = Object.entries(TOOLS).filter(([key]) => key.startsWith("GET ") || key.endsWith("/preview"));
    for (const who of observers) {
      const listed = JSON.parse(await rpc(who, "tools/list", {})).result.tools.map((tool: { name: string }) => tool.name) as string[];
      for (const [key, spec] of readTools) {
        if (!listed.includes(spec.name)) continue;
        const path = key.slice(key.indexOf(" ") + 1);
        const args: Record<string, unknown> = {};
        if (path.includes("/studies/:id")) args.studyId = "lawrence";
        if (path.includes("/context/:id")) args.contextId = "plan";
        if (path.includes(":page")) args.page = 1;
        if (path.includes(":figure")) args.figure = "riders";
        if (spec.name === "search_sources") args.q = canary;
        if (spec.name === "read_log") args.limit = 1000;
        if (spec.name === "live_vehicles") args.routes = "52";
        if (spec.name === "preview_change") args.assumptions = { growth: 3 };
        if (spec.name === "compare_versions") args.from = from;
        const text = await rpc(who, "tools/call", { name: spec.name, arguments: args });
        assert.match(text, /"result"/, `${who.name}: ${spec.name}`);
        assert.deepEqual(leaks(text), [], `${who.name}: ${spec.name}`);
        if (path.includes(":figure")) {
          const fake = madeUp(ids.figure);
          const real = await rpc(who, "tools/call", { name: spec.name, arguments: { ...args, figure: ids.figure } });
          const other = await rpc(who, "tools/call", { name: spec.name, arguments: { ...args, figure: fake } });
          assert.equal(real, other.replaceAll(fake, ids.figure), `${who.name}: ${spec.name}`);
        }
      }
    }
  });

  it("delivers nothing of A's to a webhook", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(deliveries.some((body) => body.includes("Shared 1")));
    assert.deepEqual(leaks(deliveries.join("\n")), []);
  });

  it("shows A everything A did", async () => {
    const read = async (path: string) => (await ok(request(a, "GET", path))).json();
    const log = JSON.stringify(await read("/v1/log?limit=1000"));
    assert.match(log, new RegExp(`Hello ${canary}`));
    const assumptions = (await read("/v1/assumptions")) as { key: string; reason: string }[];
    assert.equal(assumptions.find((assumption) => assumption.key === "growth")?.reason, `Growth ${canary}`);
    const study = await read("/v1/studies/lawrence");
    assert.equal(study.checks[0].status, "pass");
    assert.equal(study.findings.find((f: { id: string }) => f.id === "survey").tone, "negative");
    assert.match(JSON.stringify(study.findings), new RegExp(`Said ${canary}`));
    assert.match(JSON.stringify(study.needs), new RegExp(`Poster ${canary}`));
    const poster = study.needs.find((need: { id: string }) => need.id === "poster");
    assert.deepEqual([poster.media[0].id, poster.claimedBy], [sha, "agent:lead"]);
    const trace = await read(`/v1/studies/lawrence/figures/${ids.figure}/trace`);
    assert.equal(trace.label, `Riders ${canary}`);
    const compare = await read(`/v1/studies/lawrence/compare?from=${from}`);
    const forecast = compare.figures.find((figure: { id: string }) => figure.id === "forecast");
    assert.ok(forecast.causes.some((cause: { reason: string }) => cause.reason === `Growth ${canary}`));
    const timeline = await read("/v1/studies/lawrence/timeline");
    assert.ok(timeline.forecast.some((f: { label: string }) => f.label === `Riders ${canary}`));
    assert.equal((await read("/v1/usage")).total.calls, 1);
    const served = await app.request(`/v1/media/${sha}`);
    assert.equal(served.headers.get("cache-control"), "private, no-cache");
    // And B, the shared check as it was.
    const theirs = await (await request(b, "GET", "/v1/studies/lawrence")).json();
    assert.equal(theirs.checks[0].status, "fail");
  });

  // So the spend screen shows everything spent, whoever it was spent for.
  it("counts what agents spent for A and B in everyone's usage, added up, as numbers only", async () => {
    const forB = observers.at(-1) as Who;
    await ok(request(forB, "POST", "/v1/studies/lawrence/activity", { kind: "usage", model: `model-of-${canary}`, inputTokens: 500, outputTokens: 50, costUsd: 0.02 }));
    const answers = new Set<string>();
    for (const who of [a, ...observers]) {
      const text = await (await ok(request(who, "GET", "/v1/usage"))).text();
      answers.add(text);
      assert.deepEqual(leaks(text), [], who.name);
      assert.doesNotMatch(text, /gemini-3-flash|guest:/, who.name);
    }
    // The same for everyone: A's call and B's, as one total. By study, only the
    // shared record's calls count, so nothing shows which study visitors work in.
    assert.equal(answers.size, 1);
    const { total, byStudy, ...more } = JSON.parse([...answers][0] as string);
    assert.deepEqual(more, {});
    assert.deepEqual(byStudy, {});
    const { estimate, ...numbers } = total;
    assert.ok(Object.values(numbers).every((value) => typeof value === "number"));
    assert.deepEqual([numbers.calls, numbers.inputTokens, numbers.outputTokens, Number(numbers.costUsd.toFixed(6))], [2, 1500, 150, 0.03]);
    assert.equal(estimate.atLeast, true);
    // A call for the shared record counts in both.
    await ok(request(lead, "POST", "/v1/studies/lawrence/activity", { kind: "usage", model: "gemini-3-flash", inputTokens: 200, outputTokens: 20, costUsd: 0.005 }));
    const after = await (await ok(request(b, "GET", "/v1/usage"))).json();
    assert.deepEqual([after.total.calls, after.byStudy.lawrence.calls, after.byStudy.lawrence.inputTokens], [3, 1, 200]);
  });

  // A's work moves no position anyone else reads, so nobody can tell when A works.
  it("keeps the log's head where it was for everyone else, while A works", async () => {
    await ok(request(lead, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: "Shared marker" }));
    const shared = service.log.head();
    const forA: Who = { name: "the lead agent for A", token: "agent-token", headers: { "x-on-behalf-of": `guest:${aId}` } };
    await ok(request(a, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: `Later ${canary}` }));
    await ok(request(forA, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: `Answer ${canary}` }));
    const read = async (who: Who, path: string) => (await ok(request(who, "GET", path))).json();
    for (const who of observers) {
      assert.deepEqual(await read(who, "/v1/log/head"), shared, who.name);
      assert.deepEqual(await read(who, "/v1/log/verify"), { ok: true, head: shared.hash }, who.name);
      assert.equal((await read(who, `/v1/studies/lawrence/compare?from=${from}`)).to, shared.seq, who.name);
    }
    assert.deepEqual((await (await app.request("/health")).json()).head, shared);
    // A's own head is A's newest entry, and an agent acting for everyone reads to the end.
    const newest = service.log.head();
    assert.ok(newest.seq > shared.seq);
    assert.deepEqual(await read(a, "/v1/log/head"), newest);
    const everyone: Who = { name: "the lead agent for everyone", token: "agent-token", headers: { "x-on-behalf-of": "*" } };
    assert.deepEqual(await read(everyone, "/v1/log/head"), newest);
    assert.deepEqual(await read(everyone, "/v1/log/verify"), { ok: true, entries: newest.seq, head: newest.hash });
  });

  // So the spend screen loads the new total at once, which tells no more than it.
  it("tells everyone else's stream of activity only that a model call was made for A", async () => {
    const forA: Who = { name: "the lead agent for A", token: "agent-token", headers: { "x-on-behalf-of": `guest:${aId}` } };
    const open = async (who: Who, types: string) => {
      const controller = new AbortController();
      const headers = { ...(who.token ? { authorization: `Bearer ${who.token}` } : {}), ...who.headers };
      const response = await app.request(`/v1/events?types=${types}&after=${service.log.head().seq}`, { headers, signal: controller.signal });
      assert.equal(response.status, 200, who.name);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      // What came before the marker, and the marker's event.
      return async (marker: string) => {
        let text = "";
        const deadline = Date.now() + 3000;
        while (!text.includes(marker) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
        controller.abort();
        return text;
      };
    };
    const others = await Promise.all(observers.map((who) => open(who, "activity")));
    const own = await open(a, "activity");
    const noActivity = await open(b, "assumption.set");
    await ok(request(forA, "POST", "/v1/studies/lawrence/activity", { kind: "usage", model: "gemini-3-flash", inputTokens: 10, outputTokens: 1, costUsd: 0.001 }));
    await ok(request(lead, "POST", "/v1/studies/lawrence/activity", { kind: "message", text: "Usage marker" }));
    await ok(request(planner, "PUT", "/v1/assumptions/min-riders", { value: 2000, reason: "The service standard" }));
    for (const [i, until] of others.entries()) {
      const text = await until("Usage marker");
      const who = (observers[i] as Who).name;
      assert.ok(text.startsWith("event: usage\ndata: {}\n\nevent: activity\n"), `${who}: ${text}`);
      assert.deepEqual(leaks(text), [], who);
    }
    const mine = await own("Usage marker");
    assert.match(mine, /"kind":"usage"/);
    assert.doesNotMatch(mine, /event: usage/);
    assert.doesNotMatch(await noActivity("min-riders"), /event: usage/);
  });
});
