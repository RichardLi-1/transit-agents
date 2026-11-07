// A small client for the service. Seed, replay and the eval runner all use it, so
// they exercise the same public API as any outside system.
export class ApiClient {
  readonly base: string;
  readonly token: string | undefined;

  constructor(base = process.env.TRANSIT_URL ?? "http://127.0.0.1:4100", token = process.env.TRANSIT_TOKEN) {
    this.base = base;
    this.token = token;
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
  post = <T = unknown>(path: string, body: unknown) => this.call<T>("POST", path, body);
  put = <T = unknown>(path: string, body: unknown) => this.call<T>("PUT", path, body);
}
