// Who is looking at the display, and how people sign in. People sign in with
// Auth0. Its SDK loads only when someone asks to sign in, or comes back from it.
import { useEffect, useState } from "preact/hooks";
import type { Auth0Client } from "@auth0/auth0-spa-js";
import type { Me, Role, ServiceConfig, SignIn } from "@transit-agents/contracts";
import { api, forgetTokens, hasToken, setPersonalToken } from "./api.ts";

export type Session = {
  config: ServiceConfig | null;
  // Who the service takes the display for, when it says.
  me: Me | null;
  // Holds no token, so the display acts as whoever a request without one does.
  anonymous: boolean;
  signedIn: boolean;
  // The display may read: the service took its token, or lets anyone read.
  reads: boolean;
};

// What the service lets the display's role do, so the display offers nothing else:
// adding context, posting to a study's chat, and asking for engagement media.
const ADDS: Role[] = ["integration", "agent", "planner"];
const POSTS: Role[] = ["agent", "planner"];
export const canAdd = (me: Me | null) => Boolean(me && ADDS.includes(me.role));
export const canPost = (me: Me | null) => Boolean(me && POSTS.includes(me.role));
export const canCreate = (me: Me | null) => me?.role === "planner";

type AppState = { hash?: string };

let config: Promise<ServiceConfig | null> | undefined;
const loadConfig = () =>
  (config ??= fetch("/v1/config")
    .then((response) => (response.ok ? (response.json() as Promise<ServiceConfig>) : null))
    .catch(() => null));

let auth0: Auth0Client | undefined;

async function createClient({ domain, clientId, audience }: SignIn): Promise<Auth0Client> {
  const { Auth0Client } = await import("@auth0/auth0-spa-js");
  return new Auth0Client({
    domain,
    clientId,
    cacheLocation: "memory",
    // Ask for planner by name: the API grants permissions per app, so a
    // permission the app doesn't request can be left out of the token.
    authorizationParams: { audience, scope: "openid profile email planner", redirect_uri: location.origin + location.pathname },
  });
}

// Where the person was when they went to sign in. The SDK hands it back in
// appState, except when signing in fails after the tenant sends them back.
const RETURN_TO = "transit-return-to";

export async function signIn(tenant: SignIn) {
  const client = await createClient(tenant);
  try {
    sessionStorage.setItem(RETURN_TO, location.hash);
  } catch {}
  await client.loginWithRedirect<AppState>({ appState: { hash: location.hash } });
}

function returnTo(): string {
  try {
    const hash = sessionStorage.getItem(RETURN_TO) ?? "";
    sessionStorage.removeItem(RETURN_TO);
    return hash;
  } catch {
    return "";
  }
}

export async function signOut() {
  await auth0?.logout({ logoutParams: { returnTo: location.origin + location.pathname } });
}

// Auth0 sends people back with ?code=...&state=..., or with ?error=...&state=...
// when they cancel or the tenant turns them away. This finishes signing in before
// the display reads the address, and puts back the study they had open.
export async function finishSignIn() {
  const query = new URLSearchParams(location.search);
  if (!query.has("state") || !(query.has("code") || query.has("error"))) return;
  const tenant = (await loadConfig())?.signIn;
  if (!tenant) return;
  const kept = returnTo();
  let hash = "";
  try {
    const client = await createClient(tenant);
    hash = (await client.handleRedirectCallback<AppState>()).appState?.hash ?? kept;
    auth0 = client;
    setPersonalToken(() => client.getTokenSilently());
  } catch (error) {
    // A failed sign-in leaves the person signed out, back where they were.
    hash = (error as { appState?: AppState }).appState?.hash ?? kept;
  }
  history.replaceState(null, "", location.pathname + hash);
}

const whoAmI = () => api("/v1/me").catch(() => undefined);
const read = async (response: Response | undefined) => (response?.ok ? ((await response.json().catch(() => null)) as Me | null) : null);

// Asks how people sign in and who the display is at the same time, and lets reads
// start as soon as they can: once the service takes the display's token, or, with
// none, once it says anyone may read. Each answer is published as it lands.
export async function followSession(publish: (session: Session) => void) {
  let session: Session = { config: null, me: null, anonymous: !hasToken(), signedIn: auth0 !== undefined, reads: false };
  const update = (change: Partial<Session>) => publish((session = { ...session, ...change }));
  const config = loadConfig();
  if (hasToken()) {
    void config.then((value) => update({ config: value }));
    const response = await whoAmI();
    if (response?.status !== 401) return update({ me: await read(response), reads: true });
    // A token the service refuses is dropped, rather than sent again and again.
    forgetTokens();
    auth0 = undefined;
    update({ anonymous: true, signedIn: false });
  }
  const value = await config;
  // In token mode the service answers nobody without a token, so don't ask.
  if (value?.auth === "token") return update({ config: value });
  update({ config: value, reads: true });
  update({ me: await read(await whoAmI()) });
}

export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => void followSession(setSession), []);
  return session;
}
