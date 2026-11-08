// What the agents have spent, from the service. It loads once, again soon after
// an agent reports a model call, and every 30 s in case the event stream drops.
// A failed request keeps the last numbers.
import { useEffect, useState } from "preact/hooks";
import type { Activity, LogEntry, ServiceConfig, Usage } from "@transit-agents/contracts";
import { api, bearer, eventsUrl, forgetTokens, hasToken } from "../api.ts";

// A burst of model calls costs one request.
const SOON_MS = 500;
const POLL_MS = 30_000;

export function useUsage(): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => watchUsage(setUsage), []);
  return usage;
}

// Passes each new total to show, or null once the service lets the screen read
// nothing. Returns a function that stops watching.
export function watchUsage(show: (usage: Usage | null) => void): () => void {
  let asked = 0;
  let applied = 0;
  let soon = 0;
  let poll = 0;
  let source: EventSource | undefined;
  let stopped = false;
  let config: Promise<ServiceConfig | null> | undefined;

  const stop = () => {
    stopped = true;
    source?.close();
    clearTimeout(soon);
    clearInterval(poll);
  };

  // Nothing can be read, so the screen stops asking, and shows no numbers
  // rather than old ones that look live.
  const refused = () => {
    if (stopped) return;
    stop();
    show(null);
  };

  // In token mode the service answers nobody without a token, so the screen
  // doesn't ask. The service's config says which mode it's in.
  const anyoneReads = async () => {
    config ??= fetch("/v1/config")
      .then((response) => (response.ok ? (response.json() as Promise<ServiceConfig>) : null))
      .catch(() => null);
    return (await config)?.auth !== "token";
  };

  // A token the service refuses is dropped, as on the main display, and the
  // request goes again without it, since a demo lets anyone read.
  const get = async (path: string): Promise<Response | undefined> => {
    if (!hasToken() && !(await anyoneReads())) return void refused();
    const response = await api(path);
    if (response.status !== 401) return response;
    if (!hasToken()) return void refused();
    forgetTokens();
    return get(path);
  };

  const load = async () => {
    const ticket = ++asked;
    try {
      const response = await get("/v1/usage");
      if (!response?.ok) return;
      const { total } = (await response.json()) as { total: Usage };
      // A slow reply doesn't overwrite a newer one.
      if (ticket < applied || stopped) return;
      applied = ticket;
      show(total);
    } catch {
      // Offline, or the service is restarting.
    }
  };

  const loadSoon = () => {
    soon ||= window.setTimeout(() => {
      soon = 0;
      void load();
    }, SOON_MS);
  };

  // The stream starts at the log's head, so it sends only what happens next,
  // not the whole log. The head is read before the totals, so a model call
  // between the two still arrives on the stream.
  const listen = async () => {
    try {
      const response = await get("/v1/log/head");
      if (!response?.ok) return;
      const { seq } = (await response.json()) as { seq: number };
      const token = await bearer();
      if (stopped) return;
      const url = new URL(eventsUrl(token, seq), location.href);
      url.searchParams.set("types", "activity");
      source?.close();
      source = new EventSource(url);
      source.addEventListener("activity", (event: MessageEvent<string>) => {
        const entry = JSON.parse(event.data) as LogEntry;
        if ((entry.data as Activity).kind === "usage") loadSoon();
      });
      // A model call made for a visitor, which the screen can't read, comes empty.
      source.addEventListener("usage", loadSoon);
    } catch {
      // The next poll tries again.
    }
  };

  const refresh = async () => {
    // The browser stops retrying a stream the service refused.
    if (!source || source.readyState === EventSource.CLOSED) await listen();
    if (!stopped) await load();
  };

  void refresh();
  poll = window.setInterval(() => void refresh(), POLL_MS);

  return stop;
}
