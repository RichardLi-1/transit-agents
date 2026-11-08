import type { Notice } from "./notify.ts";

// A notice about what already shows where the planner is looking: an answer in the
// open study's chat, or a picture on its map. It goes to the bell without a toast,
// so no toast covers the very answer or card it announces.
export const toastless = (notice: Pick<Notice, "kind" | "studyId">, shown: string | null) =>
  notice.studyId === shown && (notice.kind === "answer" || notice.kind === "media");

// Which toasts go when more show than there's room for: the oldest, but never
// the one with keyboard focus, so a planner on it keeps their place. The newest
// still shows beside it. Ids come newest first.
export function overflow(ids: number[], focused: number | undefined, room: number): number[] {
  const at = focused === undefined ? -1 : ids.indexOf(focused);
  if (at < room) return ids.slice(room);
  return ids.filter((id) => id !== focused).slice(Math.max(1, room - 1));
}
