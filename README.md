# Transit Agents

A service where AI agents do the first pass of transit planning studies. Every
number traces to the page it came from, and planners make every decision.

## What is real

- **Studies:** two proposals from the TTC's 2026 Annual Network Plan.
  Lawrence–Sunnybrook passed its tests and was adopted. Sherbourne–Castle Frank
  passed the travel-time test, but consultation was split, and it was not
  adopted. Every figure is checked against the plan's text.
- **Service** (log, guarantees, API, webhooks, watched folder): built and tested.
- **Collector:** built, measuring Lawrence–Sunnybrook's reliability live from
  the public TTC feed. The 12-month trial began on November 1, 2026.
- **Display:** built. Lighthouse, measured locally: performance 98 mobile and 99
  desktop; 100 for accessibility, best practices and SEO. No axe violations.
- **Agents and skills:** not built here. `npm run replay` stands in for an agent
  with an agent token, logged as `agent:replay`. It reports no tokens or cost
  because it spends none.

## Run it

Needs Node 24 or later. Poppler (`pdftotext`) is optional, for uploaded PDFs.

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

Space plays time; the speed button steps from real time to a week a second.
Vehicles are live at the present moment, and scheduled otherwise until the
published timetable ends.

Checks: `npm test` (120 tests) and `npm run typecheck`.

## Plug in your agents

Agents call the same API as every other client. Schema: `GET /openapi.json`.
Routes and roles: [docs/system.md](docs/system.md). Planner-only calls return
403 to agents.

Start the service with one token per role:

```sh
TRANSIT_TOKENS=agent:lead:SECRET1,planner:ana:SECRET2,integration:hastus:SECRET3 npm run serve
```

An agent's working loop:

```sh
# Open a study
curl -X POST localhost:4100/v1/studies -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' -d '{"id":"my-study","title":"My study"}'

# Report activity and spend
curl -X POST localhost:4100/v1/studies/my-study/activity -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' \
  -d '{"kind":"usage","model":"claude-opus-5-5","inputTokens":1200,"outputTokens":300,"costUsd":0.04}'

# Add a figure: rejected unless the quote is on that page and contains the value
curl -X POST localhost:4100/v1/studies/my-study/figures -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' \
  -d '{"id":"riders","label":"Riders","value":1680,"basis":{"kind":"cited","citation":{"contextId":"ttc-anp-2026","page":118,"quote":"weekly system ridership increase of 1,680 customers"}}}'

# Hear about everything, live
curl -N 'localhost:4100/v1/events?access_token=SECRET1'
```

## Repo

- `services/api`: the service and the collector (`collect.ts`)
- `apps/display`: the display, Preact with a WebGL map in a worker
- `packages/contracts`: types and schemas shared by every client
- `clients`: seed, replay and decide, via the public API
- `evals`: eval cases, inputs and scorer
- `scripts`: data pipelines from GTFS and the plan PDFs
- `docs`: [system and API](docs/system.md),
  [decisions, made and open](docs/decisions.md),
  [what agents should do](docs/queries.md), [eval set](docs/evals.md),
  [PNNL-style benchmark](docs/benchmark.md), [skills to build](docs/skills.md),
  [fast rollout](docs/rollout.md), [corrections to the report](docs/report-corrections.md)

## Data

TTC schedules and live positions come from the City of Toronto's
[Open Data portal](https://open.toronto.ca/), under the Open Government
Licence – Toronto. Plan and standards pages are from public TTC documents,
included as text and page images for checking citations.
