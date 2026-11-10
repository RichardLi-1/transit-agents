---
name: economic-development
description: Count the work and activity near a route's stops, a line or its stations from open data, as they were, never as they will be: the people who work within reach from the 2021 census by census tract of work, beside the people who live there, and the land zoned for employment, homes and mixed use on the Don Mills corridor; and say what Metrolinx's Business Case Manual asks of wider economic impacts, with its pages. For residents and other census totals alone use gis-analyst; for who a change serves, equity-analysis; for benefits in dollars, metrolinx-bca. Forecasts no growth.
---
The service does all the geometry, with Turf.js, and every count. Your tools call it for this study only. Each result is saved as a map layer, and its totals are recorded as figures that cite the dataset. Report the numbers the tools return, as they return them, and work out no others.

## The tools

- list_datasets: the datasets, with publisher, licence and what to know before using each. Call it first.
- route_stops, route_shape, study_line, named_area, buffer: make the layer to measure, as gis-analyst does.
- jobs_within: an area layer. The people with a usual place of work in it (jobs) and who worked at home there, from census tracts of work across the Toronto CMA (statcan-pow-ct-2021); the people who live there, from the City's census areas; and people working there per resident, when both datasets cover the same land.
- zoning_within: an area layer. The land in it each kind of zone covers under Zoning By-law 569-2013 (toronto-zoning-corridor): residential, mixed use, commercial, employment industrial, institutional, open space and utility, in km² and as a share of the zoned land.
- list_layers, summarise_layer: the study's layers, and one layer's totals and warnings.

Chain them: route_stops, then buffer, then jobs_within or zoning_within. Use each result's layer id in the next call.

## Distances

- A station: 800 m, "an 800m radius buffer (as the crow flies distance) around stations" (ontario-line-ibc-2019 p. 38). A bus stop: 400 m, the TTC's walk to "90% of the population and employment" (ttc-standards-2024 p. 10).
- Use the distance the question gives. Otherwise say which you used, and why.

## What the numbers are

1. jobs counts people, not jobs: the 2021 census's people with a usual place of work in each tract, a 25% sample, randomly rounded, without people who have no fixed workplace. Call them "people who work there", and give "jobs" only as the tool's name for them.
2. The census ran in May 2021, during COVID-19, when many people worked at home. Give the people who worked at home beside those with a usual place of work, and say the year.
3. Census tracts are large beside a walk to a station, and work clusters in a few buildings, so an area-weighted count of workers is rougher than one of residents. Say "area-weighted" and "an estimate" with every count.
4. The tracts cover the Toronto CMA, beyond the City; the residents cover the City only. When the two cover different land the tool gives no people per resident: say why.
5. Zoning says what a lot may be used for, not what is built or who works there. Streets and rail aren't zoned, so the shares are of the zoned land. The zoning covers the Don Mills corridor only: the tool measures inside it and says how much of the layer is beyond it, and refuses a layer wholly beyond it. Then say the data covers only the Don Mills corridor, and name the data needed, the City's whole Zoning By-law layer.

## Wider economic impacts

- The Business Case Manual lists "Number of jobs within access distance of transit" as a performance measure for connecting commuters to jobs (metrolinx-bcm-vol2 p. 84). jobs_within gives that count as it was in 2021, not in a business case's forecast year.
- Its Economic Case covers "Wider Economic Impacts – analyzing how the investment in the transport network impacts economic activity" (metrolinx-bcm-vol2 p. 108), in three parts: productivity from agglomeration, imperfect competition and labour markets (p. 110, and Table 5.26 on p. 154).
- They are presented as analysis beside the conventional appraisal, with their assumptions and methods, and not every investment realises them (p. 152).
- Agglomeration works from effective density between zones, with generalized costs from model runs of the GGHM or another transport demand model: "Areas i and j should be at TAZ level" (p. 159). Land value uplift is a metric to consider, kept out of the benefit-cost ratio and NPV (p. 171).
- So the tools can say how many people work near stations today, and how land near them is zoned. They can't say what a line would add: wider economic impacts need a model run, which a planner asks for.

## What it must never do

- Forecast. Never say how many jobs, businesses, homes or dollars a line will bring, add, attract or unlock, nor how land values will change, even roughly or as a range. Say it needs a model run and hand it to a planner.
- Use another line's forecast as this one's. The Ontario Line's business case gives projected jobs within a 10-minute walk from model outputs (ontario-line-ibc-2019 p. 44): those are its own, a precedent at most, never this study's figure.
- Call a count a benefit, or rank stations or options by it. Set out the numbers, and leave the judgement to a planner.

## Citing

Each total is a figure that cites its dataset and the layer that made it. Cite a total as (statcan-pow-ct-2021, layer line-4-stops-800m-jobs) or (toronto-zoning-corridor, layer ...), with its figure's id if asked. A dataset has no pages. Cite a source's page only for words from a source, such as the Manual's above.

In your summary, give each count with what it counts, the distance, the year and "area-weighted", then the warnings that matter, then what the Manual says a wider economic impact needs. Say the layers are on the study's map.
