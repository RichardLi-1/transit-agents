// Starts a local demo: the API with fresh tokens, then the public sources. Open
// access is switched on explicitly, so the display on this machine acts as a
// planner. Each client still uses its own token, so the log names every actor.
//
// Usage: node scripts/demo.ts [--fresh]. DATA_DIR and PORT work as for the service.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dirname, "..");
const data = resolve(process.env.DATA_DIR ?? join(root, "data"));
const port = process.env.PORT ?? "4100";
const url = `http://127.0.0.1:${port}`;

if (process.argv.includes("--fresh")) {
  for (const file of ["log.db", "log.db-shm", "log.db-wal"]) rmSync(join(data, file), { force: true });
}
if (!existsSync(join(root, "apps/display/dist/index.html"))) {
  console.error("Build the display first: npm run build");
  process.exit(1);
}

// One token per client. "lead" is for your own agents, so the display never
// mistakes their work for the scripted replay. "media" is agents/media.py's.
const clients = [
  { key: "integration", role: "integration", name: "seed" },
  { key: "agent", role: "agent", name: "replay" },
  { key: "lead", role: "agent", name: "lead" },
  { key: "media", role: "agent", name: "media" },
  { key: "planner", role: "planner", name: "demo" },
];
const tokens: Record<string, string> = Object.fromEntries(clients.map(({ key }) => [key, randomBytes(18).toString("base64url")]));
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "demo-tokens.json"), JSON.stringify(tokens, null, 2), { mode: 0o600 });

const api = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "services/api/src/main.ts")], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    AUTH: "open",
    DATA_DIR: data,
    TRANSIT_TOKENS: clients.map(({ key, role, name }) => `${role}:${name}:${tokens[key]}`).join(","),
  },
});
const stop = () => api.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

for (let i = 0; i < 50; i++) {
  const ok = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
  if (ok) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const head = (await (await fetch(`${url}/health`)).json()) as { head: { seq: number } };
if (head.head.seq === 0) {
  const seed = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "clients/seed.ts")], {
    stdio: "inherit",
    env: { ...process.env, DATA_DIR: data, TRANSIT_URL: url },
  });
  await new Promise((resolve) => seed.on("exit", resolve));
}
// Replay, decide and the agents find this service, and the tokens in the same folder.
const settings = [url !== "http://127.0.0.1:4100" && `TRANSIT_URL=${url}`, process.env.DATA_DIR && `DATA_DIR=${data}`].filter(Boolean);
const run = (script: string) => [...settings, "npm run", script].join(" ");
// Nothing is made for an engagement need until the media agent runs.
const media = [...settings, "agents/.venv/bin/python agents/media.py listen"].join(" ");
// npm run dev starts the agents itself, so it skips these hints.
if (!process.env.DEV_ALL) console.log(
  `\nDisplay: ${url}\nNext: ${run("replay")}, then ${run("decide")}\nFor Gemini to answer the chat: ${run("agent")}\n` +
    `Engagement media, with GEMINI_API_KEY in agents/.env: ${media}\n`,
);
