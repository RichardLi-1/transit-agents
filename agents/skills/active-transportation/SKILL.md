---
name: active-transportation
description: Measure walking, cycling and bike share near transit, as multimodal and first and last mile access, from the City's open data: km of cycle tracks, bike lanes, trails and shared roads near a route or stops, streets with no sidewalk, Bike Share Toronto stations and docks, and which stops have no bike share station or bikeway within reach. For who lives near a stop use gis-analyst; for collisions and road safety use safety-audit.
---
The service measures every km and counts every station. Your tools call it for this study only. Each result is saved as a map layer, which planners see on the study's map, and its totals are recorded as figures that cite the dataset. Report the numbers the tools return, as they return them, and work out no others.

## The tools

- list_datasets: the datasets, with their licences and what to know before using them: toronto-cycling-network, toronto-sidewalks, bike-share-toronto.
- route_stops, route_shape, study_line, named_area, buffer: make the area to measure, as gis-analyst does.
- cycling_within: the cycling network inside an area, in km: separated cycle tracks, painted bike lanes, multi-use trails, shared roads (sharrows, signed routes, park roads), bikeways (the first three), and km by the City's own type.
- sidewalks_within: streets inside an area by their sidewalks, in km: both sides, one side, partial, none, and the share with none.
- bike_share_within: bike share stations inside an area, and their docks.
- first_last_mile: for each stop of a layer of stops, the nearest bike share station and the bikeways within a distance. It saves two layers, bike share and bikeways, and lists the stops with neither within reach.
- list_layers, summarise_layer: the study's layers, and one layer's totals and warnings.

Chain them: route_stops, then buffer, then cycling_within, sidewalks_within or bike_share_within on the buffer; or route_stops, then first_last_mile on the stops.

## Distances

- A walk to a stop: 400 m. The TTC's base network is designed so that "90% of the population and employment is within a 400 metre (5 minute) walk of transit service" (ttc-standards-2024 p. 10). Use it for sidewalks and bike share near stops.
- A rapid transit station: 800 m, which the Ontario Line's business case took as "an 800m radius buffer (as the crow flies distance) around stations" (ontario-line-ibc-2019 p. 38).
- No source here sets how far people cycle to a stop. Use the distance the question gives; otherwise use 400 m and say you chose it.

Every distance is a straight line, not a route along streets: say so.

## What the numbers are

1. The cycling network is measured along the street: a street with a lane on each side counts once. The type is the City's. A cycle track is separated from traffic: "Cycle tracks are lanes for bicycles that are adjacent to the roadway," "but separated from vehicular traffic" (toronto-vision-zero-2017 p. 47). Sharrows and signed routes share the road, so they aren't bikeways. Give km by group, and name the City's types when asked.
2. Whether a bikeway is comfortable, or connects to where people go, isn't in the data. A stop without a bikeway within reach is a gap near the stop, not proof that the network is broken there.
3. The sidewalk inventory dates from 2017. Sidewalks built since are missing, so a street listed with none may have one now: say so with every sidewalk total, and that the gap needs checking on site.
4. The City's policy is that "sidewalks should be provided on arterial and collector" roads (toronto-vision-zero-2-2019 p. 29), and "Local roads remain the largest gap in the walking network" (p. 29). Among its priorities for new sidewalks: "Areas where users are more dependent on walking as a main mode of" transportation or to reach transit (toronto-vision-zero-2-2019 p. 31). FHWA lists walkways along "both sides of the road in urban areas" (fhwa-psc-2021 p. 28). Name these when a stop's streets lack sidewalks, as what the sources say, and leave which to build to a planner.
5. Bike share stations are one day's list from the feed: stations open, close and move, and docks are a station's size, not bikes available.
6. None of this is ridership. If asked how many people will walk, cycle or ride to a stop, say the data can't tell: it needs counts or a travel survey, which a planner asks for.

## What it can't answer

How safe a street is to walk or cycle: use safety-audit for collisions. Who lives near a stop: use gis-analyst. Whether a gap should be filled, or in what order: a planner decides, and Vision Zero 2.0 sets the City's criteria (toronto-vision-zero-2-2019 p. 31).

## Citing

Each total is a figure in the study, citing its dataset and the layer that made it. Cite a total as (dataset id, layer id), such as (toronto-cycling-network, layer ttc-25-stops-400m-cycling), with no page: a dataset has none. Cite a source's page only for words from a source.

In your summary, give the area and its distance, each total with its unit and dataset, the stops with neither bike share nor a bikeway within reach, and what the data can't say, such as the 2017 sidewalks. Say that the layers are on the study's map.
