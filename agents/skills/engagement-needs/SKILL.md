---
name: engagement-needs
description: Propose what to make so people near a change can see it before they are consulted, such as a poster or a short video at a proposed station with no illustration yet: when one is worth proposing, how to write it, and why only a planner asks for it to be made.
---
People hear about a change through engagement. "All major service changes and plans require public consultation" (ttc-standards-2024 p. 31), and the Ontario Line "will also require further public and stakeholder engagement" (ontario-line-ibc-2019 p. 82). An engagement need proposes one thing to make for one place: an image, such as a poster, a short video, or both. Agents propose it. Only a planner asks for it to be made.

## When to propose one

Propose a need where the people who will be consulted can't yet picture what would change:

- a proposed station or structure with no illustration, such as a station on an extension that so far is only a route;
- a stop or neighbourhood where service would be added, moved or removed, near the people the sources say were or will be consulted;
- people the standards say must be reached: "disproportionally impacted equity-seeking groups, including, but not limited to, people with low income, women and shift workers" (ttc-standards-2024 p. 24).

Don't propose one:

- without a page that backs the change at that place. No citation, no need: add_engagement_need refuses one without;
- where get_study already lists a need for that place and kind;
- for a change a planner has decided against, unless it tells the people who took part how it ended, citing the page of the decision;
- off the study's line: add_engagement_need refuses a place more than 500 m from it, and pin_to_line says so first.

## How to write it

Call get_study first, and read each page with read_page before citing it. Add a need with add_engagement_need only when your instructions ask for needs; otherwise describe it in your summary. Give:

- id: lowercase words joined by dashes, such as york-mills-poster.
- title: a short name for what to make, such as Engagement poster or Explainer video.
- place: the place as a map names it, in a few words, such as Don Mills Station. The media agent uses the name only when it reads like one.
- lon and lat: your best point for the place. add_engagement_need moves it to the nearest point on the study's line, and a place too far from the line isn't this study's. Check it first with pin_to_line, which says how far the place is from the line and whether that point is on a proposed part that isn't built. Say so when it is.
- kinds: image for a poster at a stop or station, video for screens, or both when people are reached both ways. Engagement should use "multiple channels to engage all customers" (ttc-standards-2024 p. 24), and the TTC promoted its 2026 plan's engagement on "subway platform video screens" among other channels (ttc-anp-2026 p. 96).
- reason: one plain sentence on why people there need to hear about it. Put no numbers in it: figures belong in citations, where the service checks them.
- citations: at least one page that backs the change at that place, each with a quote exactly on its page, as for a figure. The service checks every quote and refuses the need if one isn't there. Fix the quote or drop it, and never send it again unchanged.

## Only a planner asks

Adding a need makes nothing. It waits, marked needed, until a planner asks for its image or video to be made, with a tool agents don't have. Don't say it will be made, and don't describe what it will show as if that were decided. Anything made for it is labelled illustrative and is never evidence. In your summary, list each need you added, with its place and kinds, and say that a planner decides whether to make it.
