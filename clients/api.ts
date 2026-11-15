// A small client for the service. Seed, replay, decide and the eval runner all
// use it, so they exercise the same public API as any outside system.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ClientRole = "integration" | "agent" | "planner" | "viewer" | "evaluator";

// Tokens come from TRANSIT_TOKEN_<ROLE>, or from the file the demo script writes
// in the data folder.
function tokenFor(role: ClientRole): string | undefined {
  const fromEnv = process.env[`TRANSIT_TOKEN_${role.toUpperCase()}`];
  if (fromEnv) return fromEnv;
  const file = join(process.env.DATA_DIR ?? join(import.meta.dirname, "../data"), "demo-tokens.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[role];
}

export class ApiClient {
  readonly base: string;
  readonly token: string | undefined;

  constructor(role: ClientRole, base = process.env.TRANSIT_URL ?? "http://127.0.0.1:4100") {
    this.base = base;
    this.token = tokenFor(role);
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${payload.error?.code}: ${payload.error?.message}`);
    return payload;
  }

  get = <T = unknown>(path: string) => this.call<T>("GET", path);
  post = <T = unknown>(path: string, body?: unknown) => this.call<T>("POST", path, body);
  put = <T = unknown>(path: string, body: unknown) => this.call<T>("PUT", path, body);
}
