// Chat messages a viewer pins: theirs alone, kept in this browser, by study, by the
// message's place in the log. The chat shows them in a strip at its top.

export type Pins = Record<string, number[]>;

const KEY = "chat.pins";
// The most a study keeps; pinning one more lets go of the oldest.
export const MOST = 12;

type Read = Pick<Storage, "getItem">;
type Write = Pick<Storage, "setItem">;

export function readPins(storage: Read | null = safeStorage()): Pins {
  try {
    const kept = JSON.parse(storage?.getItem(KEY) ?? "{}") as unknown;
    if (!kept || typeof kept !== "object" || Array.isArray(kept)) return {};
    const pins: Pins = {};
    for (const [study, seqs] of Object.entries(kept)) {
      if (Array.isArray(seqs)) pins[study] = seqs.filter((seq): seq is number => Number.isInteger(seq)).slice(-MOST);
    }
    return pins;
  } catch {
    return {};
  }
}

export function keepPins(pins: Pins, storage: Write | null = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Storage blocked: the pins hold until the page closes.
  }
}

// Pins a message if it isn't, and unpins it if it is, newest last.
export function togglePin(pins: Pins, study: string, seq: number): Pins {
  const now = pins[study] ?? [];
  const next = now.includes(seq) ? now.filter((s) => s !== seq) : [...now, seq].slice(-MOST);
  const out = { ...pins };
  if (next.length) out[study] = next;
  else delete out[study];
  return out;
}

// A pinned message's line in the strip: its first line, as plain words, cut short.
export function pinLine(text: string, most = 90): string {
  const first = text.replace(/\*\*/g, "").split("\n").find((line) => line.trim()) ?? "";
  const words = first.replace(/\s+/g, " ").trim();
  return words.length > most ? `${words.slice(0, most - 1).trimEnd()}…` : words;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
