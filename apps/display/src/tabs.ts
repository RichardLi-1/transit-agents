// The workspace's tabs, and which one a notice's Review opens.
import type { Target } from "./notify.ts";

export type Tab = "study" | "map" | "files" | "sim" | "chat";

// The chat is a tab only on a phone: wider, it's always beside the workspace.
export const TABS: { id: Tab; label: string; icon: string; phoneOnly?: boolean }[] = [
  { id: "study", label: "Study", icon: "study" },
  { id: "map", label: "Map", icon: "map" },
  { id: "files", label: "Files", icon: "files" },
  { id: "sim", label: "Simulator", icon: "simulator" },
  { id: "chat", label: "Chat", icon: "chat", phoneOnly: true },
];

// The tab what a notice is about is on. Null leaves the tab as it is: a message is
// in the chat, beside every tab but on a phone, and a document opens on its own.
export function tabFor(kind: Target["kind"], phone: boolean): Tab | null {
  switch (kind) {
    case "need":
    case "media":
      return "map";
    case "message":
      return phone ? "chat" : null;
    case "document":
      return null;
    default:
      return "study";
  }
}

// The tab an arrow, Home or End moves to from `current`, round the ends, or null
// for any other key.
export function nextTab(ids: Tab[], current: Tab, key: string): Tab | null {
  const at = ids.indexOf(current);
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[key];
  if (step !== undefined) return ids[(at + step + ids.length) % ids.length] ?? null;
  if (key === "Home") return ids[0] ?? null;
  if (key === "End") return ids.at(-1) ?? null;
  return null;
}
