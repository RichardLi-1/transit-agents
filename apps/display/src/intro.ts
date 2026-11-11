// The opening card: shown once in a browser, the first time the app opens. Settings can
// show it again; ?nointro in the address skips it, for screenshots and recordings.

const KEY = "intro.seen";
export const SHOW_INTRO = "intro:show";

export function shouldShowIntro(
  search: string,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): boolean {
  if (new URLSearchParams(search).has("nointro")) return false;
  try {
    return storage?.getItem(KEY) !== "1";
  } catch {
    return true;
  }
}

export function markIntroSeen(storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(KEY, "1");
  } catch {
    // Storage blocked: it shows again next time, which is harmless.
  }
}

// Asks the app to show the card again, as Settings does.
export function showIntro() {
  window.dispatchEvent(new Event(SHOW_INTRO));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
