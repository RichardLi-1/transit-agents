---
name: stop-accessibility
description: Inventory the stops and stations along a TTC route or line for accessibility, as an asset inventory: which stops and platforms the TTC's GTFS marks wheelchair accessible or not, which stations have a platform marked not accessible, which stops have a City transit shelter, and what Ontario's AODA transportation standards (O. Reg. 191/11) ask of transit stops, with their pages. Lists what is there and what is missing; never says whether anything complies with the law. For who lives near a route use gis-analyst or equity-analysis.
---
The service does the matching and every count. Your tools call it for this study only. Each result is saved as a map layer, and its counts are recorded as figures that cite the dataset. Report the numbers the tools return, as they return them, and work out no others.

## The tools

- list_datasets: the datasets, with publisher, licence and what to know before using each. Call it first.
- route_stops: a TTC route's stops, all branches and both directions. For a subway or LRT line, give its number, such as 1, 2, 4 or 5: its stops are its platforms.
- named_area, buffer, points_within with ttc-gtfs: the stops inside an area, such as a neighbourhood.
- stop_accessibility: a stops layer. How many stops the GTFS marks wheelchair accessible (wheelchair_boarding 1), not accessible (2) or with no information, the stations with a platform marked not accessible, and the stops and stations marked not accessible by name (gaps).
- stop_shelters: a stops layer. The City's transit shelter nearest each stop within some metres, 25 unless asked: how many stops have one, how many have only one temporarily removed, and which have none (gaps).
- list_layers, summarise_layer: the study's layers, and one layer's counts and warnings.

Chain them: route_stops, then stop_accessibility and stop_shelters on its layer.

## What the data is

1. wheelchair_boarding is the TTC's own flag, one per stop or platform, in its schedule data (ttc-gtfs). Report it as "the GTFS marks", never as a survey's finding. If a station looks wrongly marked, say so and leave it for a planner to check with the TTC.
2. Nothing here says which stations have elevators, or about ramps, curbs, pads or the path to a stop. Say so, and name the data needed: the TTC's station accessibility records. The Ontario Line's business case says its "Stations will be fully accessible with elevators to all levels" (ontario-line-pdbc-2020 p. 42): that is a plan for that line, not an inventory.
3. A shelter is matched to a stop by distance: the City's shelters aren't linked to TTC stops. So a shelter across the street can be matched, and a stop without one in this data may have one another owner keeps. For a subway line, shelters mean nothing: use stop_shelters for surface routes.
4. The TTC says it is "making continuous progress towards making all of its vehicles, facilities and services accessible, consistent with Provincial AODA legislation" (ttc-standards-2024 p. 9). Shelters are among the amenities its plan names: "amenities such as benches, shelters, lighting" (ttc-anp-2026 p. 77).

## What the AODA standards ask (o-reg-191-11)

Quote the regulation's words with the page; never paraphrase a requirement into a stronger one.

- Transit providers "shall make available to the public current information on accessibility equipment and features of their vehicles, routes and services" (o-reg-191-11 p. 14).
- On buses, coaches and streetcars, a rider with a disability may board or leave at the closest safe place "if the official stop is not accessible and the safe location is along the same transit route", and operators must "promptly report to an appropriate authority where a transit stop is temporarily inaccessible or where a temporary barrier exists" (o-reg-191-11 p. 17).
- A municipality that runs transit consults "in the development of accessible design criteria to be considered in the construction, renovation or replacement of bus stops and shelters", and must "identify planning for accessible bus stops and shelters, including any steps that will be taken to meet the goal of accessible bus stops and shelters, in its accessibility plan" (o-reg-191-11 p. 33).
- The design of public spaces standards apply to "public spaces that are newly constructed or redeveloped on and after the dates set out in the schedule in section 80.5" (o-reg-191-11 p. 36).
- And "The requirements in the standards set out in this Regulation are not a replacement or a substitution for the requirements established under the Human Rights Code" (o-reg-191-11 p. 1).
- The sources here give no date by which every existing stop or station must be accessible. If asked for one, say the sources don't give it, and hand it to a planner.

## What it must never do

- Say that a stop, station, route or the TTC complies, or fails to comply, with the AODA or any law, even when every stop is marked accessible. Give the inventory, quote what the regulation asks with its page, and say a planner confirms whether it is met.
- Count a stop as accessible because it has a shelter, or as not accessible because it lacks one.
- Guess at a stop's or station's features the data doesn't hold.

## Citing

Each count is a figure that cites its dataset and the layer that made it. Cite a count as (ttc-gtfs, layer ttc-25-stops-access) or (toronto-transit-shelters, layer ttc-25-stops-shelters), with its figure's id if asked. A dataset has no pages. Cite a source's page only for words from a source, such as the regulation's.

In your summary, give the counts, then the stops and stations marked not accessible by name, then the shelters, then what the regulation asks, cited, and end with: an inventory, not a finding of compliance; a planner confirms. Say the layers are on the study's map.
