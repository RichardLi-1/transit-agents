# Transit Agents

A service where AI agents do the first pass of transit planning studies, and every
number traces back to the page it came from. Planners set the rules, rate the
consultation, and make every decision. The display is one client; agents, agency
systems, Teams and Slack are others.

It runs today on two real proposals from the TTC's 2026 Annual Network Plan:

- **Lawrence–Sunnybrook** passed its tests and was adopted. Its 12-month trial
  began on November 1, 2026, and this repo measures its reliability live from
  public data.
- **Sherbourne–Castle Frank** passed the travel-time test, but consultation was
  split, and it was not adopted.

## What is real

| Part | Status |
|---|---|
| Service: log, guarantees, API, webhooks, watched folder | Built and tested |
| Display | Built. Lighthouse 98 mobile and 99 desktop for performance, 100 for accessibility, best practices and SEO, measured locally. No axe violations. |
| Collector | Built and running against the live TTC feed |
| Study figures | Real, each checked against the TTC plan's text |
| Agent | **Not built here.** `npm run replay` stands in, with an agent token, so the log names it `agent:replay`. It reports no tokens or cost because it spends none. |
| Skills | Not built here. See [docs/skills.md](docs/skills.md). |

## Run it

Needs Node 24 or later. Poppler (`pdftotext`) is optional, for reading uploaded PDFs.

```sh
npm install
npm run build              # build the display
npm run collect            # in its own terminal: record live vehicles
npm run demo -- --fresh    # start the service and load the public sources
npm run replay             # play the scripted agent run
npm run decide             # a planner rates consultation and records decisions
```

Open http://127.0.0.1:4100. The demo switches on open access, so this machine
acts as a planner. Never use open access on a shared network.

Press Space to play time. The speed button steps from real time to a week a
second. At the present moment the map shows live vehicles. At any other time it
shows scheduled ones, until the published timetable ends.

## Plug in your agents

Your agents call the same API as everything else. The full schema is at
`GET /openapi.json`, and [docs/system.md](docs/system.md) lists every route.

Start the service with tokens, one per role:

```sh
TRANSIT_TOKENS=agent:lead:SECRET1,planner:ana:SECRET2,integration:hastus:SECRET3 npm run serve
```

An agent's working loop:

```sh
# Open a study
curl -X POST localhost:4100/v1/studies -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' -d '{"id":"my-study","title":"My study"}'

# Report what it is doing, and what it spends
curl -X POST localhost:4100/v1/studies/my-study/activity -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' \
  -d '{"kind":"usage","model":"claude-opus-5-5","inputTokens":1200,"outputTokens":300,"costUsd":0.04}'

# Add a figure. It is rejected unless the quote is on that page and contains the value.
curl -X POST localhost:4100/v1/studies/my-study/figures -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' \
  -d '{"id":"riders","label":"Riders","value":1680,"basis":{"kind":"cited","citation":{"contextId":"ttc-anp-2026","page":118,"quote":"weekly system ridership increase of 1,680 customers"}}}'

# Hear about everything, live
curl -N 'localhost:4100/v1/events?access_token=SECRET1'
```

An agent can't record a decision, set a rule, rate consultation or accept a
skill's result. Those calls return 403.

## Repo

| Path | What |
|---|---|
| `services/api` | The service, and the collector (`collect.ts`) |
| `apps/display` | The display: Preact, with a WebGL map in a worker |
| `packages/contracts` | Types and schemas shared by every client |
| `clients` | Seed, replay and decide, which use the public API |
| `evals` | The eval cases, inputs and scorer |
| `scripts` | Data pipelines from GTFS and the plan PDFs |
| `docs` | Design, decisions, evals, benchmark, skills, rollout |

## Checks

```sh
npm test            # 120 tests
npm run typecheck
```

## Docs

- [System](docs/system.md): diagram, rules and API
- [Decisions](docs/decisions.md): how the design was argued and changed
- [What agents should do](docs/queries.md) and [the eval set](docs/evals.md)
- [Our version of PNNL](docs/benchmark.md)
- [Skills](docs/skills.md)
- [Fast rollout](docs/rollout.md)
- [Corrections to the report](docs/report-corrections.md)

## Data

TTC schedules and live positions come from the City of Toronto's
[Open Data portal](https://open.toronto.ca/), under the Open Government
Licence – Toronto. Plan and standards pages are from public TTC documents,
included as text and page images for checking citations.
