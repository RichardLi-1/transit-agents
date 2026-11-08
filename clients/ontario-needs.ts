// What the Ontario Line study asks to have rendered for public engagement: the
// line's viaduct over the Don Valley Parkway, and a station entrance where the
// extension would meet Lawrence Avenue East. Each card says plainly which rendering
// is missing, over its place, and that it's needed for public engagement. Each is
// pinned to a point on the line, or on its proposed part, as
// apps/display/public/data/studies.json draws them, and the Ontario Line seed lists
// them as its needs.
import type { NewNeed } from "@transit-agents/contracts";

const PDBC = "ontario-line-pdbc-2020";
const IBC = "ontario-line-ibc-2019";

const cite = (contextId: string, page: number, quote: string) => ({ contextId, page, quote });

export const ONTARIO_NEEDS: (NewNeed & { id: string })[] = [
  {
    id: "don-valley-viaduct",
    title: "Viaduct rendering missing",
    place: "Thorncliffe Park",
    // Where the line crosses the Don River and the Don Valley Parkway, west of the
    // Leaside Bridge, on its way into Thorncliffe Park.
    lon: -79.352553,
    lat: 43.698989,
    kinds: ["image", "video"],
    subject: "guideway",
    reason:
      "The line crosses the Don Valley and the parkway on a new bridge beside Thorncliffe Park. People here need to see how it would sit in the valley.",
    citations: [
      cite(PDBC, 60, "It crosses the Don River and the Don Valley Parkway on a new bridge about 200m west of the Leaside Bridge (Millwood Road)"),
      cite(PDBC, 64, "the Ontario Line will provide new connections for communities within Thorncliffe Park and Flemingdon Park"),
    ],
  },
  {
    id: "lawrence-entrance",
    title: "Station rendering missing",
    place: "Don Mills and Lawrence",
    // On the extension, where Don Mills Road meets Lawrence Avenue East: one of its
    // illustrative station sites.
    lon: -79.342894,
    lat: 43.735215,
    kinds: ["image", "video"],
    subject: "station-entrance",
    reason:
      "Going north, the line would need a station where Don Mills Road meets Lawrence Avenue East. People here need to see what its entrance could look like.",
    citations: [
      cite(PDBC, 60, "aligned to protect for a possible northward future extension"),
      cite(IBC, 14, "further assess the extension of the Relief Line north from Danforth Avenue to Sheppard Avenue East"),
    ],
  },
];
