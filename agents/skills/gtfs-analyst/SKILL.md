---
name: gtfs-analyst
description: Answer questions about a TTC route's scheduled service from the timetable in this repo: trips each hour, trips and gaps in each period of the Service Standards' Table 3, and the first and last trip of the day, each with the date of the timetable it comes from.
---
The repo holds the TTC's timetable as each trip's first scheduled departure. Three tools read it and do the counting, so report their numbers and work out no others:

- scheduled_trips: trips in each hour of a weekday, Saturday or Sunday.
- trips_by_period: trips in each period of the Service Standards' Table 3 (ttc-standards-2024 p. 14), with trips per hour, the average minutes between trips in both directions together and the longest stretch with no trip leaving. None of these is a headway, which is for one direction.
- service_span: the first and last trip of the day, and the longest break with no trip leaving.

Give a route, such as 52, for all its branches, or one branch, such as 52F. Subway and LRT lines have hourly counts only, from scheduled_trips, for the whole line.

## What the numbers count

Each trip is counted once, where it leaves its first stop, with both directions together: the data keeps neither a trip's direction nor its times at later stops. So:

1. Say "both directions together" with every count. Never halve a count into one direction's trips or headway. If one direction is asked about, say the data needed: the timetable's direction for each trip.
2. Don't give a stop's times, span or headway: the data has times only where each trip starts. Say so, and name the data needed: the timetable's stop times for that stop.
3. These are scheduled trips, not what ran. Say so if the question is about service people got.

## The date

Every result gives the last day its timetable covers, timetableUntil, and how its trips were matched to that timetable. Give the date with every answer: "<n> trips ..., both directions together (TTC timetable to <date>)". If a result warns that the timetable has ended, say that first. If its trips don't match the dated timetable, say by how much.

## Against a standard

- Table 3 prints the weekday late evening as "10:00 am - 1:00 am" (ttc-standards-2024 p. 14). The tools read it as 10:00 pm, as the weekend rows print it. Say so when a late-evening result matters, for a planner to confirm.
- Table 3 gives "Minimum Service Levels (minutes)" (ttc-standards-2024 p. 14), and the Ten Minute Network runs "every ten minutes or better from approximately 6:00 am to 1:30 am from Monday to Saturday and from approximately 8:00 am to 1:30 am on Sundays" (ttc-standards-2024 p. 13). Quote them only as context, with the page. Counts for both directions together can't show a minimum is met in one direction: say what the counts show, and that a planner needs each direction's timetable to test it.
- Call a result a pass or a fail only against a rule from list_rules.

## Recording

Don't record these numbers as figures: no page holds them, and this skill has no tool that records them. Give them in your summary, each with the timetable's date.
