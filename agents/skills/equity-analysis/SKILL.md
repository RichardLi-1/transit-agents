---
name: equity-analysis
description: Say who a route, its stops or a line serves, from open data: the people within reach in low income (LIM-AT), commuting by transit, 65 and over or 0 to 14, each beside the City of Toronto as a whole from the same 2021 census, the Neighbourhood Improvement Areas it reaches and the people in them, and the stops near an NIA that the TTC's 125% equity weighting covers. For one census total, collisions or a plain buffer or overlay use gis-analyst; for whether a change passes the TTC's tests, ttc-standards; for who must hear about a change, engagement-needs.
---
The service does all the geometry, with Turf.js, and every count and difference. Your tools call it for this study only. Each result is saved as a map layer, and its totals are recorded as figures that cite the dataset. Report the numbers the tools return, as they return them, and work out no others.

## The tools

- list_datasets: the datasets, with publisher, licence and what to know before using each. Call it first.
- route_stops, route_shape, study_line, named_area, buffer: make the layer to profile, as gis-analyst does.
- equity_profile: an area layer, such as a buffer, and, if you give it, the stops layer it came from. It returns, for the people living in the layer: population, people in low income, and the shares in low income, commuting by transit, 65 and over and 0 to 14, each beside the City's share from the same census and the gap in percentage points; the Neighbourhood Improvement Areas it reaches (nias), the share of the layer in them and the people living there; and, with stops, how many stops are within 400 m of an NIA.
- list_layers, summarise_layer: the study's layers, and one layer's totals and warnings.

Chain them: route_stops, then buffer, then equity_profile with the buffer as layer and the stops as stops. Use each result's layer id in the next call.

## Distances

- A walk to a stop: 400 m. The TTC's base network is designed so that "90% of the population and employment is within a 400 metre (5 minute) walk of transit service" (ttc-standards-2024 p. 10).
- A rapid transit station: 800 m, "an 800m radius buffer (as the crow flies distance) around stations" (ontario-line-ibc-2019 p. 38).
- Use the distance the question gives. Otherwise say which you used, and why. A buffer is a straight line, not a walk along streets, so it takes in more than a walk would.

## The TTC's equity rules

- The 2026 plan says "boardings at all stops within 400m of a Neighbourhood Improvement Area (NIA), as designated by the City of Toronto, will be weighted at 125% of a standard boarding" (ttc-anp-2026 p. 114). The Service Standards apply it to stops "in or within 400-metres of residential parts of Neighbourhood Improvement Areas (NIAs)", where "the NIAs were narrowed to exclude non-residential areas such as ravines and industrial lands" (ttc-standards-2024 p. 33).
- The tool uses the NIAs' whole areas, as the City publishes them, not the TTC's narrowed ones. So its count of stops near an NIA can be more than the TTC's, never fewer: say so with it.
- The weighting applies to boardings, and boardings by stop aren't in any dataset here. The tool counts stops, never boardings. Asked for weighted boardings, give the stops near an NIA, say the stop-level boardings needed come from the TTC, and hand the rest to a planner.
- The TTC's engagement must reach "people with low income, women and shift workers" (ttc-standards-2024 p. 24). The census data here has people in low income by area, but nothing on women or shift workers near a route: say so, and leave who to engage to engagement-needs and a planner.

## What the numbers are

1. Every total is area-weighted: each census area counts in proportion to its land inside the layer, as if its people were spread evenly. Say "area-weighted" and "an estimate" with each one.
2. The census is from 2021, its incomes from 2020. The City's shares come from the same census, so the two can be set side by side. Say so.
3. Give each gap as the tool gives it, in percentage points. Don't call it large, small, significant or fair: the counts are rounded and sampled, and how much a gap matters is a planner's judgement.
4. The census counts people in low income (LIM-AT), not households. Never call people households.
5. Commuting shares are a 25% sample of commuters with a usual or no fixed workplace. Pass on each warning a tool gives, such as areas whose counts Statistics Canada suppressed.
6. The census covers the City of Toronto only. When a tool says part of the layer is outside it, say how much, that nobody living there is counted, and that the totals are for the part inside Toronto only. Name no one to ask about the rest: no source here names anyone.
7. The NIAs are the City's 33 under its 2030 strategy. If a source names older ones, say so.

## What it must never do

- Infer anything about a person. These are counts of people in areas: never say that a rider, a household or anyone near a stop is in low income, old or young, or that the people near a route ride it. A catchment's population isn't ridership.
- Rank groups or neighbourhoods as more deserving, or say a change is equitable or not. Set out the numbers and the rules with their pages, and hand the judgement to a planner, as the handover skill says.
- Compare with a figure from another year's census or another dataset: the tool's own City share is the comparison.

## Citing

Each total is a figure that cites its dataset and the layer that made it. Cite a total as (census-da-2021, layer ttc-52-stops-400m-equity), and give its figure's id if asked. A dataset has no pages. Cite a source's page only for words from a source, such as the rules above.

In your summary, give each share beside the City's with the gap, the distance, the census year and "area-weighted", then the NIAs by name, then the warnings that matter. Say the layers are on the study's map.
