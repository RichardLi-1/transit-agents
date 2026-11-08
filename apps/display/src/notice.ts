// The service's words when it turns down something the person asked for, such as
// a message once visitors' budget is spent. The chat shows it in one line.
import { useEffect, useState } from "preact/hooks";

let notice: string | null = null;
const listeners = new Set<(notice: string | null) => void>();

export function setNotice(next: string | null) {
  notice = next;
  for (const listener of listeners) listener(next);
}

export function useNotice(): string | null {
  const [value, setValue] = useState(notice);
  useEffect(() => {
    listeners.add(setValue);
    setValue(notice);
    return () => void listeners.delete(setValue);
  }, []);
  return value;
}

// The service's words, unless the chat's last message says just that, as when an
// agent's run stopped for the same reason: they would show twice in a row.
export const unsaid = (said: string | null, last: string | undefined) => (said === last ? null : said);

// What the service said in refusing: { error: { message } }.
export async function refusal(response: Response | undefined): Promise<string | null> {
  const body = (await response?.json().catch(() => null)) as { error?: { message?: unknown } } | null | undefined;
  return typeof body?.error?.message === "string" ? body.error.message : null;
}
