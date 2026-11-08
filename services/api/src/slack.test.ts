// The Slack integration, against a fake Slack on a local port: the shared record's
// notices arrive, a visitor's sandbox sends none, and the address stays secret.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp, type Actor } from "./app.ts";
import { VisitorBudget } from "./budget.ts";
import { VisitorLimits } from "./limits.ts";
import { padded, SAMPLE } from "./sample-media.ts";
import { Service } from "./service.ts";
import { DEFAULT_EXECUTIVE, escalation, gist, parseExecutive, Slack, slackUrl, type SlackMessage } from "./slack.ts";
import { Webhooks } from "./webhooks.ts";

const PORT = 4521;
const SECRET_PATH = `/services/T000/B000/${randomBytes(12).toString("hex")}`;
const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["replay-token", { role: "agent", name: "replay" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
]);
const PAGE = "Service on the 52F Lawrence West would be extended to Sunnybrook Hospital, adding 1,680 weekly riders.";
const CITATION = { contextId: "plan", page: 1, quote: "adding 1,680 weekly riders" };
const NEED = { place: "Sunnybrook Hospital", lon: -79.375262, lat: 43.722663, kinds: ["image"], reason: "Riders can ride to the hospital.", citations: [CITATION] };

// A fake Slack: answers each post with the next status in line, then 200, or not at all.
function fakeSlack() {
  const received: { path: string; body: SlackMessage }[] = [];
  const statuses: (number | "hang")[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const status = statuses.shift() ?? 200;
      if (status === "hang") return;
      if (status === 200) received.push({ path: req.url ?? "", body: JSON.parse(raw) as SlackMessage });
      res.writeHead(status).end(status === 200 ? "ok" : "no");
    });
  });
  return { server, received, statuses };
}

describe("Slack", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-slack-"));
  const slack = fakeSlack();
  const warnings: string[] = [];
  const canary = `canary${randomBytes(8).toString("hex")}`;
  const service = new Service(":memory:", { mediaDir: join(dir, "media"), budget: new VisitorBudget() });
  const webhooks = new Webhooks(service, undefined, async () => new Response("ok"));
  const url = slackUrl(`http://127.0.0.1:${PORT}${SECRET_PATH}`) as URL;
  const notifier = new Slack(service, url, { publicUrl: "https://transit.example/", retryMs: 10, timeoutMs: 300, warn: (line) => warnings.push(line) });
  const app = createApp({
    service,
    webhooks,
    tokens: TOKENS,
    access: "demo",
    guests: { secret: "a-guest-secret-of-at-least-32-characters" },
    limits: new VisitorLimits({ perMinute: 1000 }),
    visitorAgents: ["lead"],
  });

  type Who = { token?: string; headers?: Record<string, string> };
  const planner: Who = { token: "planner-token" };
  const lead: Who = { token: "agent-token" };
  const ok = async (who: Who, method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { ...(who.token ? { authorization: `Bearer ${who.token}` } : {}), "content-type": "application/json", ...who.headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    return response;
  };
  const say = (who: Who, activity: unknown) => ok(who, "POST", "/v1/studies/lawrence/activity", activity);
  // The need's file, made after a request, by the agent holding the claim.
  const makeMedia = async (who: Who, need: string, bytes: Uint8Array, prompt: string) => {
    const claim = `claim-${randomBytes(6).toString("hex")}`;
    await ok(who, "POST", `/v1/studies/lawrence/needs/${need}/claim`, { claim });
    const form = new FormData();
    for (const [name, value] of Object.entries({ claim, kind: "image", model: "gemini-3.1-flash-image", prompt, inputs: "[]" })) form.set(name, value);
    form.set("file", new Blob([bytes.slice()], { type: "image/png" }), "poster.png");
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    const headers = { authorization: `Bearer ${who.token}`, "content-type": encoded.headers.get("content-type") as string, "content-length": String(body.length), ...who.headers };
    const response = await app.request(`/v1/studies/lawrence/needs/${need}/media`, { method: "POST", headers, body });
    assert.ok(response.ok, `media: ${response.status} ${await response.text()}`);
  };
  const posted = () => slack.received.map((r) => r.body.text);

  before(async () => {
    await new Promise<void>((resolve) => slack.server.listen(PORT, "127.0.0.1", resolve));
    await ok({ token: "integration-token" }, "POST", "/v1/context", { id: "plan", title: "2026 Plan", pages: [{ page: 1, text: PAGE }] });
    await ok(lead, "POST", "/v1/studies", { id: "lawrence", title: "Lawrence & Sunnybrook", project: ["forecast"] });
    await ok(planner, "PUT", "/v1/assumptions/growth", { value: 1, reason: "No growth" });
    await ok(lead, "POST", "/v1/studies/lawrence/figures", { id: "riders", label: "Weekly riders", value: 1680, basis: { kind: "cited", citation: CITATION } });
    await ok(lead, "POST", "/v1/studies/lawrence/figures", {
      id: "forecast",
      label: "Forecast riders",
      basis: { kind: "derived", formula: "riders * growth", inputs: { riders: { figure: "riders" }, growth: { assumption: "growth" } } },
    });
    await ok(lead, "POST", "/v1/studies/lawrence/needs", { id: "poster", title: "Engagement poster", ...NEED });
    await ok(lead, "POST", "/v1/studies/lawrence/needs", { id: "leaflet", title: "Leaflet", ...NEED });
    await notifier.settled();
  });
  after(async () => {
    notifier.stop();
    webhooks.stop();
    slack.server.closeAllConnections();
    await new Promise((resolve) => slack.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts the shared record's notices, each naming the study and linking to it", async () => {
    // Setting up the study set the brief once, before any figure rested on it: a
    // change that moves no study's figures isn't posted.
    assert.deepEqual(posted(), []);

    await say(lead, { kind: "run.started" });
    await say(lead, { kind: "message", text: "First pass, ready for planners, not a final answer." });
    await say(lead, { kind: "run.finished" });
    await say(planner, { kind: "message", text: "And the riders in 2030?" });
    await say(lead, { kind: "run.started" });
    await say(lead, { kind: "reading", contextId: "plan", page: 1 });
    await say(lead, { kind: "message", text: "1,680 weekly riders (2026 Plan p. 1)." });
    await say(lead, { kind: "usage", model: "m", inputTokens: 1, outputTokens: 1 });
    await say(lead, { kind: "run.finished" });
    await ok(planner, "POST", "/v1/studies/lawrence/decisions", { outcome: "adopt", reason: "Enough riders.", decidedBy: "Ana Planner" });
    await ok(planner, "PUT", "/v1/assumptions/growth", { value: 1.2, reason: "Planner's private reasoning" });
    await ok(planner, "POST", "/v1/studies/lawrence/needs/poster/create");
    await makeMedia(lead, "poster", SAMPLE.png, "A poster");
    await notifier.settled();

    const link = "<https://transit.example/#lawrence|Open>";
    assert.deepEqual(posted(), [
      `Needs your call. Lawrence &amp; Sunnybrook. ${link}`,
      `Answer ready. Lawrence &amp; Sunnybrook. ${link}`,
      `Decided: Adopted, by Ana Planner. Lawrence &amp; Sunnybrook. ${link}`,
      `Brief changed: growth set to 1.2. Lawrence &amp; Sunnybrook. ${link}`,
      `Illustrative image ready: Engagement poster, Sunnybrook Hospital. Lawrence &amp; Sunnybrook. ${link}`,
    ]);
    for (const { path, body } of slack.received) {
      assert.equal(path, SECRET_PATH);
      assert.equal(body.blocks[0]?.type, "section");
      assert.match(body.blocks[0]?.text.text ?? "", /^\*.+\*\nLawrence &amp; Sunnybrook · <https:\/\/transit\.example\/#lawrence\|Open the study>$/);
    }
    // Nobody's words: not the agent's answer, the planner's question or reason.
    const all = JSON.stringify(slack.received);
    for (const words of ["1,680", "riders in 2030", "private reasoning", "Enough riders"]) assert.ok(!all.includes(words), words);
  });

  it("posts nothing from the scripted replay", async () => {
    slack.received.length = 0;
    const replay: Who = { token: "replay-token" };
    await say(replay, { kind: "run.started" });
    await say(replay, { kind: "message", text: "First pass, ready for planners, not a final answer." });
    await say(replay, { kind: "run.finished" });
    await notifier.settled();
    assert.deepEqual(posted(), []);
  });

  it("posts a document as ready, not as an answer", async () => {
    slack.received.length = 0;
    await say(lead, { kind: "run.started" });
    const made = await ok(lead, "POST", "/v1/studies/lawrence/documents", {
      kind: "report",
      title: "Lawrence brief",
      sections: [{ heading: "Riders", points: [{ text: "1,680 weekly riders", citation: CITATION }] }],
    });
    const { link } = (await made.json()) as { link: string };
    await say(lead, { kind: "message", text: `Document ready: Lawrence brief. ${link}` });
    await say(lead, { kind: "run.finished" });
    await notifier.settled();
    assert.deepEqual(posted(), ["Document ready: Lawrence brief. Lawrence &amp; Sunnybrook. <https://transit.example/#lawrence|Open>"]);
  });

  it("posts nothing from a visitor's sandbox, nor from the agents acting for them", async () => {
    slack.received.length = 0;
    const pass = (await (await ok({}, "POST", "/v1/guests")).json()).token as string;
    const visitor: Who = { token: pass };
    const forVisitor: Who = { token: "agent-token", headers: { "x-on-behalf-of": `guest:${pass.split(".")[1]}` } };

    await say(visitor, { kind: "message", text: `Hello ${canary}` });
    await say(forVisitor, { kind: "run.started" });
    await say(forVisitor, { kind: "message", text: `Ready for planners ${canary}` });
    await say(forVisitor, { kind: "run.finished" });
    await say(forVisitor, { kind: "run.started" });
    await say(forVisitor, { kind: "message", text: `An answer ${canary}` });
    await say(forVisitor, { kind: "run.finished" });
    await ok(visitor, "PUT", "/v1/assumptions/growth", { value: 3, reason: `Growth ${canary}` });
    await ok(visitor, "POST", "/v1/studies/lawrence/needs/leaflet/create");
    await makeMedia(forVisitor, "leaflet", padded(SAMPLE.png, SAMPLE.png.length + 40), `A leaflet ${canary}`);
    // A shared entry after, so a post the sandbox raised would have come first.
    await ok(planner, "POST", "/v1/studies/lawrence/decisions", { outcome: "defer", reason: "Wait for the survey.", decidedBy: "Ana Planner" });
    await notifier.settled();

    assert.deepEqual(posted(), ["Decided: Deferred, by Ana Planner. Lawrence &amp; Sunnybrook. <https://transit.example/#lawrence|Open>"]);
    assert.ok(!JSON.stringify(slack.received).includes(canary));
  });

  it("says an answer needs an executive's decision, @-mentioning nobody", async () => {
    slack.received.length = 0;
    await say(lead, { kind: "run.started" });
    await say(lead, { kind: "message", text: "Option A is longer.\n\nFor a planner to decide: which?\n\nExecutive decision required: which option to fund." });
    await say(lead, { kind: "run.finished" });
    await notifier.settled();
    assert.deepEqual(posted(), ["Executive decision required. Lawrence &amp; Sunnybrook. <https://transit.example/#lawrence|Open>"]);
    assert.ok(!JSON.stringify(slack.received).includes("<@"));
    assert.ok(!JSON.stringify(slack.received).includes("which option to fund"));
  });

  it("retries once, then gives up, and never logs the address", async () => {
    slack.received.length = 0;
    slack.statuses.push(500);
    notifier.send({ text: "first", blocks: [] });
    await notifier.settled();
    assert.deepEqual(posted(), ["first"]);
    assert.deepEqual(warnings, []);

    slack.statuses.push(500, 503);
    notifier.send({ text: "second", blocks: [] });
    slack.statuses.push("hang", "hang");
    notifier.send({ text: "third", blocks: [] });
    notifier.send({ text: "fourth", blocks: [] });
    await notifier.settled();
    assert.deepEqual(posted(), ["first", "fourth"]);
    // A ping waits to hear whether Slack took it.
    assert.equal(await notifier.sendAndWait({ text: "fifth", blocks: [] }), null);
    slack.statuses.push(500, 500);
    assert.equal(await notifier.sendAndWait({ text: "sixth", blocks: [] }), "Slack returned 500");
    warnings.splice(2);
    assert.deepEqual(warnings, ["Slack: a notice was not posted (Slack returned 503)", "Slack: a notice was not posted (no answer in 300 ms)"]);
    assert.ok(!warnings.join("\n").includes(SECRET_PATH.split("/").at(-1) as string));
  });

  it("doesn't hold up the service while Slack is slow", async () => {
    slack.statuses.push("hang", "hang");
    const started = performance.now();
    await ok(planner, "PUT", "/v1/assumptions/growth", { value: 1.5, reason: "Again" });
    assert.ok(performance.now() - started < 200);
    await notifier.settled();
  });
});

describe("SLACK_WEBHOOK_URL", () => {
  it("takes a Slack incoming webhook, or a local address for tests and demos", () => {
    assert.ok(slackUrl("https://hooks.slack.com/services/T0/B0/x"));
    assert.ok(slackUrl("http://localhost:4520/services/x"));
    assert.ok(slackUrl("http://127.0.0.1:4520/x"));
  });

  it("refuses anything else, so a mistyped address sends the record nowhere", () => {
    for (const raw of [undefined, "", "not a url", "http://hooks.slack.com/services/T0/B0/x", "https://hooks.slack.com/other", "https://hooks.slack.com.evil.test/services/x", "https://example.com/services/x"]) {
      assert.equal(slackUrl(raw), null, String(raw));
    }
  });
});

describe("SLACK_EXECUTIVE", () => {
  it("takes a name and a member ID, a name alone, or nothing", () => {
    assert.deepEqual(parseExecutive("Jordan Lee <U0123ABCD>"), { name: "Jordan Lee", member: "U0123ABCD" });
    assert.deepEqual(parseExecutive("  Jordan Lee <@U0123ABCD> "), { name: "Jordan Lee", member: "U0123ABCD" });
    assert.deepEqual(parseExecutive("Jordan Lee"), { name: "Jordan Lee" });
    assert.deepEqual(parseExecutive("<U0123ABCD>"), { name: DEFAULT_EXECUTIVE, member: "U0123ABCD" });
    assert.deepEqual(parseExecutive(undefined), { name: DEFAULT_EXECUTIVE });
    assert.deepEqual(parseExecutive(""), { name: DEFAULT_EXECUTIVE });
  });

  it("mentions nobody with an ID that isn't a member's, and keeps mrkdwn out of the name", () => {
    assert.deepEqual(parseExecutive("Jordan <C0123ABCD>"), { name: "Jordan" });
    assert.deepEqual(parseExecutive("*Jordan* <!channel>"), { name: "Jordan <!channel>".replace(/[<>]/g, "") });
  });
});

describe("a ping's message", () => {
  const ping = { decision: "Which alignment option to fund.", summary: "Option A is 7.4 km.", study: "Ontario Line & Don Mills", link: "https://transit.example/#ontario", raisedBy: "ana" };

  it("@-mentions the executive by member ID, with the decision, the gist, the study's link and who raised it", () => {
    const body = escalation({ name: "Jordan Lee", member: "U0123ABCD" }, ping);
    assert.equal(
      body.blocks[0]?.text.text,
      "*Executive decision required*, for <@U0123ABCD>\nWhich alignment option to fund.\n_Option A is 7.4 km._\nOntario Line &amp; Don Mills · <https://transit.example/#ontario|Open the study>\nRaised by ana",
    );
    assert.match(body.text, /^Executive decision required, for <@U0123ABCD>: Which alignment option to fund\. .*<https:\/\/transit\.example\/#ontario\|Open the study> Raised by ana\.$/);
  });

  it("names the executive in bold, with no mention, without a member ID", () => {
    const body = escalation({ name: "the executive sponsor" }, { ...ping, summary: undefined, decision: "Fund <it> & go" });
    assert.equal(body.blocks[0]?.text.text.split("\n")[0], "*Executive decision required*, for *the executive sponsor*");
    assert.equal(body.blocks[0]?.text.text.split("\n")[1], "Fund &lt;it&gt; &amp; go");
    assert.ok(!JSON.stringify(body).includes("<@"));
  });

  it("gives an answer's first sentence as its gist", () => {
    assert.equal(gist("Option A is 7.4 km (ibc p. 14). Option B is longer.\n\nExecutive decision required: fund one."), "Option A is 7.4 km (ibc p. 14).");
    assert.equal(gist("Executive decision required: fund one."), undefined);
    const long = gist(`${"word ".repeat(60)}end.`) ?? "";
    assert.ok(long.length <= 200 && long.endsWith("…"));
  });
});

describe("pinging the executive", () => {
  const sent: SlackMessage[] = [];
  let fails = 0;
  const fake = {
    sendAndWait: async (body: SlackMessage) => {
      if (fails > 0) {
        fails -= 1;
        return "Slack returned 500";
      }
      sent.push(body);
      return null;
    },
  };
  let now = Date.parse("2026-11-08T17:41:00Z");
  const clock = () => new Date(now);
  const setupPing = (slack: typeof fake | null, executive = { name: "Jordan Lee", member: "U0123ABCD" }) => {
    const service = new Service(":memory:");
    const app = createApp({
      service,
      webhooks: new Webhooks(service, undefined, async () => new Response("ok")),
      tokens: TOKENS,
      access: "demo",
      guests: { secret: "a-guest-secret-of-at-least-32-characters" },
      limits: new VisitorLimits({ perMinute: 1000 }),
      publicUrl: "https://transit.example",
      slack,
      executive,
      clock,
    });
    const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    return { service, app, call };
  };
  const ANSWER = "Option A runs 7.4 km to Sheppard (ibc p. 14). Option B is shorter.\n\nExecutive decision required: which alignment option to fund.";
  const ready = async (env: ReturnType<typeof setupPing>) => {
    assert.equal((await env.call("agent-token", "POST", "/v1/studies", { id: "ontario", title: "Ontario Line & Don Mills" })).status, 201);
    const said = await env.call("agent-token", "POST", "/v1/studies/ontario/activity", { kind: "message", text: ANSWER });
    return ((await said.json()) as { seq: number }).seq;
  };
  const ping = (env: ReturnType<typeof setupPing>, token: string | undefined, body: unknown) => env.call(token, "POST", "/v1/studies/ontario/escalate", body);

  it("posts the decision to Slack, @-mentioning the executive, and logs it for every viewer", async () => {
    sent.length = 0;
    const env = setupPing(fake);
    const seq = await ready(env);
    assert.equal((await (await env.app.request("/v1/config")).json()).executive, "Jordan Lee");
    const response = await ping(env, "planner-token", { text: "Executive decision required: which alignment option to fund.", message: seq });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).to, "Jordan Lee");
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]?.blocks[0]?.text.text,
      "*Executive decision required*, for <@U0123ABCD>\nWhich alignment option to fund.\n_Option A runs 7.4 km to Sheppard (ibc p. 14)._\nOntario Line &amp; Don Mills · <https://transit.example/#ontario|Open the study>\nRaised by ana",
    );
    const entry = env.service.log.get(env.service.log.head().seq);
    assert.equal(entry?.actor, "planner:ana");
    assert.equal(entry?.type, "activity");
    assert.deepEqual(entry?.data, { kind: "escalation.sent", text: "Which alignment option to fund.", to: "Jordan Lee", message: seq });
    assert.equal(entry?.audience, null);
  });

  it("pings once per answer in 10 minutes, so a double click can't spam", async () => {
    sent.length = 0;
    const env = setupPing(fake);
    const seq = await ready(env);
    const [first, second] = await Promise.all([ping(env, "planner-token", { text: "Fund?", message: seq }), ping(env, "planner-token", { text: "Fund?", message: seq })]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    now += 9 * 60_000;
    const again = await ping(env, "planner-token", { text: "Fund?", message: seq });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, "already_sent");
    assert.equal(sent.length, 1);
    now += 2 * 60_000;
    assert.equal((await ping(env, "planner-token", { text: "Fund?", message: seq })).status, 201);
    assert.equal(sent.length, 2);
  });

  it("lets a planner try again when Slack fails, and logs nothing until it posts", async () => {
    sent.length = 0;
    const env = setupPing(fake);
    const seq = await ready(env);
    const head = env.service.log.head().seq;
    fails = 1;
    const failed = await ping(env, "planner-token", { text: "Fund?", message: seq });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error.code, "slack_failed");
    assert.equal(env.service.log.head().seq, head);
    assert.equal((await ping(env, "planner-token", { text: "Fund?", message: seq })).status, 201);
    assert.equal(sent.length, 1);
  });

  it("is a planner's alone: visitors, agents and viewers are refused, with why", async () => {
    sent.length = 0;
    const env = setupPing(fake);
    const seq = await ready(env);
    const pass = (await (await env.call(undefined, "POST", "/v1/guests")).json()).token as string;
    const visitor = await ping(env, pass, { text: "Fund?", message: seq });
    assert.equal(visitor.status, 403);
    assert.deepEqual((await visitor.json()).error, { code: "sign_in_required", message: "Sign in as a planner to do this." });
    const agent = await ping(env, "agent-token", { text: "Fund?", message: seq });
    assert.equal(agent.status, 403);
    assert.match((await agent.json()).error.message, /needs a planner token, not agent/);
    assert.equal((await ping(env, undefined, { text: "Fund?", message: seq })).status, 401);
    // Nor can an agent log a ping as activity.
    const posed = await env.call("agent-token", "POST", "/v1/studies/ontario/activity", { kind: "escalation.sent", text: "Fund?", to: "Jordan Lee" });
    assert.equal(posed.status, 400);
    assert.equal(sent.length, 0);
  });

  it("needs a message in the study's chat, and a decision of at most 300 characters", async () => {
    const env = setupPing(fake);
    await ready(env);
    assert.equal((await ping(env, "planner-token", { text: "Fund?", message: 9999 })).status, 422);
    assert.equal((await ping(env, "planner-token", { text: "x".repeat(301) })).status, 400);
    assert.equal((await env.call("planner-token", "POST", "/v1/studies/nope/escalate", { text: "Fund?" })).status, 404);
  });

  it("says Slack isn't set up, and names nobody, without a webhook", async () => {
    const env = setupPing(null);
    const seq = await ready(env);
    assert.equal((await (await env.app.request("/v1/config")).json()).executive, null);
    const response = await ping(env, "planner-token", { text: "Fund?", message: seq });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "slack_off");
  });
});
