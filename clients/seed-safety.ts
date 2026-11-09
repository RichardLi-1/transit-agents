// Road safety sources, for the safety-audit and active-transportation skills: the
// City of Toronto's Vision Zero Road Safety Plan and its 2.0 update, and the US
// Federal Highway Administration's Proven Safety Countermeasures. Countermeasures
// come only from these pages. Each page's text is in clients/fixtures, made with
// scripts/build-sources.ts.
//
// The City's documents are public, reproduced as text for checking citations, as
// the TTC's are. FHWA's booklet is a work of the US government: public domain, and
// its distribution statement reads "No restrictions."
import type { Source } from "./seed-data.ts";

export const VISION_ZERO = "toronto-vision-zero-2017";
export const VISION_ZERO_2 = "toronto-vision-zero-2-2019";
export const FHWA_PSC = "fhwa-psc-2021";

export const SAFETY_SOURCES: Source[] = [
  {
    id: VISION_ZERO,
    title: "Vision Zero: Toronto's Road Safety Plan 2017-2021",
    folder: "Road safety",
    source: "City of Toronto, Transportation Services",
    url: "https://www.toronto.ca/wp-content/uploads/2017/11/990f-2017-Vision-Zero-Road-Safety-Plan_June1.pdf",
    pagesFile: `${VISION_ZERO}.pages.json`,
  },
  {
    id: VISION_ZERO_2,
    title: "Vision Zero 2.0 - Road Safety Plan Update (IE6.8)",
    folder: "Road safety",
    source: "City of Toronto, Transportation Services",
    url: "https://www.toronto.ca/legdocs/mmis/2019/ie/bgrd/backgroundfile-134964.pdf",
    publishedOn: "2019-06-13",
    pagesFile: `${VISION_ZERO_2}.pages.json`,
  },
  {
    id: FHWA_PSC,
    title: "Making Our Roads Safer: One Countermeasure at a Time (28 Proven Safety Countermeasures, FHWA-SA-21-071)",
    folder: "Road safety",
    source: "US Federal Highway Administration, Office of Safety",
    url: "https://rosap.ntl.bts.gov/view/dot/88186",
    publishedOn: "2021-10-01",
    pagesFile: `${FHWA_PSC}.pages.json`,
  },
];
