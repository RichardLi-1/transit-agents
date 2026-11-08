---
name: tpap-brief
description: Build a brief for Ontario's Transit Project Assessment Process (TPAP) as a PDF, a report or slides, from what the study already holds: its findings, figures and needs, each point with its page. For the lead, with get_study and create_document.
---
The Transit Project Assessment Process (TPAP) is Ontario's environmental assessment process for transit projects. A brief gives planners a first pass at what a TPAP would draw on from this study. It is a draft for planners, never a finding of compliance, and a planner decides what goes forward.

Asked to generate, draft or make a TPAP, or a doc, brief, report or slides for one, make this brief. It is not the statutory filing (the proponent's Environmental Project Report), not a notice and not a decision, and the PDF says on its first page that it is a draft first pass for planners. So make it whenever asked, and never refuse; what only a proponent or a planner can do goes under "To confirm" and "Next steps".

Build it from get_study alone. Don't search or read pages again: every finding and every cited figure in get_study has a citation the service has already checked against its page. Then call create_document once.

## Every point

- Every fact comes from the study: a finding, a cited figure, an engagement need, or the brief. Give it as {text, citation}, with the citation exactly as get_study shows it on that finding (citation) or figure (basis.citation): the same contextId, page and quote. Write text in your own plain words, but keep every number as the source gives it.
- A derived figure has no quote of its own: give it as plain words, with its value and unit as get_study shows them, and say what it is derived from, as its label does, such as "a precedent, not a forecast".
- Never add a number, a date or a place that get_study doesn't show.
- TPAP's own steps and documents, such as the Notice of Commencement, the review and objection period and the Minister's notice, come from no study source, except those below. Put them only under "To confirm", as plain words, saying a planner confirms them against the regulation. Give no durations or dates for them, and never cite a study page for them.
- Short points: one idea each, under 200 characters, at most 6 points a section.

## What the study's sources say about TPAP

These are on their pages, so cite them as given here, as {contextId, page, quote}:

- TPAP is a 2008 Ontario regulation for transit projects: "a regulation called the Transit Project" and "projects (Ontario Regulation 231/08)" (metrolinx-bcm-vol2 p. 204).
- The Ontario Line itself went this way, "seeking environmental approvals through a TPAP" (ontario-line-pdbc-2020 p. 17).
- For the Relief Line South, "the project was screened through the TPAP at a very early level of preliminary design" (ontario-line-ibc-2019 p. 81), and after the Notice of Completion "Some design changes were identified as necessitating an Addendum to the existing approved Environmental Project Report (EPR)" (ontario-line-ibc-2019 p. 81).
- For the Ontario Line's northern section, to Science Centre, "Environmental approval and design work will be required" (ontario-line-ibc-2019 p. 82).

## Sections, in this order

1. Project description: what the study proposes, from its brief, and its length and stations from the figures and rules.
2. Need and justification: riders, travel time and the strategic case, from cited figures.
3. Alternatives considered: each alignment option the study holds (a finding with an option), with its terminus, length, stations and cost as the finding gives them. Without options, say the study has none yet.
4. Existing conditions: today's riders and service, from cited figures.
5. Potential impacts and mitigation: findings about construction, the natural environment and utilities, such as a river crossing or a road. Say what the source says would reduce the impact; where none does, say mitigation is not yet studied.
6. Consultation plan: the study's engagement needs, each with its place and why, citing its page, and who must hear about the change.
7. What's not known yet: each gap finding, written as "<what's missing>. Next: <step>. Contact: <organisation>", with its citation.
8. Next steps: the Next steps from the gaps, in order of what matters most, and that a planner decides.
9. To confirm: the TPAP steps, as above, and anything the study doesn't cover.

## Kind

A report for a document, doc, report, brief or PDF; slides for slides, a slideshow, a deck or a presentation. The title says what it is and for which study, such as "TPAP brief: Ontario Line Don Mills extension".

If create_document refuses a point, its message names the section and point: give that point the citation exactly as get_study shows it, or make it plain words, and call create_document again.
