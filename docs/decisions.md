# Design decisions

How the design was argued. An independent reviewer tested the running code
against the real TTC plan twice. Each decision records the position, the
challenge, and what changed.

## 1. Agents cannot decide

- **Position:** only planner tokens can record a decision.
- **Challenge:** this was theatre. A request without a token acted as a planner, so an agent could leave its token off. Agents also set the thresholds, so they defined what passing meant.
- **Outcome:**
  - Tokens are required by default. Open access is a local demo setting you have to switch on, and it warns at startup.
  - Thresholds come only from rules a planner sets.
  - Consultation counts only once a planner rates it.
  - A skill's result counts only once a planner accepts it.
  - Agents can't create webhooks, and webhook hosts need approval.

## 2. Citations are checked

- **Position:** a quote must be on the cited page, and the value must be in the quote.
- **Challenge:** five ways through:
  - Reordered words passed, so "adopted" could come from "not adopted".
  - A flipped sign turned Highland Creek's failing test into a pass.
  - Any cell in a quoted table row passed.
  - A quote sitting wholly on the next page passed.
  - An agent could cite a document it had uploaded itself.
- **Outcome:**
  - Prose must match exactly.
  - A table row must match in order, and the value must be its last cell.
  - A negative value needs wording that says so, such as "decrease" or "savings".
  - A quote can run onto the next page but must start on the cited one.
  - Only documents added by planners or agency systems can be cited.
- **Still open:** the checker can't prove which column a table cell is in, so table figures are flagged.

## 3. Rosedale

- **Position:** it passed every test and was dropped after feedback, so it was a real override.
- **Challenge:** consultation is one of the TTC's own tests, described as "the only qualitative metric" (2026 plan, p. 114). Rosedale didn't pass everything.
- **Outcome:** findings count in the analysis. Split consultation reads "needs judgement", and deciding against it is not an override. The demo no longer claims an override.

## 4. The log

- **Position:** one append-only, hash-chained log, with all state derived from it.
- **Challenge:** the reviewer judged the log itself sound, but found:
  - The tamper claim was oversold.
  - Two figures depending on each other broke the study list.
  - Tracing a figure scanned the whole log.
  - Retried usage reports were counted twice.
  - A permanent chain can't remove a member of the public's words when retention rules or FOI require it.
- **Outcome:**
  - Cycles are rejected on entry.
  - A trace reads a stored position.
  - Writes accept an idempotency key.
  - Content sits outside the chain, so it can be removed while the chain still verifies.
  - The claim is now "tamper-evident to anyone who kept an earlier head hash".

## 5. Time

- **Position:** fast-forward from today to the review date, with forecasts adding up as it plays.
- **Challenge:** a running total rises whatever happens. The timetable ends December 21, so vehicles drawn after that are invented. Measured data starts at nothing.
- **Outcome:**
  - The axis counts trial weeks.
  - A forecast shows as a flat weekly rate.
  - Vehicles and the network's daily rhythm stop where the timetable stops.
  - Measured results show by week, with coverage against scheduled trips, and "Too few" below 20 departures.

## 6. The map

- **Position:** a custom WebGL renderer, with no map library, no tiles, and a tilted view fading into white.
- **Challenge:** the accessibility score doesn't depend on it, MapLibre also runs without tiles, the display goes blank without WebGL, and the subject shouldn't fade into the fog.
- **Outcome:**
  - The renderer stays, because the camera is scripted, the whole app is 20 KB, and it runs offline.
  - The study line and vehicles no longer fade.
  - A flat 2D map takes over if WebGL is missing or lost.
  - Rendering moved into a worker, which raised mobile Lighthouse performance from 66 to 98.

## 7. Measurement

- **Challenge:** the collector ran inside the API, so every restart cut a gap in the trial record. It also counted only departures it saw, so cancelled trips raised the on-time rate.
- **Outcome:** the collector runs as its own process. Results show coverage against the timetable. Raw positions for the study routes are archived daily for research.

## 8. Evals

- **Challenge:**
  - Handing a judgement case to a planner scored as a failure, so guessing scored better.
  - The rules-only control used the answer key's own test results.
  - Eight real decisions are too few.
  - The plans are public, so answers can leak.
- **Outcome:**
  - A hand-over on a judgement case counts as correct and is reported separately.
  - The control is described as an upper bound for rules alone.
  - Counts are reported beside rates.
  - Changed-number copies and the sealed 2027 test address leakage.

## 9. Brownfield

- **Challenge:** HASTUS and EMME had no sample, parser or format. A changed spreadsheet with no readable text was silently dropped.
- **Outcome:** the claim is now file-level ingestion through a watched folder, untested on real agency exports. Files are hashed by their bytes, so changed files always register.

## 10. Zoo history on the display

- **Challenge:** show the Zoo route's published results over three summers, so viewers see that results drift.
- **Outcome:** rejected for the display, because the owner's rule is that only dates from today on appear, and the design is minimal. It stays in the benchmark docs.

## 11. Fast rollout

- **Position (owner):** construction projects are slow, so this must be fast.
- **Challenge:** a study isn't a built project. Comparing a tool's rollout with construction time is a category error.
- **Outcome:** unresolved, and the owner's call. The docs make the claim the evidence supports: evidence in week 1 of a trial instead of at the month-12 review, and a first study in weeks.

## 12. Digital twins

- **Outcome:** a twin plugs in as a skill. The service records what the twin predicted and what was decided. It does not replace the twin.

## For the owner to decide

- Keep the two legend words, "Live" and "Scheduled"? They are the only explanatory text on the display.
- Keep the "Replay" tag in chat? It shows only while the scripted run is playing.
- How to frame "fast" in the pitch (decision 11).
- A demo on a Sunday shows no live 52F, which doesn't run Sundays. The 11B does.
