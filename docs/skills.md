# Skills

Which sources from the report can become skills, and what to build first.

**Short answer:** no paper or repo can be used directly. The two most useful
codebases grant no reuse rights, and the simulators can't answer the question.
Rebuild from published methods and public rules.

## Build these first

All run on public data today.

| Skill | Does | Script or model | Built from |
|---|---|---|---|
| `ttc-standards-check` | Tests a proposal against TTC thresholds | Script | [TTC Service Standards, May 2024](https://cdn.ttc.ca/-/media/Project/TTC/DevProto/Documents/Home/About-the-TTC/Projects-Landing-Page/Transit-Planning/Service-Standards_May-2024.pdf?rev=6c96a85cc0a64147ad424f949dabce64) |
| `standards-navigator` | Answers rule questions with page citations | Model, over the documents | Method from Wang & Shalaby |
| `gtfs-analyst` | Answers service, stop and headway questions by writing and running code | Model writes, sandbox runs | Method from TransitGPT, rebuilt |
| `otp-check` | Measures on-time performance from live data | Script | Method from ScheduleWatch, rebuilt |
| `travel-time-compare` | Compares travel times before and after a route change | Script around [r5py](https://github.com/r5py/r5py) | Replaces the simulator |

## Build next

| Skill | Does | Needs |
|---|---|---|
| `ttc-service-change` | Classifies a change as minor or major, and lists required steps | Standards pp. 21–22 |
| `metrolinx-bca` | Runs a benefit-cost analysis by the Metrolinx method | Business Case Manual Volume 2 |
| `business-case-template` | Lays out the four-part case and its required contents | Manual Volume 2, stage matrix p. 20 |
| `tpap-clock` | Tracks Transit Project Assessment deadlines | [O. Reg. 231/08](https://www.ontario.ca/laws/regulation/080231) |
| `transit-cost-benchmark` | Compares cost per km with other projects | [Transit Costs data](https://ultraviolet.library.nyu.edu/records/9wnjp-kez15), CC BY-NC |
| `edsta-watch` | Tracks Bill 194 regulations | Ontario proclamations and e-Laws |
| `comment-tagger` | Tags consultation comments by topic, route and sentiment | Method from Abedini & Dianat, plus agency comments |

## Reading list verdicts

| Source | Verdict | Why |
|---|---|---|
| [AAAM](https://github.com/Smart-Railway/AAAM) | Don't use | Rail only, while buses are 82% of TTC weekday trips. Needs passenger-level trip data we don't have. Academic licence. Riders are an input, so it can't show a change in ridership. |
| transit_sim | Don't use | The linked repo is gone. A surviving copy has no licence, no validation, and is older code from the same project as AAAM. |
| [TransitGPT](https://github.com/UTEL-UIUC/TransitGPT) | Borrow the method | Best evidence: up to 93% on 100 tasks, graded by its authors. The repo has no licence, so ask its authors before reusing code. Its sandbox is bare `exec`, so build a real one. |
| [TTC ScheduleWatch](https://github.com/neil-simmons/TTC-ScheduleWatch) | Borrow the method | All rights reserved. Measures arrivals, not departures, and rarely finds the origin stop, so it can't test the TTC rule as shipped. |
| [Wang & Shalaby](https://arxiv.org/abs/2410.14147) | Borrow the method | GPT-3.5 demos on GO Transit, with no evaluation. |
| [Abedini & Dianat](https://easychair.org/smart-program/TD-2026/2026-06-24.html#talk:316250) | Borrow the method | Abstract only. The 89+ categories and 20-to-2 hours are self-reported, with no accuracy figure. |
| [Vu et al.](https://arxiv.org/abs/2510.19497) | Borrow later | Apache-2.0 code. Five agents, not validated against observed data. Possible use: rider reactions, as a qualitative probe. |
| [Liu, Yang & Yin](https://arxiv.org/abs/2412.06681) | Reading only | Ten households on a toy network. |
| [San Antonio study](https://arxiv.org/abs/2407.11003) | Reading only | Its [MIT-licensed quiz](https://github.com/UTEL-UIUC/GTFS_LLM) can test `gtfs-analyst`. |
| [Urban agents survey](https://arxiv.org/abs/2507.00914) | Reading only | A literature survey. |

## What no skill can compute yet

Riders and crowding. No open tool produces them from GTFS and OSM alone, because
they need demand data. Until an agency supplies it, a skill should return
**not computable**, not an estimate.

| Tool | Works from GTFS and OSM alone | Gives | Doesn't give |
|---|---|---|---|
| [r5py](https://github.com/r5py/r5py) | Yes | Travel times, access | Riders, crowding |
| [OpenTripPlanner](https://github.com/opentripplanner/OpenTripPlanner) | Yes | Itineraries | Riders, crowding |
| [AequilibraE](https://github.com/AequilibraE/aequilibrae) | Network only | Loads, once given a demand matrix | Anything without one |

`r5py` has no scenario feature, so testing a route change means editing the GTFS.

## Numbers for `ttc-standards-check`

From the May 2024 Service Standards, printed page numbers.

| Rule | Value | Page |
|---|---|---|
| On-time departure target, surface | 90%, leaving the origin timepoint 1 minute early to 5 late | 15 |
| Boardings per hour, class average / route minimum, peak | Streetcar 95/50 · local bus 75/20 · Tier 1 express 65/40 · Tier 2 express 50/40 · community 6/4 | 19 |
| The same, off-peak | Streetcar 85/35 · local bus 55/10 · Tier 1 express 55/30 | 19 |
| Crowding, peak / off-peak | 12 m bus 51/35 · 18 m bus 77/46 · streetcar 130/70 | 14 |
| Minimum frequency, minutes | Rapid 6 · streetcar and local 30 · Tier 1 10–15 · Tier 2 15 · community 90 | 13 |
| Change in ridership | 0.11 customers per dollar | 20 |
| Near a Neighbourhood Improvement Area | Boardings count 125% | 18 |
| Minor change | Existing equipment and budget, span within 90 minutes | 21 |

**Watch out for:**

- **Two on-time windows.** The standard says 1 minute early to 5 late. TTC [KPI reports](https://cdn.ttc.ca/-/media/Project/TTC/DevProto/Documents/Home/Transparency-and-accountability/Reports/KPI-Reports/July-2025-Monthly-Metrics-Report.pdf?rev=72260e0300ec423491b3b2ec0dfafbeb&hash=908CB3E85F6DDCFA7CAE34F422310775) moved to 0 to 5 in February 2025. Compute both.
- **Headway routes.** The standards use headway tests at 10-minute frequency or better, and count 20 or more minutes late as a missed trip. Schedule adherence misleads on those routes.
- **A conflict in the standards.** The appendix on p. 32 gives a streetcar minimum of 20/10, while Table 5 gives 50/35.
- **Standards are under review.** [Round Two](https://www.ttc.ca/transparency-and-accountability/transit-planning/service-standards-review) is due in early 2027, so version every rule. The current standards omit Lines 5 and 6.
- **Joining live data.** Live trip IDs match the BusTime or Merged GTFS feeds, not the main TTC Routes and Schedules feed.

## Numbers for `metrolinx-bca`

From the Business Case Manual, [Volume 2](https://assets.metrolinx.com/image/upload/v1663237565/Documents/Metrolinx/Metrolinx-Business-Case-Guidance-Volume-2.pdf), printed page numbers.

| Parameter | Value | Page |
|---|---|---|
| Discount rate, economic | 3.5% real | 98 |
| Appraisal period | 5 to 60 years, growth capped at 30 | 98 |
| Value of time | $18.79 in 2021 dollars, 0% growth | 170 |
| Walk and wait weights | 2.0 and 2.5, with a 5-minute interchange penalty | 171 |
| Discount rate, financial | 5.5%, with 2% inflation, nominal | 176 |
| Method | Increment over business as usual, excluding sunk costs, rule of a half | 85, 103, 110 |
| Capital optimism bias | 64% / 18% / 9% / 4% at 0–10 / 11–20 / 21–30 / 31–100% design | 94 |

**Watch out for:** rebase value of time before use. The City of Toronto [used $21.09](https://www.toronto.ca/legdocs/mmis/2023/ex/bgrd/backgroundfile-240130.pdf) in 2023 dollars. Table 5.6's adjusted uplift formula appears to be inverted, so confirm it before coding. TTC and Metrolinx weights differ, so never reuse one for the other.
