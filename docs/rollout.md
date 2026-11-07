# Fast rollout

Two claims, each with evidence behind it:

1. **Evidence about a change arrives in week 1, not at the month-12 review.** The
   Lawrence trial began on November 1, 2026. This repo measures its reliability
   from public data now, and its review is due in November 2027.
2. **A first study runs on day 1.** Stage 0 below needs nothing from the agency.

Rollout can be fast for one reason: **nothing is replaced, so nothing waits on a
replacement.** Each stage adds one connection, is useful alone, and can be switched
off without affecting anything the agency runs.

Construction takes decades: Eglinton took 19 years from plan to opening. That is
the motivation, not a comparison. A study is not a built project.

## Stages

The durations are targets, not results.

| Stage | Target | What happens | Needs from the agency |
|---|---|---|---|
| 0. Public | Day 1 | Studies run on public plans, standards and feeds | Nothing |
| 1. Read-only | Weeks 1–2 | Aggregate exports land in a watched folder | A scheduled export, no personal data |
| 2. In the flow | Month 1 | Teams or Slack notifications, and a named planner signs real studies | A webhook and a named overseer |
| 3. Internal data | Months 2–3 | Personal data, on the agency's own hardware | Privacy and security review |

Stage 0 is real today: this repo runs a real study from public sources.

## Gates between stages

A stage only opens when the last one has earned it.

| To enter | Must show |
|---|---|
| Stage 1 | Beats the rules-only control. No invented sources got through. |
| Stage 2 | Three planners confirm it saves them time. |
| Stage 3 | A completed privacy assessment, a passed security review, and an agreement with staff. |

## What is actually slow

Writing software isn't the slow part. These are, and each has a plan.

| Risk | How the design deals with it |
|---|---|
| Procurement | Stages 0 and 1 are small enough to start as a pilot or research partnership. Check agency thresholds. |
| Privacy review | Stages 0–2 hold no personal data, so review doesn't block the start. |
| Security review | The service runs in the agency's network, with no inbound access needed. |
| IT backlog | No changes to existing systems. A file export is the only ask. |
| Staff trust | Commit in writing to no headcount targets, before work starts. |

## Fitting into existing systems

| System | Connection | Change needed to that system |
|---|---|---|
| GTFS and live feeds | Public URLs | None |
| HASTUS | Scheduled export to the watched folder | None, if exports exist. Untested on a real export. |
| EMME and other models | Run outputs to the folder, or called as a skill | None. Untested on real outputs. |
| Ridership and fare data | Aggregate export, or on-prem connector at stage 3 | None |
| SharePoint or network drives | Sync a folder to the watched folder | None |
| Teams or Slack | Webhook out, approvals back through the API | Add a webhook |
| Digital twins | Called as a skill, with results logged | None |
| Records and FOI | Export of the log | Add to the retention schedule |

## Fitting into existing processes

The agency's process stays the same. Studies map onto steps it already has.

| Process | Steps it already has | Where this fits |
|---|---|---|
| TTC schedule changes | About every six weeks | Check each minor change against the standards |
| TTC Annual Network Plan | Proposals, two consultation rounds, Board | Draft technical assessments, summarize consultation |
| TTC trials | 12 months, then a review | Follow results, and draft the review |
| Metrolinx business cases | Initial, Preliminary, Full, Post In-Service | Draft each case, and carry assumptions forward |
| Ontario assessment process | Notice, consultation, report, 120-day clock | Track deadlines, and draft sections |

## Not built yet

These matter for a real deployment, and are outside the hackathon:

- **Single sign-on.** Tokens work today. Agencies will expect Entra ID or similar.
- **Approving from Teams or Slack.** Messages go out today. Approving needs a public callback.
- **Retention rules.** Entry content can be removed while the chain stays intact, but the agency must decide what its schedule requires. The TTC falls under MFIPPA and Metrolinx under FIPPA.
- **Signed decisions.** A planner's token is a shared secret. A real deployment should sign decisions with a passkey.
- **Tested connectors.** HASTUS and EMME exports haven't been tried with real files.
