// Which toasts go when more show than there's room for: the oldest, but never
// the one with keyboard focus, so a planner on it keeps their place. The newest
// still shows beside it. Ids come newest first.
export function overflow(ids: number[], focused: number | undefined, room: number): number[] {
  const at = focused === undefined ? -1 : ids.indexOf(focused);
  if (at < room) return ids.slice(room);
  return ids.filter((id) => id !== focused).slice(Math.max(1, room - 1));
}
