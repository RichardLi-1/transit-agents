// A display served from this machine is a test build, marked so that nobody takes
// it for the deployed one. Browsers give the IPv6 loopback in brackets: [::1].
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const isTestBuild = (hostname: string) => LOCAL.has(hostname) || hostname.endsWith(".localhost");

// A source's address, only if it's a web page: a link must never run script, even
// where the page's security policy would stop it.
export function webUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}
