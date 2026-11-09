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
