// When the service requires tokens, open the display once with ?token=... The
// token moves to this tab's session storage and leaves the address bar. It is
// never built into the code. Someone who signs in uses their own token instead.
const KEY = "transit-token";

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

export function setPersonalToken(get: () => Promise<string | undefined>) {
  personal = get;
}

// Drops the tokens the service refused, so the display carries on without them.
export function forgetTokens() {
  personal = undefined;
  stored = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export const hasToken = () => Boolean(personal ?? stored);

// The token to send: the signed-in person's, or else the one the display was opened with.
export async function bearer(): Promise<string | null> {
  if (!personal) return stored;
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
