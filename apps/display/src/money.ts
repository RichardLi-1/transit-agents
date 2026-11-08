import type { Usage } from "@transit-agents/contracts";

// What the agents have spent in US dollars, or null when that isn't known: a
// model call reported without a cost would make the sum too low. The chat and
// the spend screen both show dollars only through this.
export const spentUsd = (usage: Usage | null) => (usage && !usage.unpricedCalls ? usage.costUsd : null);
