// When the service requires tokens, open the display once with ?token=... The
// token moves to this tab's session storage and leaves the address bar. It is
// never built into the code. Someone who signs in uses their own token instead.
// A visitor with neither gets a guest pass, which this browser keeps.
import type { GuestPass } from "@transit-agents/contracts";

const KEY = "transit-token";
const PASS = "transit-guest";

function readToken(): string | null {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      sessionStorage.setItem(KEY, fromUrl);
      url.searchParams.delete("token");
      history.replaceState(null, "", url);
    }
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let stored = readToken();
// The signed-in person's access token. It renews itself as it expires.
let personal: (() => Promise<string | undefined>) | undefined;
// The guest pass, for when the browser won't keep it.
let held: string | null = null;

function pass(): string | null {
  try {
    return localStorage.getItem(PASS) ?? held;
  } catch {
    return held;
  }
}

function keepPass(token: string | null) {
  held = token;
  try {
    if (token) localStorage.setItem(PASS, token);
    else localStorage.removeItem(PASS);
  } catch {}
}

// Asks the service for a guest pass of the visitor's own, and keeps it.
export async function mintGuest(): Promise<boolean> {
  const response = await fetch("/v1/guests", { method: "POST" }).catch(() => undefined);
  const minted = response?.ok ? ((await response.json().catch(() => null)) as GuestPass | null) : null;
  if (!minted?.token) return false;
  keepPass(minted.token);
  return true;
}

export function setPersonalToken(get: () => Promise<string | undefined>) {
  personal = get;
}

// Drops the tokens the service refused, so the display carries on without them.
export function forgetTokens() {
  personal = undefined;
  stored = null;
  keepPass(null);
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export const hasToken = () => Boolean(personal ?? stored ?? pass());
// Signed in, or opened with a token. A guest pass is no one's own.
export const hasOwnToken = () => Boolean(personal ?? stored);

// The token to send: the signed-in person's, or else the one the display was
// opened with, or else the guest pass.
export async function bearer(): Promise<string | null> {
  if (!personal) return stored ?? pass();
  return (await personal().catch(() => undefined)) ?? null;
}

export const api = async (path: string, init: RequestInit = {}) => {
  const token = await bearer();
  return fetch(path, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
};

// EventSource can't send headers, so the token goes in the query. A stream that
// starts again carries on after the last entry it had.
export function eventsUrl(token: string | null, after: number) {
  const query = [token ? `access_token=${encodeURIComponent(token)}` : "", after ? `after=${after}` : ""].filter(Boolean).join("&");
  return query ? `/v1/events?${query}` : "/v1/events";
}
