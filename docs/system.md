# System

How the service fits together: its parts, rules, API and roles. Agents,
planners, existing agency systems and the display are all clients of it.

```mermaid
flowchart LR
    subgraph existing["Existing systems, unchanged"]
        direction TB
        feeds["Public feeds<br/>GTFS · GTFS-RT · plans · board reports"]
        exports["Agency exports<br/>HASTUS · EMME · ridership · SharePoint"]
        models["Models and digital twins"]
    end

    subgraph agents["Agents and skills"]
        direction TB
        lead["Lead agent"]
        subs["Sub-agents, one per question"]
        skills["Skills"]
        lead --> subs --> skills
    end

    subgraph service["Transit Agents service"]
        direction TB
        api["API<br/>context · studies · figures · assumptions · decisions"]
        gate{{"Enforced at the door<br/>no source, no figure<br/>quote must be on the cited page<br/>planners set rules, rate consultation, decide"}}
        log[("Append-only log<br/>hash-chained")]
        views["Views<br/>draft · trace · compare · timeline · usage"]
        out["Event stream<br/>SSE · signed webhooks"]
        api --> gate --> log
        log --> views
        log --> out
    end

    collector["Collector<br/>separate process<br/>live positions · departures"]
    feeds -- "GTFS-RT" --> collector
    collector -- "measurements" --> views

    subgraph people["People and places they already work"]
        direction TB
        chat["Teams or Slack<br/>notify"]
        display["Display"]
        planner["Named planner<br/>signs every decision"]
        external["Board · Auditor · public"]
    end

    feeds --> api
    exports -- "watched folder" --> api
    models -- "called as a skill" --> skills
    agents <--> api
    views --> display
    out --> chat
    out --> external
    chat --> planner
    display --> planner
    planner -- "decision and reason" --> api
```

## Rules

1. **The log is the only source of truth.** Every write is one log entry.
   Drafts, dashboards, webhooks and the display all read from it, so they can't
   disagree with it.
2. **The API, not prompts, enforces guarantees.** A figure with no source is
   rejected. So is a cited figure whose quote isn't on the cited page, whose
   value isn't in the quote, or whose sign contradicts the wording. Only
   documents added by planners or agency systems can be cited.
3. **People decide.** Agents draft and check. Planners set the rules checks use,
   rate how consultation reads, accept skill results and record decisions.
   Deciding against a clear analysis is recorded as an override, with a reason.
4. **Existing systems stay.** Data arrives as exports they already produce, and
   decisions leave as webhooks. Nothing is migrated.
5. **Two clocks, never mixed.** The log always uses real time. The display's
   time control is a view of schedules and forecasts, and writes nothing.
6. **Measured and forecast stay apart.** A separate collector measures live
   data. Forecasts are published claims, shown as flat rates, never added up.
7. **Content can be removed; history can't.** Entry content sits outside the
   hash chain, so it can be removed for retention or privacy while the chain
   still verifies and shows that something was there.

## API

Full schema at `GET /openapi.json`.

- Add context: `POST /v1/context`, or drop a file in the watched folder
- Search source pages: `GET /v1/search`
- Open a study: `POST /v1/studies`
- Report agent activity, tokens and cost: `POST /v1/studies/{id}/activity`
- Add a figure: `POST /v1/studies/{id}/figures`
- Test a figure against a rule: `POST /v1/studies/{id}/checks`
- Add a finding, such as consultation: `POST /v1/studies/{id}/findings`
- Rate how a finding reads: `PUT /v1/studies/{id}/findings/{finding}/tone`
- Approve a skill version: `PUT /v1/skills/{name}`
- Accept a skill's result: `POST /v1/studies/{id}/figures/{figure}/accept`
- Set or change a rule or assumption: `PUT /v1/assumptions/{key}`
- Try a change without recording it: `POST /v1/studies/{id}/preview`
- Record a decision: `POST /v1/studies/{id}/decisions`
- Read a study: `GET /v1/studies/{id}`
- Trace a figure to its source: `GET /v1/studies/{id}/figures/{figure}/trace`
- What changed between versions: `GET /v1/studies/{id}/compare`
- Results over time: `GET /v1/studies/{id}/timeline`
- Read or verify the log: `GET /v1/log`, `GET /v1/log/verify`, `GET /v1/log/head`
- Remove an entry's content: `POST /v1/log/{seq}/remove-content`
- Live vehicles: `GET /v1/live/vehicles`
- Tokens and cost: `GET /v1/usage`
- Stream everything live: `GET /v1/events`
- Be told about decisions: `POST /v1/subscriptions`
- Connect an agent over MCP: `/v1/mcp`

## Who may do what

Every request needs a token, unless open access is switched on for a local demo.

- **Viewer:** reads.
- **Integration:** reads, adds citable context, subscribes webhooks.
- **Agent:** reads, adds context that can't be cited, adds figures and findings.
- **Planner:** everything, with citable context. Only planners set rules, rate,
  accept and decide.

Webhooks can only go to hosts listed in `WEBHOOK_HOSTS`.
