// Guest passes let a visitor act without signing in, in a sandbox of their own.
// A pass is g1.<id>.<exp>.<sig>: a random id, when it expires in Unix seconds,
// and an HMAC of both under GUEST_SECRET. The service keeps no record of the
// passes it gives out: the signature alone shows it gave this one, unchanged.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GuestPass } from "@transit-agents/contracts";

const VERSION = "g1";
const LIFETIME_SECONDS = 7 * 24 * 60 * 60;
// 16 random bytes, base64url, with no padding.
const ID = /^[A-Za-z0-9_-]{22}$/;

const signature = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function issueGuest(secret: string, now: Date): GuestPass {
  const id = randomBytes(16).toString("base64url");
  const exp = Math.floor(now.getTime() / 1000) + LIFETIME_SECONDS;
  const body = `${VERSION}.${id}.${exp}`;
  return { token: `${body}.${signature(secret, body)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

// The pass's id, when the service signed this pass and it hasn't expired.
export function verifyGuest(secret: string, token: string, now: Date): { id: string } | undefined {
  const parts = token.split(".");
  if (parts.length !== 4) return undefined;
  const [version, id = "", exp = "", sig = ""] = parts;
  if (version !== VERSION || !ID.test(id) || !/^\d{1,12}$/.test(exp)) return undefined;
  if (Number(exp) * 1000 <= now.getTime()) return undefined;
  const expected = Buffer.from(signature(secret, `${VERSION}.${id}.${exp}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return { id };
}

// The audience of someone signed in who isn't a planner. It stays the same each
// time they sign in, and doesn't show who they are. It is keyed with the secret:
// a private entry's hash takes in its audience, so anyone who could work the
// audience out from a subject could test guesses at that entry's content.
export const userAudience = (secret: string, subject: string) =>
  `user:${createHmac("sha256", secret).update(subject).digest("base64url").slice(0, 22)}`;
