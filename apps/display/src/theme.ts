// The display's theme: light or dark, as the viewer chooses in Settings, or as the
// system is. The choice is the viewer's alone, kept in this browser. public/theme.js
// sets data-theme before the first paint; this keeps it right as the choice or the
// system changes, and tells whoever listens, such as the map.

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "theme";
const listeners = new Set<(theme: Theme) => void>();

function systemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readChoice(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemeChoice {
  try {
    const kept = storage?.getItem(KEY);
    return kept === "light" || kept === "dark" ? kept : "system";
  } catch {
    return "system";
  }
}

// The theme a choice comes to, given whether the system is dark.
export function resolve(choice: ThemeChoice, dark = systemDark()): Theme {
  return choice === "system" ? (dark ? "dark" : "light") : choice;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function apply(theme: Theme) {
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener(theme);
}

export function setChoice(choice: ThemeChoice, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()) {
  try {
    if (choice === "system") storage?.removeItem(KEY);
    else storage?.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice holds until the page closes.
  }
  apply(resolve(choice));
}

// Hears each change of theme, from Settings or from the system. Returns a stop.
export function onTheme(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Follows the system while the choice is System. Called once, at start.
export function followSystem() {
  apply(resolve(readChoice()));
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readChoice() === "system") apply(resolve("system"));
  });
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
