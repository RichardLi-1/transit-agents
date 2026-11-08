---
name: ttc-service-change
description: Classify a proposed TTC service change as minor or major by the Service Standards' Table 7, list the steps that class requires (Board Period or Annual Service Plan, consultation, Board approval, trial), and say when only a planner can classify it.
---
Sources: the standards are ttc-standards-2024, the 2026 plan ttc-anp-2026. Page numbers are read_page's; the standards' printed numbers are one lower. "Table 7: Summary of Minor and Major Service Changes" (ttc-standards-2024 p. 22) sets the classes, with the text above it.

## Classify

1. Find what the change does in the sources, and read each page before you rely on it: which routes, roads and periods of service it touches, by how many minutes it moves the span of service, whether the sources say it can be done with existing equipment and within the adopted budget, and whether they say it will have a significant effect on resources.
2. Call classify_service_change with each kind of change it makes. Leave out what the sources don't say: the tool never guesses, and names what's missing. Don't classify by hand, and never pass a guess to get an answer.
3. Report the class with the tool's reasons, each with its page:
   - Major: any major kind, such as a new route, a route extension, an added period of service, or service on a road that had none (ttc-standards-2024 p. 22). So is a change the sources say will have a significant effect on resources, Table 7's resource implication for major changes (ttc-standards-2024 p. 22).
   - Minor: every kind is one of Table 7's minor ones, and existing equipment and the adopted budget cover it (ttc-standards-2024 p. 22).
   - Not classified: when something is missing, find it in the sources, or say it's a gap and who holds it. When Table 7 doesn't list the change, or the tool says the standards don't settle it, end with "For a planner to decide:" and the question, with the pages the tool gives. Never pick a class yourself.
4. List the steps the tool gives for the class, each with its page, and the conditions it gives for that kind of change.

## What each class needs

- Minor: introduced "every Board Period" (ttc-standards-2024 p. 22), "approximately every six weeks" (ttc-anp-2026 p. 113), without "waiting for the Annual Service Plan" (ttc-standards-2024 p. 28), "subject to the availability of operating resources in the budget" (ttc-standards-2024 p. 29).
- Major: an overall benefit for customers, measured by "the net change in weighted travel time for customers" (ttc-standards-2024 p. 23), which the ttc-standards skill tests with the 2026 plan's other metrics (ttc-anp-2026 p. 114); public consultation, as "All major service changes and plans require public consultation." (ttc-standards-2024 p. 31); evaluation in the Annual Service Plan, with a comparative evaluation (ttc-standards-2024 pp. 28–29); Board approval, as "These major changes require TTC Board approval." (ttc-standards-2024 p. 22); and for a new service, a trial of at least twelve months, then a formal evaluation (ttc-standards-2024 pp. 29–30).
- Either: "All service changes (outside changes required for passenger comfort and schedule adherence) must do better than the threshold set by fare changes." (ttc-standards-2024 p. 21). Take the threshold from list_rules.

## Watch for

- Periods of service: the text above Table 7 puts "additional periods of service on the present routes (e.g. new weekend service)" (ttc-standards-2024 p. 22) among major changes, while Table 7's own row is "Addition/removal of a period of service on a route where it is the only transit option available" (ttc-standards-2024 p. 22). So the tool makes any added period major, but removing one where other services run is unlisted: a planner classifies it.
- Span: Table 7 lists span changes within 90 minutes as minor (ttc-standards-2024 p. 22) and no longer one. If service moves at both ends, give both together.
- Resources: the standards don't settle a change of minor kinds that existing equipment or the adopted budget doesn't cover. "Changes which are more substantial, either affecting the travel options of current TTC customers or requiring additional resources for operation, undergo a more rigorous review." (ttc-standards-2024 p. 22) But Table 7's major changes are those with a significant effect on resources (ttc-standards-2024 p. 22), and service increases, start and finish time changes and minor routing changes go through the Board Period process, "subject to the availability of operating resources in the budget" (ttc-standards-2024 p. 29). So the tool leaves it to a planner, unless the sources say the effect on resources is significant: give significant_resource_effect only when they do.
- A service level change has conditions: increases when crowding is "consistently greater than 95% for a period of six months" (ttc-standards-2024 p. 23), and a reduction "should not result in a headway widening greater than 25%" (ttc-standards-2024 p. 24). Report the ones the tool lists; test them only against rules from list_rules.
- Board approval is the Board's, and every decision a planner's. Classifying a change decides nothing: never write as if it were approved.
