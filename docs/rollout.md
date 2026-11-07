# Fast rollout

How an agency adopts the service in stages. It can be fast because nothing is
replaced, so nothing waits on a replacement. Each stage adds one connection, is
useful alone, and can be switched off without affecting anything the agency runs.

- **Evidence about a change arrives in week 1, not at the month-12 review.** The
  Lawrence trial began on November 1, 2026. This repo measures its reliability
  from public data now, and its review is due in November 2027.
- **A first study runs on day 1**, at stage 0, which needs nothing from the agency.
  Stage 0 is real today: this repo runs a real study from public sources.

Construction takes decades: Eglinton took 19 years from plan to opening. That is
the motivation, not a comparison ([decision 11](decisions.md#11-fast-rollout)).

## Stages

Durations are targets, not results.

| Stage | Target | What happens | Agency provides | To enter, must show |
|---|---|---|---|---|
| 0. Public | Day 1 | Studies on public plans, standards and feeds | Nothing | |
| 1. Read-only | Weeks 1–2 | Aggregate exports land in a watched folder | A scheduled export, no personal data | Beats the rules-only control, and no invented sources got through |
| 2. In the flow | Month 1 | Teams or Slack notifications; a named planner signs real studies | A webhook and a named overseer | Three planners confirm it saves them time |
| 3. Internal data | Months 2–3 | Personal data, on the agency's own hardware | Privacy and security review | A completed privacy assessment, a passed security review, and an agreement with staff |

## What is slow

Not the software. These are:

- **Procurement:** stages 0 and 1 are small enough for a pilot or research
  partnership. Check agency thresholds.
- **Privacy review:** stages 0–2 hold no personal data, so it doesn't block the start.
- **Security review:** the service runs in the agency's network and needs no
  inbound access.
- **IT backlog:** existing systems don't change. A file export is the only ask.
- **Staff trust:** commit in writing to no headcount targets, before work starts.

## Existing systems

No system changes, except where noted.

- **GTFS and live feeds:** public URLs.
- **HASTUS:** scheduled export to the watched folder. No change if exports exist.
- **EMME and other models:** outputs to the folder, or called as a skill.
- **Ridership and fare data:** aggregate export, or an on-prem connector at stage 3.
- **SharePoint or network drives:** synced to the watched folder.
- **Teams or Slack:** webhook out, approvals back through the API. Add a webhook.
- **Digital twins:** called as a skill, with results logged.
- **Records and FOI:** log export. Add it to the retention schedule.

## Existing processes

The agency's process stays the same. Studies fit steps it already has:

- **TTC schedule changes,** about every six weeks: check each minor change against
  the standards.
- **TTC Annual Network Plan** (proposals, two consultation rounds, Board): draft
  technical assessments, summarize consultation.
- **TTC trials** (12 months, then a review): follow results, draft the review.
- **Metrolinx business cases** (Initial, Preliminary, Full, Post In-Service): draft
  each case, carry assumptions forward.
- **Ontario assessment process** (notice, consultation, report, 120-day clock):
  track deadlines, draft sections.

## Not built yet

Needed for a real deployment, outside the hackathon:

- **Single sign-on.** Tokens work today. Agencies will expect Entra ID or similar.
- **Approving from Teams or Slack.** Messages go out today. Approving needs a
  public callback.
- **Retention rules.** Content can be removed ([system.md](system.md)), but the
  agency must decide what its schedule requires. The TTC falls under MFIPPA,
  Metrolinx under FIPPA.
- **Signed decisions.** A planner's token is a shared secret. Decisions should be
  signed with a passkey.
- **Tested connectors.** HASTUS and EMME exports haven't been tried with real files.
