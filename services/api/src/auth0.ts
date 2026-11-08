// People sign in with Auth0. A bearer token that isn't a static token is checked
// here as an Auth0 access token: signed with RS256 by one of the tenant's keys,
// issued by the tenant for this API, and in date.
import type { Role, SignIn } from "@transit-agents/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Verified } from "./app.ts";

export type Auth0Options = {
  domain: string;
  audience: string;
  // The claim with the person's name, which an Auth0 Action adds. Without it, the
  // name is the token's subject.
  nameClaim?: string;
  // The tenant's signing keys. By default they are fetched from its JWKS, and cached.
  keys?: JWTVerifyGetKey;
};

// With RBAC and "Add Permissions in the Access Token" on, the token lists the
// person's permissions. The first of these they hold is their role.
const ROLES: Role[] = ["planner", "integration", "agent"];

export function verifyAuth0({ domain, audience, nameClaim = "https://transit-agents/name", keys }: Auth0Options) {
  const issuer = `https://${domain}/`;
  const getKey: JWTVerifyGetKey = keys ?? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  return async (token: string): Promise<Verified | undefined> => {
    try {
      const { payload } = await jwtVerify(token, getKey, { algorithms: ["RS256"], issuer, audience, clockTolerance: 30, requiredClaims: ["exp"] });
      return actorOf(payload, nameClaim);
    } catch {
      return undefined;
    }
  };
}

function actorOf(payload: JWTPayload, nameClaim: string): Verified {
  const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];
  const claim = payload[nameClaim];
  const subject = typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
  const name = typeof claim === "string" && claim ? claim : (subject ?? "");
  return { role: ROLES.find((role) => permissions.includes(role)) ?? "viewer", name: cleanName(name), subject };
}

// With AUTH0_DOMAIN and AUTH0_AUDIENCE set, the service takes Auth0 access tokens.
// With AUTH0_CLIENT_ID too, people can sign in from the display, which learns all
// three from /v1/config. AUTH0_NAME_CLAIM names the claim with a person's name.
export function auth0Settings(env: Record<string, string | undefined>, keys?: JWTVerifyGetKey) {
  const { AUTH0_AUDIENCE: audience, AUTH0_CLIENT_ID: clientId } = env;
  // Host names ignore case, but the issuer check doesn't, and the tenant's tokens
  // name it in lowercase. The display and the CSP get the same form.
  const domain = env.AUTH0_DOMAIN?.toLowerCase();
  if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    throw new Error(`AUTH0_DOMAIN should be a host name, such as tenant.us.auth0.com, not "${env.AUTH0_DOMAIN}"`);
  }
  const verifyToken = domain && audience ? verifyAuth0({ domain, audience, nameClaim: env.AUTH0_NAME_CLAIM || undefined, keys }) : undefined;
  const signIn: SignIn | null = domain && audience && clientId ? { provider: "auth0", domain, clientId, audience } : null;
  return { verifyToken, signIn };
}

// The name goes into the log as role:name, so it keeps to plain characters.
const cleanName = (name: string) => name.replace(/[^A-Za-z0-9._@-]/gu, "-").slice(0, 80) || "user";
