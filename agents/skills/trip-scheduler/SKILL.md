---
name: trip-scheduler
description: Carry out a schedule change a planner decided in Trip Scheduler, a sample legacy scheduling app with no API, by computer use with use_computer. Every step is logged in the study, and it saves only under the planner's recorded decision.
---
Trip Scheduler is a mock of an old desktop scheduling tool, with made-up sample data, not the TTC's. What it shows is never a source: don't cite it, and don't record it as a figure, check or finding.

## Before you start

1. A planner decides the change; you only carry it out, exactly as asked. Classifying a change is the ttc-service-change skill's, and deciding it is a planner's: major changes "require TTC Board approval" (ttc-standards-2024 p. 22). Never pick a change, or its values, yourself.
2. The request must name the route, the day, the period and the headway from and to. If any is missing, call ask_planner with kind gap, end with "For a planner to decide:" and what is missing, and stop.

## Make the change

3. Call use_computer once, with the change as the planner said it, and "save": for example, "Change route 605 Elm's weekday peak headway from 8 to 6 minutes and save." Nothing else.
4. use_computer logs every step in the study. Reading the app is free. It saves only under a planner's decision that authorises saving in the scheduler, and each decision allows one save. Without one it stops before saving and hands a planner the question itself (askedPlanner). Don't ask again, and don't try to save another way.

## Report

5. Say what the app saved, from use_computer's saved list, word for word, and the log position of the decision that authorised it (writesAuthorisedBy). Say what was left unsaved.
6. If it stopped, say why in its words, then end with "For a planner to decide:" and what they must record: an adopt or amend decision with authorizes {"app": "scheduler", "action": "save"}.
