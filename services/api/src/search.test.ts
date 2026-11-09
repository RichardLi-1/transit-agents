import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NewContext } from "@transit-agents/contracts";
import { createApp, type Actor } from "./app.ts";
import { watchInbox } from "./inbox.ts";
import { SearchIndex, searchTerms } from "./search.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";
import { SOURCES } from "../../../clients/seed-data.ts";

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["planner-token", { role: "planner", name: "ana" }],
  ["integration-token", { role: "integration", name: "hastus" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);

const PLAN = [
  "Service Productivity. This recommendation is forecasted to produce a weekly system ridership increase of 1,680 customers.",
  "The 52 Lawrence West runs every 10 minutes in the afternoon peak.",
  "Net cost per passenger falls by $20.06 along the changed portion of the routes.",
].map((text, i) => ({ page: i + 1, text }));

// FTS5 syntax a model or a person might type, and input far too long to be a query.
const HOSTILE = ['"', "*", "NEAR(", "a:b", "-x", "^y", "()", '"riders', "AND NOT", "{text}:x", "NEAR(a b, 2)", "\u0000", "1,,2..3", "1.2.3.4", ",5", "5,", "x".repeat(100_000), "riders ".repeat(10_000)];

describe("search index", () => {
  it("finds a word on the page it is on, and longer words it starts", () => {
    const index = new SearchIndex();
    index.add("plan", PLAN, true);
    assert.deepEqual(index.find("passenger cost", 10).map((hit) => hit.page), [3]);
    assert.deepEqual(index.find("riders", 10), [
      { contextId: "plan", page: 1, snippet: "Service Productivity. This recommendation is forecasted to produce a weekly system [ridership] increase of 1,680 customers." },
    ]);
  });

  it("shows the figure after the matched words in the snippet", () => {
    const index = new SearchIndex();
    const text = "Service Productivity. This recommendation is anticipated to cost 25 weekly service hours and is forecasted to produce a weekly system ridership increase of 1,680 customers. This increase is due to the removed transfers.";
    index.add("plan", [{ page: 1, text }], true);
    assert.equal(
      index.find("weekly system ridership increase", 10)[0]?.snippet,
      "…This recommendation is anticipated to cost 25 [weekly] service hours and is forecasted to produce a [weekly] [system] [ridership] [increase] of 1,680 customers. This [increase] is due to the removed transfers.",
    );
  });

  it("puts the best match first, by bm25", () => {
    const index = new SearchIndex();
    const pages = [
      "Fares and crowding.",
      "Ridership is one measure among fares, crowding, comfort, safety and reliability.",
      "Weekly ridership rose.",
      "Service hours and crowding.",
      "Ridership, ridership and more ridership.",
    ];
    index.add("plan", pages.map((text, i) => ({ page: i + 1, text })), true);
    // More of the query's words first, then more mentions in fewer words.
    assert.deepEqual(index.find("weekly ridership", 10).map((hit) => hit.page), [3, 5, 2]);
    assert.deepEqual(index.find("ridership", 10).map((hit) => hit.page), [5, 3, 2]);
  });

  it("ranks a page higher when the page before names what it goes on about", () => {
    const index = new SearchIndex();
    const pages = [
      "11 Bayview, 52 Lawrence West, 124 Sunnybrook. Extend the 52 Lawrence West to Sunnybrook Hospital, and replace the 124 Sunnybrook.",
      "Service Productivity. This recommendation is forecasted to produce a weekly system ridership increase of 1,680 customers.",
      "Highland Creek. A weekly system ridership decrease of 610 customers, as the Lawrence Avenue East loop loses service.",
      "Downsview Park. A routing change.",
    ];
    index.add("plan", pages.map((text, i) => ({ page: i + 1, text })), true);
    // Page 2 never names the proposal, but the page before does. Only the page
    // before page 4 has the words, so page 4 isn't found.
    assert.deepEqual(index.find("Lawrence Sunnybrook weekly ridership", 10).map((hit) => hit.page), [2, 1, 3]);
  });

  it("matches a short word exactly, not every longer word it starts", () => {
    const index = new SearchIndex();
    const pages = ["The diversion to the 506 Carlton.", "Show your Card.", "A car blocked the lane, and cars parked."];
    index.add("plan", pages.map((text, i) => ({ page: i + 1, text })), true);
    assert.deepEqual(index.find("car", 10), [{ contextId: "plan", page: 3, snippet: "A [car] blocked the lane, and [cars] parked." }]);
  });

  it("finds a figure by its whole number, with its decimal point or thousands comma", () => {
    const index = new SearchIndex();
    index.add("plan", [
      { page: 1, text: "Net cost per passenger gained of ($1.20), against 6100 riders." },
      { page: 2, text: "Route 1 runs every 20 minutes, 1 bus in 20." },
      { page: 3, text: "A weekly system ridership increase of 1,680 customers, and 610 fewer elsewhere." },
    ], true);
    assert.deepEqual(index.find("$1.20", 10), [{ contextId: "plan", page: 1, snippet: "Net cost per passenger gained of ($[1.20]), against 6100 riders." }]);
    assert.deepEqual(index.find("1,680", 10).map((hit) => hit.page), [3]);
    assert.deepEqual(index.find("610", 10).map((hit) => hit.page), [3]);
  });

  it("keeps a query's words and drops its syntax", () => {
    assert.deepEqual(searchTerms('The riders "per" NEAR(x*) a:b -c ^d (e) 52F'), ["riders", "per", "near", "x", "b", "c", "d", "e", "52f"]);
    assert.deepEqual(searchTerms("$1.20 and 1,680. 52F"), ["1.20", "1,680", "52f"]);
    assert.deepEqual(searchTerms('"* () : - ^'), []);
    assert.equal(searchTerms(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")).length, 12);
  });

  it("finds nothing in a query with no words, and never fails on FTS5 syntax", () => {
    const index = new SearchIndex();
    index.add("plan", PLAN, true);
    assert.deepEqual(index.find("the of *", 10), []);
    for (const query of HOSTILE) assert.doesNotThrow(() => index.find(query, 10), query.slice(0, 20));
  });
});

describe("search", () => {
  it("says whether each result's source can be cited", () => {
    const service = new Service(":memory:");
    service.addContext("planner:ana", NewContext.parse({ id: "plan", title: "2026 Plan", pages: PLAN }));
    service.addContext("integration:hastus", NewContext.parse({ id: "export", title: "Ridership export", text: "Route 52 weekly ridership: 41,200" }));
    service.addContext("agent:lead", NewContext.parse({ id: "notes", title: "My notes", text: "Ridership might double." }));
    const results = service.search("ridership", 10);
    assert.deepEqual(Object.fromEntries(results.map((result) => [result.contextId, result.citable])), { plan: true, export: true, notes: false });
    assert.deepEqual(results.find((result) => result.contextId === "notes"), {
      contextId: "notes",
      title: "My notes",
      page: 1,
      snippet: "[Ridership] might double.",
      citable: false,
    });
  });

  it("puts pages that can be cited before an agent's own, however well those match", () => {
    const service = new Service(":memory:");
    service.addContext("planner:ana", NewContext.parse({ id: "plan", title: "2026 Plan", pages: PLAN }));
    const drafts = Array.from({ length: 12 }, (_, i) => ({ page: i + 1, text: `Draft ${i + 1}: weekly system ridership increase, to confirm.` }));
    service.addContext("agent:lead", NewContext.parse({ id: "drafts", title: "Drafts", pages: drafts }));
    const results = service.search("weekly system ridership increase", 10);
    assert.deepEqual(results.map((result) => `${result.contextId}#${result.page}`).slice(0, 2), ["plan#1", "drafts#1"]);
    assert.deepEqual(results.map((result) => result.citable), [true, ...Array(9).fill(false)]);
  });

  it("finds a source added after startup, by any path", async () => {
    const service = new Service(":memory:");
    const app = createApp({ service, webhooks: new Webhooks(service), tokens: TOKENS, access: "token" });
    const dir = mkdtempSync(join(tmpdir(), "transit-inbox-"));
    writeFileSync(join(dir, "hastus-export.csv"), "route,trips\n52,300\n");
    const stop = watchInbox(service, dir);
    try {
      const headers = { authorization: "Bearer planner-token", "content-type": "application/json" };
      await app.request("/v1/context", { method: "POST", headers, body: JSON.stringify({ title: "Plan", pages: PLAN }) });
      const form = new FormData();
      form.append("file", new File(["Fare revenue covers most operating costs."], "fares.txt"));
      await app.request("/v1/context", { method: "POST", headers: { authorization: "Bearer integration-token" }, body: form });
      const deadline = Date.now() + 7000;
      while (service.state.contexts.size < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const titles = (query: string) => service.search(query, 10).map((result) => result.title);
      assert.deepEqual(titles("passenger"), ["Plan"]);
      assert.deepEqual(titles("fare revenue"), ["fares.txt"]);
      assert.deepEqual(titles("trips"), ["hastus-export.csv"]);
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds the index from the log after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-agents-"));
    const path = join(dir, "log.db");
    try {
      const first = new Service(path);
      first.addContext("planner:ana", NewContext.parse({ id: "plan", title: "2026 Plan", pages: PLAN }));
      first.addContext("agent:lead", NewContext.parse({ id: "notes", title: "My notes", text: "Ridership might double." }));
      // The agent's note is shorter, so it matches better, but it can't be cited.
      const before = first.search("ridership", 10);
      assert.deepEqual(before.map((result) => [result.contextId, result.page]), [["plan", 1], ["notes", 1]]);
      first.close();

      const second = new Service(path);
      assert.deepEqual(second.search("ridership", 10), before);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /v1/search", () => {
  function setup(pages = PLAN) {
    const service = new Service(":memory:");
    service.addContext("planner:ana", NewContext.parse({ id: "plan", title: "2026 Plan", pages }));
    const app = createApp({ service, webhooks: new Webhooks(service), tokens: TOKENS, access: "token" });
    return (query: string, token = "viewer-token") => app.request(`/v1/search?${query}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("answers every role, with each page's source, title and whether it can be cited", async () => {
    const search = setup();
    for (const token of TOKENS.keys()) assert.equal((await search("q=passenger", token)).status, 200, token);
    assert.deepEqual(await (await search("q=passenger")).json(), {
      results: [
        { contextId: "plan", title: "2026 Plan", page: 3, snippet: "Net cost per [passenger] falls by $20.06 along the changed portion of the routes.", citable: true },
      ],
    });
  });

  it("returns 10 results by default and at most 50", async () => {
    const search = setup(Array.from({ length: 60 }, (_, i) => ({ page: i + 1, text: `Ridership on page ${i + 1}` })));
    const count = async (query: string) => ((await (await search(query)).json()) as { results: unknown[] }).results.length;
    assert.equal(await count("q=ridership"), 10);
    assert.equal(await count("q=ridership&limit=3"), 3);
    assert.equal(await count("q=ridership&limit=500"), 50);
  });

  it("refuses a missing or empty q, and an invalid limit", async () => {
    const search = setup();
    for (const query of ["", "q=", "q=%20%20", "q=x&limit=", "q=x&limit=abc", "q=x&limit=0", "q=x&limit=-1", "q=x&limit=2.5"]) {
      const response = await search(query);
      assert.equal(response.status, 400, query);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_query");
    }
  });

  it("never fails on FTS5 syntax or very long input", async () => {
    const search = setup();
    for (const query of HOSTILE) {
      const response = await search(`q=${encodeURIComponent(query)}`);
      assert.equal(response.status, 200, query.slice(0, 20));
      assert.ok(Array.isArray(((await response.json()) as { results: unknown }).results));
    }
  });
});

// Questions from docs/queries.md, each with the plan page it names, then any
// other page that states the same answer.
const FIND: [string, string, ...string[]][] = [
  ["minimum boardings per service hour local bus peak", "ttc-anp-2026#115", "ttc-standards-2024#33"],
  ["minimum new riders per $100 for a service increase", "ttc-anp-2026#115", "ttc-standards-2024#21", "ttc-standards-2024#35"],
  ["boarding weight Neighbourhood Improvement Area", "ttc-anp-2026#114", "ttc-anp-2026#138", "ttc-anp-2026#141", "ttc-anp-2026#144", "ttc-standards-2024#19", "ttc-standards-2024#33"],
  ["trial period for a major service change", "ttc-anp-2026#115", "ttc-anp-2026#113", "ttc-standards-2024#29"],
  ["Highland Creek forecast weekly ridership change", "ttc-anp-2026#122"],
  ["Lawrence Sunnybrook forecast weekly ridership", "ttc-anp-2026#118"],
];
// Figures the seeded studies cite, and their pages.
const FIGURES: [string, string][] = [
  ["1,680", "ttc-anp-2026#118"], ["$1.29", "ttc-anp-2026#118"], ["50,470", "ttc-anp-2026#117"], ["25,270", "ttc-anp-2026#127"], ["560 customers", "ttc-anp-2026#128"],
  ["$1.20", "ttc-anp-2026#128"], ["610", "ttc-anp-2026#122"], ["40 riders per $100", "ttc-anp-2026#118"], ["25 weekly service hours", "ttc-anp-2026#118"],
];

// Pinned on the real plan and standards, because ranks depend on every page in
// the index. When a change moves them, update them here and say why.
describe("gold questions", () => {
  const index = new SearchIndex();
  for (const id of ["ttc-standards-2024", "ttc-anp-2026"]) {
    index.add(id, JSON.parse(readFileSync(join(import.meta.dirname, "../../../clients/fixtures", `${id}.pages.json`), "utf8")), true);
  }
  const rank = (query: string, pages: string[]) => index.find(query, 50).findIndex((hit) => pages.includes(`${hit.contextId}#${hit.page}`)) + 1;

  it("rank the pages that answer the Find questions", () => {
    // The plan page docs/queries.md names. Page 115 is a table: it says "Min.",
    // never "minimum" or "hour".
    assert.deepEqual(FIND.map(([query, page]) => rank(query, [page])), [7, 3, 2, 1, 2, 2]);
    assert.deepEqual(FIND.map(([query, ...pages]) => rank(query, pages)), [1, 1, 1, 1, 2, 2]);
  });

  it("rank the page a figure is on", () => {
    assert.deepEqual(FIGURES.map(([query, page]) => rank(query, [page])), [1, 1, 1, 1, 1, 1, 1, 2, 5]);
  });
});

// The same questions over everything the demo and the eval runner seed: since the
// Ontario Line study, its business cases, Metrolinx's manual and the TTC's subway
// ridership too. Their pages outrank some of the plan's for bare figures: "610"
// and "$1.29" are on Ontario Line pages, and so are riders and dollars. Questions
// with words still find a page that answers them first or second.
describe("gold questions over the seeded sources", () => {
  const index = new SearchIndex();
  for (const { id, pagesFile } of SOURCES) {
    if (pagesFile) index.add(id, JSON.parse(readFileSync(join(import.meta.dirname, "../../../clients/fixtures", pagesFile), "utf8")), true);
  }
  const rank = (query: string, pages: string[]) => index.find(query, 50).findIndex((hit) => pages.includes(`${hit.contextId}#${hit.page}`)) + 1;

  it("indexes every seeded source with pages", () => {
    assert.deepEqual(SOURCES.filter((source) => source.pagesFile).length, 9);
  });

  it("rank the pages that answer the Find questions", () => {
    assert.deepEqual(FIND.map(([query, page]) => rank(query, [page])), [8, 4, 2, 1, 2, 2]);
    assert.deepEqual(FIND.map(([query, ...pages]) => rank(query, pages)), [1, 1, 1, 1, 2, 2]);
  });

  it("rank the page a figure is on", () => {
    // With the road safety sources, more pages weigh "$" and "per": "$1.29" falls
    // from 2 to 3, and "40 riders per $100" rises from 7 to 5.
    assert.deepEqual(FIGURES.map(([query, page]) => rank(query, [page])), [1, 3, 1, 1, 1, 1, 6, 5, 2]);
  });
});
