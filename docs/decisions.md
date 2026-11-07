# Design decisions

Why the design is the way it is, and what the owner still has to decide. An
independent reviewer tested the running code against the real TTC plan twice.
The design rules are in [system.md](system.md).

## 1. Agents cannot decide

A request with no token acted as a planner, and agents set the thresholds. Now
tokens are required by default, and open access warns at startup. Thresholds,
consultation and skill results count only once a planner sets, rates or accepts
them.

## 2. Citations are checked

Five ways past the check, and the fix for each:

- Reordered words passed, so "adopted" could come from "not adopted". Prose must
  now match exactly.
- A flipped sign turned Highland Creek's failing test into a pass. A negative
  value needs wording such as "decrease" or "savings".
- Any cell of a quoted table row passed. The row must match in order, with the
  value as its last cell.
- A quote wholly on the next page passed. A quote may run onto the next page but
  must start on the cited one.
- An agent could cite its own upload. Only documents from planners or agency
  systems can be cited.

Still open: the checker can't prove a cell's column, so table figures are flagged.

## 3. Rosedale

It was shown as a real override, dropped after feedback despite passing every
test. But consultation is one of the TTC's own tests, "the only qualitative
metric" (2026 plan, p. 114), so Rosedale didn't pass everything. Now findings
count in the analysis, split consultation reads "needs judgement", deciding
against it is not an override, and the demo no longer claims one.

## 4. The log

The reviewer judged the hash-chained log itself sound, but found:

- The tamper claim was oversold. It is now "tamper-evident to anyone who kept an
  earlier head hash".
- A member of the public's words couldn't be removed when retention rules or FOI
  require it. Content now sits outside the chain.
- Two figures depending on each other broke the study list. Cycles are now
  rejected on entry.
- Tracing a figure scanned the whole log. A trace now reads a stored position.
- Retried usage reports were counted twice. Writes now accept an idempotency key.

## 5. Time

Fast-forwarding to the review date summed forecasts into a total that rises
whatever happens, invented vehicles after the timetable ends on December 21, and
started measured data at nothing. Now the axis counts trial weeks, forecasts are
flat weekly rates, vehicles and the daily rhythm stop with the timetable, and
measured results show by week, with coverage against scheduled trips and "Too
few" below 20 departures.

## 6. The map

The custom WebGL renderer draws a tilted view fading into white. It stays, for
its scripted camera, 20 KB app and offline running, though the accessibility
score doesn't depend on it and MapLibre also runs without tiles. Now a flat 2D
map takes over if WebGL is missing or lost, the study line and vehicles no longer
fade, and moving rendering into a worker raised mobile Lighthouse performance
from 66 to 98.

## 7. Measurement

The collector ran inside the API, so every restart cut a gap in the trial
record. It counted only departures it saw, so cancelled trips raised the on-time
rate. Now the collector runs as its own process, results show coverage against
the timetable, and raw positions for the study routes are archived daily for
research.

## 8. Evals

Guessing beat handing a judgement case to a planner, the rules-only control used
the answer key's test results, eight real decisions are too few, and public plans
can leak answers. Now hand-overs on judgement cases count as correct and are
reported apart, the control is called an upper bound for rules alone, counts are
reported beside rates, and changed-number copies and a sealed 2027 test address
leakage ([evals.md](evals.md)).

## 9. Brownfield

HASTUS and EMME had no sample, parser or format, and a changed spreadsheet with no
readable text was silently dropped. The claim is now file-level ingestion through
a watched folder, untested on real agency exports. Files are hashed by their
bytes, so changes always register.

## 10. Zoo history on the display

Rejected, because the owner's rule is that only dates from today on appear, and
the display stays minimal. The Zoo route's drift over three summers stays in
[benchmark.md](benchmark.md).

## 11. Fast rollout

The owner says construction is slow, so this must be fast. The challenge: a study
isn't a built project, so the comparison is a category error. Unresolved. The docs
make the claim the evidence supports: evidence in week 1 of a trial instead of at
the month-12 review, and a first study on day 1 from public data
([rollout.md](rollout.md)).

## 12. Digital twins

A twin plugs in as a skill. The service records what it predicted and what was
decided, and does not replace it.

## For the owner to decide

- Keep the legend words "Live" and "Scheduled"? They are the display's only
  explanatory text.
- Keep the "Replay" tag in chat? It shows only while the scripted run plays.
- How to frame "fast" in the pitch (decision 11).
- A Sunday demo shows no live 52F, which doesn't run Sundays. The 11B does.
