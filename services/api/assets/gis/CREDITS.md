# GIS datasets

The open data the service's GIS tools work on, made small by
`scripts/build-gis-data.ts`. Each dataset's id, publisher, licence, address and the
day it was fetched are in `datasets.json`, and every layer and figure made from one
carries them. Show the credit with anything made from a dataset.

- `ttc.json.gz`: TTC Routes and Schedules (GTFS), Toronto Transit Commission, via
  [City of Toronto Open Data](https://open.toronto.ca/dataset/ttc-routes-and-schedules/).
  Contains information licensed under the
  [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).
- `census-da-2021.json.gz`: Statistics Canada, 2021 Census of Population:
  [Census Profile](https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/index.cfm?Lang=E)
  and the 2021 cartographic boundary file, dissemination areas. Reproduced and
  distributed on an "as is" basis with the permission of Statistics Canada, under the
  [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence).
  Adapted: simplified to about 3 m, Toronto only.
- `neighbourhoods.json.gz`: [Neighbourhoods](https://open.toronto.ca/dataset/neighbourhoods/),
  City of Toronto. Open Government Licence – Toronto.
- `nia.json.gz`: [Neighbourhood Improvement Areas](https://open.toronto.ca/dataset/neighbourhood-improvement-areas/),
  City of Toronto. Open Government Licence – Toronto.
- `ksi.json.gz`: [Motor Vehicle Collisions involving Killed or Seriously Injured Persons](https://open.toronto.ca/dataset/motor-vehicle-collisions-involving-killed-or-seriously-injured-persons/),
  Toronto Police Service, via City of Toronto Open Data. Open Government Licence – Toronto.
  One point per collision.
- `heritage.json.gz`: [Heritage Register](https://open.toronto.ca/dataset/heritage-register/),
  City of Toronto, Don Mills corridor only. Open Government Licence – Toronto. Not
  for legal purposes. This copy came from the City's public map layer, which states
  no licence of its own; its records match the Open Data register's.
- `parks.json.gz`: [Green Spaces](https://open.toronto.ca/dataset/green-spaces/),
  City of Toronto, Don Mills corridor only. Open Government Licence – Toronto.

The two corridor files come from the reference set (`references/files/site/toronto`
in the main checkout, fetched 2026-11-08). Run the script with `--site` to rebuild them.

## Road safety and active transportation

Made by `scripts/build-safety-data.ts`, listed in `datasets-safety.json`.

- `ksi-detail.json.gz`: [Motor Vehicle Collisions involving Killed or Seriously Injured Persons](https://open.toronto.ca/dataset/motor-vehicle-collisions-involving-killed-or-seriously-injured-persons/),
  Toronto Police Service, via City of Toronto Open Data. Open Government Licence – Toronto.
  One record per collision, with its hour, light, place, streets and the people
  killed or seriously injured by road user.
- `cycling.json.gz`: [Cycling Network](https://open.toronto.ca/dataset/cycling-network/),
  City of Toronto. Open Government Licence – Toronto. Simplified to about 2 m.
- `sidewalks.json.gz`: [Sidewalk Inventory](https://open.toronto.ca/dataset/sidewalk-inventory/),
  City of Toronto. Open Government Licence – Toronto. Streets only, simplified to
  about 2 m. The inventory dates from 2017.
- `bikeshare.json.gz`: Bike Share Toronto's station list (GBFS `station_information`),
  from the [Bike Share Toronto](https://open.toronto.ca/dataset/bike-share-toronto/)
  dataset on City of Toronto Open Data. Open Government Licence – Toronto.
## For the equity, economic development and stop accessibility skills

Made by `scripts/build-gis-skills-data.ts`, and listed in `datasets-skills.json`.

- `census-da-2021-extra.json.gz`: children (0 to 14) for each dissemination area, from
  the same Statistics Canada 2021 Census Profile as `census-da-2021`, under the same
  licence. Figures from it cite `census-da-2021`.
- `pow-ct-2021.json.gz`: Statistics Canada, 2021 Census of Population,
  [Table 98-10-0500-01](https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810050001),
  place of work status by census tract of work, with the 2021 cartographic boundary
  file's census tracts, Toronto CMA. Reproduced and distributed on an "as is" basis with
  the permission of Statistics Canada, under the
  [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence).
  Adapted: simplified to about 10 m.
- `zoning-corridor.json.gz`: [Zoning By-law](https://open.toronto.ca/dataset/zoning-by-law/)
  569-2013, zoning areas, City of Toronto, Don Mills corridor only. Open Government
  Licence – Toronto. Not for legal purposes. From the reference set, fetched 2026-11-08.
- `shelters.json.gz`: [Street Furniture – Transit Shelter](https://open.toronto.ca/dataset/street-furniture-transit-shelter/),
  City of Toronto. Open Government Licence – Toronto.
- `ttc-access.json.gz`: each stop's `wheelchair_boarding` from the same TTC GTFS as
  `ttc.json.gz`, under the same licence. Figures from it cite `ttc-gtfs`.
