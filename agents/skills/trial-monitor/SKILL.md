---
name: trial-monitor
description: Follow a service change on trial with live data: measured on-time departures by trial week and so far, each with its sample size, kept apart from the published forecasts.
---
A recommended major change runs a trial of at least twelve months, then a post-implementation review (ttc-anp-2026 p. 115; ttc-standards-2024 pp. 29–30). Public data measures reliability from the first week; ridership has to come from the TTC at the review.

1. Measure with trial_on_time. It reads the study's timeline and does the arithmetic: departures measured and scheduled, and the share on time, by trial week and for the trial so far, for the study's watched service patterns and for the whole network on the same days. Don't add up days or work out shares yourself.
2. Report each result with its sample: "<share> of <N> departures left on time, trial weeks <a>–<b>". Name the window, and give both: the Service Standards' on-time departure, 1 minute early to 5 minutes late (ttc-standards-2024 p. 16), and the window the TTC's monthly KPI reports have used since February 2025, on time to 5 minutes late. No source here has a page for the second, so attribute it to the KPI reports.
   - Under 20 departures there is no share: say there are too few to judge, and how many there are.
   - If far fewer departures were measured than scheduled, say so: missed trips and gaps in the feed both hide inside an on-time rate.
   - Compare with the network over the same days when it helps.
3. Keep measured and forecast apart. The timeline's forecasts are published weekly figures, claims rather than results: never add them up over weeks, never call them measured, and never set them against on-time results.
4. Riders and crowding can't be measured from public data: the live data gives vehicle positions, not rider counts. Say so, name the data needed, such as the TTC's ridership counts at the review, and never estimate them.
5. Call a result a pass or a fail only against a rule from list_rules. Without one, you may quote the standard's goal with its page, as context.
6. On service every 10 minutes or better, the standards judge reliability by headways, not departure times (ttc-standards-2024 pp. 16–17), and this doesn't measure headways: say so.
7. live_vehicles shows where vehicles are now. Use it to say what is running, not how reliable it is.
8. When results are mixed, drifting or too few to judge, don't conclude: call ask_planner with the question, kind judgement, then end with "For a planner to decide:" and what a planner must weigh. The review's outcome is a planner's call.

Record a measured result only when your instructions ask, with record_on_time: it records the script's own share as a computed figure, for the trial so far or one trial week. Never type a computed figure into record_figure. The service refuses it until a planner approves this version of the skill, and it counts only once a planner accepts it. If it is refused, give the result in your summary and don't retry.
