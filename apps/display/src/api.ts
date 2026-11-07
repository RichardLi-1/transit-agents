// When the service requires tokens, open the display once with ?token=... The
// token moves to this tab's session storage and leaves the address bar. It is
// never built into the code.
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

const token = readToken();

export const api = (path: string, init: RequestInit = {}) =>
  fetch(path, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

export const eventsUrl = () => (token ? `/v1/events?access_token=${encodeURIComponent(token)}` : "/v1/events");
