---
name: metrolinx-bca
description: Run a benefit-cost analysis by Metrolinx's Business Case Manual on a project's own yearly benefits and costs: present values at the manual's discount rate over 60 years of operation, optimism bias on capital cost by level of design, the NPV and the benefit-cost ratio. It refuses to fill in a missing input.
---
The method is Metrolinx's Business Case Manual, metrolinx-bcm-vol2. Page numbers are read_page's, nine above the printed ones. metrolinx_bca does the arithmetic and cites every constant it uses. Don't discount, add up or divide yourself, and never give a ratio it didn't compute.

## Inputs

1. Call list_rules and get_study first. The tool computes nothing while a planner's rule differs from the manual's value it uses: then say which rule, and that a planner must confirm which applies.
2. Find this project's own figures in the sources, and read each page before you rely on it. Give each stream as runs of years with a yearly amount, in millions of real dollars of the base year, the year the appraisal begins:
   - capital costs before optimism bias, leaving out sunk costs, those already paid (metrolinx-bcm-vol2 p. 112);
   - operating and maintenance costs;
   - benefits, the user and external impacts, or the hours of weighted travel time saved, which the tool values at the manual's value of time;
   - wider economic impacts, if the sources give them, for the expanded NPV and BCR (metrolinx-bcm-vol2 p. 173).
   Each is the change from business as usual, "the baseline against which options are compared where the investment has not occurred" (metrolinx-bcm-vol2 p. 21).
3. Give the base year, the opening year and the percent of design complete. At 0-10% design, say too whether the capital cost's contingency came from a quantitative cost risk analysis (QCRA) or is a percent uplift, and if a percent, how much.
4. Say whether the sources' capital and operating costs already include escalation, the real growth in costs beyond inflation: costs_escalated is true if they say so, and false if they say the costs leave it out. With false, the tool grows both at the manual's rate. If the sources don't say, leave it out: it is missing.
5. Use only this project's figures. One from another line, such as its cost per km or its riders, is a precedent, not an estimate: leave it out.
6. Leave out whatever the sources don't give. The tool then computes nothing and names each missing input: report them as gaps, with the data needed, such as a regional demand model run for benefits or an engineering estimate for cost. Never estimate one, and never call it again with a guess.

## The rules it applies

- Discount rate: "Discount Rate 3.5%" (metrolinx-bcm-vol2 p. 179), on real values (metrolinx-bcm-vol2 p. 93).
- Evaluation period: "Evaluation Period 5 to 60 years (depending on project lifecycle/impacts)" (metrolinx-bcm-vol2 p. 179). The planners' rule is 60, and the tool counts 60 years of operation from the opening year, after the years before it, as the Ontario Line's business cases did: "70 years (Includes construction period and 60 years of operation)" (ontario-line-pdbc-2020 p. 107).
- Dollars: "Dollar Value Real, year of evaluation" (metrolinx-bcm-vol2 p. 179).
- Cost escalation: escalation belongs in the Economic Case, and estimates for capital and operating costs should consider it (metrolinx-bcm-vol2 p. 93). Without the data to estimate it, the manual allows "an assumed rate of 1%" (metrolinx-bcm-vol2 p. 93) a year to 30 years from the base year: "Capital Cost Growth Rate 1% (real)" and "Operating and Maintenance Cost Growth 1% Rate (real)" (metrolinx-bcm-vol2 p. 179). The tool applies it only when costs_escalated is false, and says whether it did.
- Value of time: "Value of Time $18.79 (2021 $)" and "Value of Time Growth Rate 0% (real)" (metrolinx-bcm-vol2 p. 179). It is in 2021 dollars, so the tool values hours saved only with a base year of 2021. Rebasing it needs a price index the sources don't give: never rebase it yourself.
- Optimism bias by level of design: "Level of Design Completion 0-10% 11-20% 21-30% 31-100%" and "OB 64% OB 18% OB 9% OB 4%" (metrolinx-bcm-vol2 p. 103). "Metrolinx only adjusts capital costs for optimism bias." (metrolinx-bcm-vol2 p. 101), and "it is only intended for economic project appraisal in the Economic Case." (metrolinx-bcm-vol2 p. 99). The tool also gives the result without it, as a sensitivity test.
- At 0-10% design, with a percent contingency and no QCRA, Table 5.6 adjusts the uplift so that contingency and uplift together come to the published 64%. Its printed formula, "Adjusted OB Uplift % = (1+Contingency Uplift %)/(1+Project Stage OB Uplift)-1" (metrolinx-bcm-vol2 p. 103), reads inverted. The tool uses the reading that keeps the total at 64% and marks the result toConfirm: say a planner must confirm it.
- NPV and ratio: "Conventional NPV = PV User Impacts + PV External Impacts - PV Costs" and "Conventional BCR = (PV User Impacts + PV External Impacts) / (PV Costs)" (metrolinx-bcm-vol2 p. 173). Where benefits are negative, "All Loss" should be reported (metrolinx-bcm-vol2 p. 95), and where costs are negative, "All Gain" should be reported instead of a negative BCR. (metrolinx-bcm-vol2 p. 95)
- Discounting: year 0, the base year, isn't discounted, and each later year t is divided by 1.035 to the power t (metrolinx-bcm-vol2 p. 93). As printed, Equation 5.1 runs its product from the base year, which would discount year 0 as well. That would lower the NPV by one year's discount and leave the BCR as it is: mention it where the NPV matters.

## Reporting

- Give the NPV and the BCR, or All Loss or All Gain, as asReported rounds them, and the NPV per dollar of capital: "Ratios including BCR and ROI should be reported to two decimal places" (metrolinx-bcm-vol2 p. 172), and present values and the NPV to two significant digits. Name the base year's dollars, the years, the optimism bias with its level of design, whether the tool escalated the costs, and each constant with its page.
- "If the BCR of an investment is greater than or equal to 1, it is considered economically viable." (metrolinx-bcm-vol2 p. 94). That is the manual's test. Whether to go ahead is a planner's decision.
- Pass on the tool's notes: a large project needs a range from a Monte Carlo simulation, a small one may leave out optimism bias, and a stream may stop early or grow after 30 years.
- Another project's ratio isn't this project's: never give it as this one's.
- It records nothing. Give the results in your summary, and never type them into record_figure.
- When a result needs a planner's confirmation, such as Table 5.6's reading or a rule that differs, end with "For a planner to decide:" and what they must confirm.
