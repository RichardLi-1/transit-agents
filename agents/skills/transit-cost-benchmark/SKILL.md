---
name: transit-cost-benchmark
description: Compare a rail line's capital cost per km with the comparables the sources hold, the Ontario Line and Relief Line South in the Ontario Line Initial Business Case, on the same basis, and say what the comparison can't tell.
---
The sources hold two comparable costs per km, both in Table 31 of the Ontario Line Initial Business Case (ontario-line-ibc-2019 p. 77). Its rows read "Length (km) 7.5 15.5" and "Cost per km $832 M to $999 M $613 M to $735 M", with Relief Line South first. Each range runs from the median estimate to the high estimate:

- Ontario Line, 15.5 km: $613 M to $735 M per km.
- Relief Line South, 7.5 km: $832 M to $999 M per km.

They share a basis: capital costs "estimated in 2019$" (p. 76), and "Capital cost estimates were all developed by Turner & Townsend" (p. 77). Use no other line's cost per km unless a source gives it on the same basis.

## Before comparing

1. Their designs were at different stages: "Relief Line South costs were based on 15% designs provided by the TTC while Ontario Line costs were developed based on conceptual alignments" (ontario-line-ibc-2019 p. 77). Say so with every comparison.
2. Alignment drives cost per km. Relief Line South was "7.5 km of underground rapid transit", while the Ontario Line used "underground segments, shared rail corridors, and elevated structures", which "allows for a larger build out of rapid transit for lower cost per km with quicker construction timelines compared to a fully underground alignment" (ontario-line-pdbc-2020 p. 16). So a new line's precedent depends on its alignment: the Ontario Line's for a mixed one, Relief Line South's for one fully underground. If the alignment isn't designed yet, give both as precedents and leave the choice to a planner.
3. One gap, said two ways: "Relief Line South costs are approximately 35% higher than Ontario Line costs on a per-kilometre basis" (ontario-line-ibc-2019 p. 77), and the Ontario Line's were "25 to 30% lower than a fully tunnelled Relief Line South" (ontario-line-pdbc-2020 p. 62). Don't report them as two findings.
4. What the estimates hold: they "should be considered Class 5 estimates", "All cost estimates reflect 30% contingency to cover unknown risk events", and "The high end of the cost estimates also include an average of 20% uplift to individual cost items in order to balance optimism bias" (ontario-line-ibc-2019 p. 76). Benchmark on the median.
5. Optimism bias belongs to the business case: Metrolinx applies it to "costs only, and the economic case only" (metrolinx-bcm-vol2 p. 102), adjusted when the estimate already holds contingency, "given a contingency uplift is applied on capital costs" (metrolinx-bcm-vol2 p. 103). Never add it to the high end, which already holds an uplift.
6. Both are 2019 dollars, and a business case uses "Dollar Value Real, year of evaluation" (metrolinx-bcm-vol2 p. 179). Set them against a cost in another year's dollars only after rebasing with an index the sources give. They give none, so say a planner must supply one.

## Not comparables

- The Business Case Manual's Yonge North Subway Extension example is "used for illustrative purposes only" (metrolinx-bcm-vol2 p. 105). Never use its costs as a benchmark.
- Other cities' costs per km aren't in the sources. Don't quote them from memory: say they're missing, and name the data a planner could add.
- A precedent's cost per km times a new line's length is a precedent, not an estimate: label it so. An estimate needs an engineering design.

## Recording, when your instructions ask

Call get_study first, and reuse the figure ids already there. Record a comparable as a cited figure. Table 31 is a table, so quote its row from the label up to the value you want, which makes that value the last number in the quote: "Cost per km $832 M" backs 832, "Cost per km $832 M to $999 M $613 M" backs 613, and "Length (km) 7.5 15.5" backs 15.5. Skipping cells breaks the quote: "Cost per km $613 M" isn't on the page. A new line's cost from a precedent is a derived figure, cost_per_km * length, with its length a rule from list_rules, never a number you type.
