# Skills

Which sources in the report can become skills, what to build first, and the rule
values to code.

None can be used directly: rebuild from published methods and public rules.

## Build these first

All run on public data today.

- `ttc-standards-check` (script): tests a proposal against the [TTC Service Standards, May 2024](https://cdn.ttc.ca/-/media/Project/TTC/DevProto/Documents/Home/About-the-TTC/Projects-Landing-Page/Transit-Planning/Service-Standards_May-2024.pdf?rev=6c96a85cc0a64147ad424f949dabce64).
- `standards-navigator` (model): answers rule questions with page citations. Uses [Wang & Shalaby](https://arxiv.org/abs/2410.14147)'s method. Their GPT-3.5 demos on GO Transit had no evaluation.
- `otp-check` (script): measures on-time performance from live data. Uses [TTC ScheduleWatch](https://github.com/neil-simmons/TTC-ScheduleWatch)'s method; its code is all rights reserved. ScheduleWatch measures arrivals, not departures, and rarely finds the origin stop, so it can't test the TTC rule as shipped.
- `travel-time-compare` (script around [r5py](https://github.com/r5py/r5py)): compares travel times before and after a route change, replacing the simulator. r5py has no scenario feature, so testing a change means editing the GTFS.

## Built

In `agents/skills`. Printed page numbers, as below; the skills cite read_page's.

- `metrolinx-business-case`: sets out the four cases, optimism bias and the appraisal rules, and which figures are precedents or gaps.
- `ttc-service-change`: classifies a change as minor or major by the Standards' Table 7 (p. 21), and lists the steps each class needs (pp. 20–30). Its script never guesses: what the sources don't say, it names as missing, and a change Table 7 doesn't list goes to a planner. So does a change of minor kinds that needs more than existing equipment and the adopted budget, unless the sources say its effect on resources is significant: the standards don't settle it (pp. 21, 28).
- `metrolinx-bca`: discounts a project's own benefit and cost streams to an NPV and a benefit-cost ratio, with the values below. Its script computes nothing while an input is missing or a planner's rule differs. It asks whether the costs include escalation, and where they leave it out, grows capital and O&M costs 1% a year to 30 years from the base year (pp. 84, 170). Where Table 5.6's printed formula reads inverted, it keeps the total uplift at the published one, as the study's seed does, and flags that for a planner to confirm.
- `business-case-template`: lays out the chapters, and what each case needs at each stage, from the stage matrix (Business Case Manual Volume 2, p. 20).
- `engagement-needs`: proposes what to make so people near a change can picture it before they are consulted: a poster or a short video at one place. Specialists add a need only with its script, which pins the need to the study's line, refusing a place more than 500 m from it, and refuses one without a citation. Only a planner asks for one to be made.
- `gtfs-analyst`: counts a TTC route's scheduled trips by hour and in each period of the Standards' Table 3 (p. 13), and its first and last trips, from the TTC timetable in the repo, with the timetable's last day. Fixed functions, not model-written code. The timetable keeps only where each trip starts, so every count is for both directions together, and it can't answer questions about a stop or one direction.
- `transit-cost-benchmark`: compares a rail line's capital cost per km with the Ontario Line's and Relief Line South's, from Table 31 of the Ontario Line Initial Business Case (p. 78), on that case's own basis, and says what the comparison can't tell. It uses only the business cases' own figures: other projects' costs, such as the [Transit Costs data](https://ultraviolet.library.nyu.edu/records/9wnjp-kez15) (CC BY-NC), aren't in the sources.
- `gis-analyst`: answers where-questions in Toronto, Waypoint-style, from open data: buffers a route's stops, its shape or the study's line, overlays the buffer with 2021 census areas, neighbourhoods or Neighbourhood Improvement Areas, and counts police-reported KSI collisions inside. The service does the geometry with Turf.js, saves each result as a map layer, and records its totals as figures citing the dataset ([decisions.md](decisions.md#13-gis-figures-cite-a-dataset-not-a-page)). Census totals are area-weighted estimates, the census counts people in low income rather than households, and a catchment's population is never ridership.
- `planning-glossary`: for every study, 40 entries of business-case and service-planning jargon, each in its source's words with the page, which the tests check.

## Build next

- `tpap-clock`: tracks Transit Project Assessment deadlines under [O. Reg. 231/08](https://www.ontario.ca/laws/regulation/080231).
- `gtfs-analyst` for stops and directions: needs each trip's stop times and direction, which the repo's timetable files don't keep. [TransitGPT](https://github.com/UTEL-UIUC/TransitGPT)'s method, a model writing code that a sandbox runs, is the best evidence: up to 93% on 100 tasks, graded by its authors. No licence, so ask them before reusing code, and replace its bare `exec` sandbox.
- `edsta-watch`: tracks Bill 194 regulations in Ontario proclamations and e-Laws.
- `comment-tagger`: tags consultation comments by topic, route and sentiment. Needs agency comments, and the method from [Abedini & Dianat](https://easychair.org/smart-program/TD-2026/2026-06-24.html#talk:316250), known only from an abstract with self-reported claims (see [corrections](report-corrections.md)).

## Other sources

- **Don't use** [AAAM](https://github.com/Smart-Railway/AAAM) or transit_sim. AAAM is rail only, while buses are 82% of TTC weekday trips. It needs passenger-level trip data we lack, has an academic licence, and takes riders as an input, so it can't show a change in ridership. transit_sim's linked repo is gone. A surviving copy has no licence or validation, and is older code from AAAM's project.
- **Borrow later:** [Vu et al.](https://arxiv.org/abs/2510.19497), Apache-2.0 code. Five agents, not validated against observed data. Possible use: a qualitative probe of rider reactions.
- **Reading only:** [Liu, Yang & Yin](https://arxiv.org/abs/2412.06681) (ten households on a toy network), an [urban agents survey](https://arxiv.org/abs/2507.00914), and the [San Antonio study](https://arxiv.org/abs/2407.11003), whose [MIT-licensed quiz](https://github.com/UTEL-UIUC/GTFS_LLM) can test `gtfs-analyst`.

## What no skill can compute yet

Riders and crowding. No open tool produces them from GTFS and OSM alone, because
they need demand data. From GTFS and OSM alone,
[r5py](https://github.com/r5py/r5py) gives travel times and access,
[OpenTripPlanner](https://github.com/opentripplanner/OpenTripPlanner) gives
itineraries, and [AequilibraE](https://github.com/AequilibraE/aequilibrae) builds
only the network; it gives loads once given a demand matrix. Until an agency
supplies demand data, a skill should return **not computable**, not an estimate.

## Numbers for `ttc-standards-check`

May 2024 Service Standards, printed page numbers.

| Rule | Value | Page |
|---|---|---|
| On-time departure target, surface | 90%, leaving the origin timepoint 1 minute early to 5 late | 15 |
| Boardings per hour, class average / route minimum, peak | Streetcar 95/50, local bus 75/20, Tier 1 express 65/40, Tier 2 express 50/40, community 6/4 | 19 |
| The same, off-peak | Streetcar 85/35, local bus 55/10, Tier 1 express 55/30 | 19 |
| Crowding, peak / off-peak | 12 m bus 51/35, 18 m bus 77/46, streetcar 130/70 | 14 |
| Minimum frequency, minutes | Rapid 6, streetcar and local 30, Tier 1 10–15, Tier 2 15, community 90 | 13 |
| Change in ridership | 0.11 customers per dollar | 20 |
| Near a Neighbourhood Improvement Area | Boardings count 125% | 18 |
| Minor change | Existing equipment and budget, span within 90 minutes | 21 |

Watch out for:

- The standard's on-time window differs from TTC [KPI reports](https://cdn.ttc.ca/-/media/Project/TTC/DevProto/Documents/Home/Transparency-and-accountability/Reports/KPI-Reports/July-2025-Monthly-Metrics-Report.pdf?rev=72260e0300ec423491b3b2ec0dfafbeb&hash=908CB3E85F6DDCFA7CAE34F422310775), which moved to 0 to 5 in February 2025. Compute both.
- At 10-minute frequency or better, the standards use headway tests and count 20 or more minutes late as a missed trip, so schedule adherence misleads.
- The p. 32 appendix gives a streetcar minimum of 20/10, conflicting with Table 5's 50/35.
- [Round Two](https://www.ttc.ca/transparency-and-accountability/transit-planning/service-standards-review) of the standards review is due in early 2027, so version every rule. The current standards omit Lines 5 and 6.
- Live trip IDs match the BusTime or Merged GTFS feeds, not the main TTC Routes and Schedules feed.

## Numbers for `metrolinx-bca`

Business Case Manual [Volume 2](https://assets.metrolinx.com/image/upload/v1663237565/Documents/Metrolinx/Metrolinx-Business-Case-Guidance-Volume-2.pdf), printed page numbers.

| Parameter | Value | Page |
|---|---|---|
| Discount rate, economic | 3.5% real | 98 |
| Appraisal period | 5 to 60 years, growth capped at 30 | 98 |
| Value of time | $18.79 in 2021 dollars, 0% growth | 170 |
| Walk and wait weights | 2.0 and 2.5, with a 5-minute interchange penalty | 171 |
| Discount rate, financial | 5.5%, with 2% inflation, nominal | 176 |
| Method | Increment over business as usual, excluding sunk costs, rule of a half | 85, 103, 110 |
| Capital optimism bias | 64% / 18% / 9% / 4% at 0–10 / 11–20 / 21–30 / 31–100% design | 94 |
| Cost growth, capital and O&M | 1% a year real, to 30 years from the base year, where estimates leave escalation out | 84, 170 |

Watch out for: rebase value of time before use. The City of Toronto
[used $21.09](https://www.toronto.ca/legdocs/mmis/2023/ex/bgrd/backgroundfile-240130.pdf)
in 2023 dollars. Table 5.6's adjusted uplift formula appears to be inverted, so
confirm it before coding. TTC and Metrolinx weights differ, so never reuse one
for the other.
