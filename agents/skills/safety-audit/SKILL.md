---
name: safety-audit
description: Audit road safety along a route, line or area the Vision Zero way, from police-reported collisions where someone was killed or seriously injured (KSI): by year, road user, severity and time of day, the places with the most, whether there are more or fewer a year than before, and countermeasures only as the City's Vision Zero plans and FHWA's Proven Safety Countermeasures give them, with pages. For a KSI count beside census or neighbourhood overlays use gis-analyst; for bike lanes, sidewalks and bike share use active-transportation.
---
The service counts every collision. Your tools call it for this study only. Each result is saved as a map layer, which planners see on the study's map, and its main counts are recorded as figures that cite the dataset. Report the numbers the tools return, as they return them, and work out no others: no sums, shares or rates of your own.

## The tools

- list_datasets: the datasets, with their licences and what to know before using them. The collisions are toronto-ksi-detail: the same collisions as toronto-ksi, with each one's hour, light, place, streets and the people hurt.
- route_stops, route_shape, study_line, named_area, buffer: make the area to audit, as gis-analyst does. A corridor is a route's shape or the study's line, buffered.
- ksi_profile: collisions inside an area by year, road user, severity, intersection or mid-block, dark, and time of day, and the people killed and seriously injured by road user.
- ksi_hotspots: the places inside an area with the most collisions, ranked, each named by the streets police recorded.
- ksi_trend: collisions a year before and from a split year, against the whole city's change, with an exact test of whether chance alone could give the change.
- list_layers, summarise_layer: the study's layers, and one layer's totals and warnings.

Chain them: route_shape, then buffer, then ksi_profile, ksi_hotspots and ksi_trend on the buffer. Use the distance the question gives. Otherwise buffer a street's shape by 50 m, which takes in the street and its corners, and say you chose it: no source here sets one.

## What the numbers are

1. Police-reported only. The data is the Toronto Police Service's: collisions police didn't attend are missing, "seriously injured" is a police injury code, and the latest year is partial. Say so, and give the years with every count.
2. Each collision is filed under its most vulnerable road user: pedestrian, then cyclist, then motorcyclist, then motorist. The people killed or seriously injured are counted by their own road user, so one collision can hurt people of two kinds. The City's own counts overlap the same way: "KSI collisions between various emphasis areas since collision events often involve" (toronto-vision-zero-2-2019 p. 17) several road users.
3. Give the sample size with every breakdown. Under 20 collisions the service warns that a pattern by year, hour or road user can't be read: pass that on, and don't describe a pattern.
4. A trend is the service's reading, in its words: the change a year, the chance alone would give it, and the city's change beside it. Never say what caused a change, and never credit or blame a project for it: traffic, how many people walk and cycle, and reporting change too.
5. A hot spot is where collisions were, not where they will be. A place with many collisions in past years may have fewer next even if nothing changes there. Vision Zero 2.0 sets "Reactive to historical crashes" against "Proactive and systemic prioritization" (toronto-vision-zero-2-2019 p. 13): say the list ranks the past, and that a planner decides where to look first.
6. No exposure. There are no traffic or pedestrian counts here, so give no rate per vehicle or per person, and don't compare places as if they carried the same traffic.

Never say a street or a design caused a collision. Counts say where and when, never why.

## Countermeasures, only from the sources

Name a countermeasure only as one of these sources gives it, with its page, and read the page with read_page before you cite it. Give it as what the source lists for that kind of collision, never as what will happen here.

- Toronto's own estimate: "Table 3. Most Effective Vision Zero Countermeasures in Toronto" (toronto-vision-zero-2-2019 p. 14) lists effective speed reductions, road design modifications, signalized mid-block crossings, cycling corridor enhancements and pedestrian head start signals, with the share of KSI collisions each could have prevented across the city.
- Speed: "Vulnerable road users have a 95% likelihood of death" "in a collision at 60 km/hr, while at 40 km/hr the likelihood of death is reduced to" 30% (toronto-vision-zero-2-2019 p. 14). FHWA lists "Appropriate Speed" limits for all road users (fhwa-psc-2021 p. 7).
- Pedestrians crossing mid-block: "40% of pedestrian KSI collisions happen as pedestrians are crossing mid-block" (toronto-vision-zero-2-2019 p. 14). The City reviews TTC stops too: "Given that the presence of TTC stops at mid-block locations may encourage" crossing there (toronto-vision-zero-2-2019 p. 34), but "Stakeholders representing pedestrians with disabilities have raised concerns with" consolidating stops (p. 34). Hand that trade-off to a planner. FHWA lists medians and pedestrian refuge islands: "A pedestrian refuge island (or crossing area) is a median with a refuge area" (fhwa-psc-2021 p. 25), and crosswalk visibility enhancements (p. 21).
- Turning vehicles at signals: left turns are the "most prevalent type of KSI collisions involving pedestrians (18%) and cyclists (8%)." after mid-block crossings (toronto-vision-zero-2-2019 p. 35), and "Pedestrian head start signals, also known as Leading Pedestrian Intervals (LPI), are" among the most effective low-cost features (p. 35). FHWA: an LPI lets pedestrians "enter the crosswalk at an intersection 3-7 seconds before vehicles are given" a green (fhwa-psc-2021 p. 24). For right turns, the City's plan lists that "No right-turn-on-red prohibitions will be implemented at key" locations (toronto-vision-zero-2017 p. 32), and that smaller "corner radii result in shorter pedestrian crossing distances and times," (p. 32).
- Cyclists: "Most fatal and serious injury bicyclist crashes occur at non-intersection locations." (fhwa-psc-2021 p. 22), where FHWA lists bicycle lanes. Toronto's plan: "Cycle tracks are lanes for bicycles that are adjacent to the roadway," (toronto-vision-zero-2017 p. 47).
- In the dark: FHWA lists lighting, as "the nighttime fatality rate is three times the" daytime rate (fhwa-psc-2021 p. 30). Toronto's plan: "Working with Toronto Hydro, street lighting will be reviewed at" places prone to pedestrian collisions (toronto-vision-zero-2017 p. 31).
- A place with many collisions: "In areas with high KSI collisions, in-depth safety reviews will be" conducted (toronto-vision-zero-2017 p. 32). FHWA's road safety audit is "performed by a multidisciplinary team independent of the project" (fhwa-psc-2021 p. 32).

FHWA's percentages are from US studies, "up to" a reduction, and Toronto's Table 3 is citywide. Never apply either to this area's count to say how many collisions a measure would prevent here. Which countermeasure fits a place is for a planner or a road safety audit to decide, on site: say so, and recommend none yourself.

## Citing

Each count is a figure in the study, citing its dataset and the layer that made it. Cite a count as (toronto-ksi-detail, layer id), such as (toronto-ksi-detail, layer ttc-25-shape-50m-ksi-profile-2016-2025), with no page: a dataset has none. Cite a source's page only for words from a source.

In your summary, give the area and its distance, the years, the counts with their sample sizes, the top places, the trend's reading and the city's change, then the countermeasures the sources list for the patterns found, each with its page, and what the data can't say. Say that the layers are on the study's map, and that the collisions are police-reported.
