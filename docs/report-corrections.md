# Corrections to the report

What the report should change before it becomes a paper, checked against primary
sources where they could be reached. Bold is what the report says.

## Wrong

- **Metrolinx sunk costs of $436M.** $436M is "sunk and additional" costs, for LRT
  projects only: $125M sunk, $286M over contract, $25M in contract management.
  [Auditor General 2018](https://www.auditor.on.ca/en/content/annualreports/arreports/en18/v1_307en18.pdf), pp. 322–323.
- **AAAM simulates 0.5 to 3 million daily riders in 10–30 minutes on a laptop.**
  Its README describes a 7-hour simulation with 500k–3M trips. The repo has no
  benchmark. [AAAM](https://github.com/Smart-Railway/AAAM).
- **AAAM and similar simulators give ground truth.** Rail-only, validated only on
  rail travel times, needs passenger-level demand, and its real data isn't in the
  repo. Drop "ground truth". [Paper abstract](https://doi.org/10.1016/j.jrtpm.2026.100586).
- **The metro flooding study's code is at `cb-cities/transit_sim`.** That repo is
  gone.
- **PNNL built narrow tools for 19 agencies.** 19 is the lead agencies whose
  reviews supplied benchmark cases. The tools are a federal beta.
  [PNNL](https://www.pnnl.gov/news-media/permitai-public-private-partnership-speeds-environmental-review-drafting-tasks), [apps](https://www.pnnl.gov/projects/permitai/ai-applications).
- **PNNL built foundations first, then tools.** SearchNEPA, in late 2024, predates
  DraftNEPABench, in February 2026.
- **120,000+ standardized environmental reviews.** 120,000+ documents, across about
  60,000 projects. [NEPATEC 2.0](https://huggingface.co/datasets/PNNL/NEPATEC2.0).

## Too strong

- **No published work uses AI agents for planning.** Write "we found none", and
  cite the closest work, such as Lee et al. [arXiv 2610.16140](https://arxiv.org/abs/2610.16140v1).
- **Any project over $50M goes through four business cases.** Metrolinx only:
  $50M for capital, $75M for rehabilitation and renewal, with other triggers.
  Business Case Manual Vol. 1 p. 2, Vol. 2 p. 87.
- **Design done: 0–10%, ~10%, 10–30%.** Volume 2 also gives 10–30% and 30%
  (p. 65), and 11–30% and 31–100% (p. 94). State which you use. Business Case
  Manual.
- **The 2026 plan dropped four route proposals.** Two proposals, affecting four
  routes. 2026 Annual Network Plan, pp. 22–23.
- **Eglinton opened Feb 8, 2026.** Correct date, but it was a phased "introductory
  service". [TTC](https://www.ttc.ca/news/2026/February/TTC-to-begin-phased-start-to-service-on-Line-5-Eglinton).

## Now settled

- **90% of trips departing on time.** Confirmed for surface routes. Actuals are far
  lower: bus 74%, streetcar 60%. Service Standards p. 15,
  [CEO report, July 2026](https://www.toronto.ca/legdocs/mmis/2026/ttc/bgrd/backgroundfile-289474.pdf).
- **Haven't confirmed which Bill 194 parts are in force.** AI sections 5–8 have
  been in force since January 29, 2025, but do nothing until a regulation is made.
  None exists on e-Laws. O. Reg. 51/26 and 52/26 don't cover the TTC or
  Metrolinx. The Regulatory Registry was not searched directly.
  [Proclamations](https://www.ontario.ca/laws/csv/1_proclamations_e.csv).
- **Rider feedback in 89+ categories, 20 hours to 2.** Confirmed in the abstract,
  but self-reported, with no accuracy figure. The data is GO customer surveys.
  [TransitData 2026](https://easychair.org/smart-program/TD-2026/2026-06-24.html#talk:316250).
- **Metrolinx reference to Bill 194.** The report misses that provincial agencies,
  likely including Metrolinx, also fall under Ontario's
  [AI directive](https://www.ontario.ca/page/responsible-use-artificial-intelligence-directive).
  The TTC does not. Inferred.

## Worth adding

- The Lawrence–Sunnybrook change began on
  [November 1, 2026](https://www.ttc.ca/service-advisories/Service-Changes/11B-11C-52F-124-Route-change-due-to-service-improvements),
  so its trial can be followed live.
- The published rules alone match 3 of the 8 real decisions in the 2026 plan
  ([benchmark.md](benchmark.md)).
- The TTC plan cites two different ridership standards across its reviews: 11 per
  $100, and 12 per service hour ([queries.md](queries.md)).

## Not yet checked

Scarborough's three plan changes, the Sheppard LRT delay, Kirby and Lawrence East,
the Canadian municipal survey figures, and whether Agent Skills are eligible for
zero data retention.
