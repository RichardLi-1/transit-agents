---
name: ttc-standards
description: Test a proposed TTC service change against the Service Standards (May 2024) and the 2026 plan's tests (customer time, boardings per service hour, riders per $100, trial period), record traceable figures and checks, and say when the rules alone don't decide.
---
Sources: the 2026 plan is ttc-anp-2026, the standards ttc-standards-2024. Page numbers are read_page's; the standards' printed numbers are one lower. In ttc-anp-2026, the tests are on pp. 113–115, proposals follow from p. 116 and post-implementation reviews from p. 133. Use search_sources to find a section when you have it.

## Rules

- Call list_rules first. A check's threshold must be one of its keys, such as ttc.max-customer-minutes, ttc.min-boardings-local-peak or ttc.min-riders-per-100. Never take a threshold from memory or from a page alone.
- Match the route's class and period (ttc-anp-2026 p. 115, Table 1; ttc-standards-2024 p. 20, Table 5, where peak is weekdays 6–9 am and 3–7 pm). If no rule fits, record no check: give the published target with its page, and say a planner must set the rule.
- Try "what if" values, such as a higher minimum, with preview_change, which writes nothing. Agents never set rules.

## The tests (ttc-anp-2026 pp. 114–115)

1. Customer time: the net change in weighted customer travel time, in minutes a week. Weights: in-vehicle 1.0, wait 1.3, walk 1.8, and per transfer 1 (rail), 2 (surface on its own right-of-way) or 6 (surface in mixed traffic) (ttc-standards-2024 pp. 23 and 39). For each affected group, minutes changed × weight × customers, added up over the groups (p. 40). A net saving passes.
2. Consultation, the only qualitative test (ttc-anp-2026 p. 114): each channel in the source's own words, never averaged. Its tone is a planner's to rate.
3. Boardings per service hour: weekly riders gained ÷ weekly service hours added. Boardings at stops within 400 m of a Neighbourhood Improvement Area count 125% (ttc-anp-2026 p. 114; ttc-standards-2024 p. 19, and p. 33: 4 boardings count as 5).
4. Riders per $100: an increase must gain at least the minimum per $100 spent, and a reduction must lose fewer than that per $100 saved (ttc-anp-2026 p. 115; ttc-standards-2024 p. 21). Cite the figure the source gives. To rework it, scale that figure in a derived formula, never from net cost per passenger.
5. Net cost per passenger, the subsidy per boarding (ttc-standards-2024 p. 20), has no pass mark (ttc-anp-2026 p. 115): report it, don't check it.

A recommended change runs a trial of at least twelve months, then a post-implementation review against the same targets (ttc-anp-2026 p. 115; ttc-standards-2024 pp. 29–30). get_study gives a study's trial dates.

## Recording, when your instructions ask

- Call get_study first. Reuse its figure ids, and don't record what is already there.
- Cited: read the page, then quote the exact words holding the value, starting on that page. For a table, quote the row from its label to the cell you want, so the value is the last cell: "Peak Periods 95 50 75 20" backs 20. A saving, decrease or loss is negative, and its quote must say so.
- Derived: a formula over figure ids and rule keys, using + - * / ( ) min max, such as riders / hours. Map each name in inputs to {figure} or {assumption} and leave the value out: the service works it out. Weights and factors go in as cited figures, so they trace to a page; bare numbers only convert units, such as / 60.
- Checks: one per test, with rule citing the page that states the standard. Customer time: the weekly figure < ttc.max-customer-minutes. Boardings per hour and riders per $100: >= their minimums. For a reduction, record what is lost as a positive derived figure (formula -change) and check it with <. The sources give that direction for riders per $100 only, so for boardings per hour say a planner should confirm it.
- A test the source says wasn't done is not assessed: record no check, and don't call it a pass.
- Figures from a message, not a source, can't be cited: use them, say where they came from, and record none.
- If the service rejects something, fix the quote, page or sign, or drop it. Never send it again unchanged.

## Watch for

- Two ridership standards: the tests require at least 11 riders per $100 (ttc-anp-2026 p. 115), but the post-implementation reviews cite "the standard of 12 new customer trips generated per service hour spent" (pp. 134 and 140), while their own tables use 11 per $100 (p. 135). Use the rule from list_rules, cite both pages, and say a planner must confirm which applies.
- The standards' appendix gives a streetcar minimum of 20 at peak and 10 off-peak (ttc-standards-2024 p. 33), against 50 and 35 in Table 5 (p. 20).
- A page's own verdict, such as "passes this metric", is a claim: test it against the rule and report any disagreement.

## When the rules alone don't decide

The plan generally recommends adopting a change that passes the tests and not one that fails them, and leaves mixed results and exceptional cases to discretion (ttc-anp-2026 p. 115). Either way, planners decide. When only some tests pass, such as customer time failing on a change that saves service hours, when consultation is split or runs against the tests, or when a review's results are mixed, don't pick an outcome. Call ask_planner with the question, kind judgement, then end your summary with "For a planner to decide:", the question, each test's result with its page, and what a planner must weigh, cited.
