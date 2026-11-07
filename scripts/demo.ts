// Starts a local demo: the API with fresh tokens, then the public sources. Open
// access is switched on explicitly, so the display on this machine acts as a
// planner. Each client still uses its own token, so the log names every actor.
//
// Usage: node scripts/demo.ts [--fresh]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const data = join(root, "data");
const port = process.env.PORT ?? "4100";

if (process.argv.includes("--fresh")) {
  for (const file of ["log.db", "log.db-shm", "log.db-wal"]) rmSync(join(data, file), { force: true });
}
if (!existsSync(join(root, "apps/display/dist/index.html"))) {
  console.error("Build the display first: npm run build");
  process.exit(1);
}

const tokens = Object.fromEntries(["integration", "agent", "planner"].map((role) => [role, randomBytes(18).toString("base64url")]));
writeFileSync(join(data, "demo-tokens.json"), JSON.stringify(tokens, null, 2), { mode: 0o600 });
const names: Record<string, string> = { integration: "seed", agent: "replay", planner: "demo" };

const api = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "services/api/src/main.ts")], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    AUTH: "open",
    DATA_DIR: data,
    TRANSIT_TOKENS: Object.entries(tokens)
      .map(([role, token]) => `${role}:${names[role]}:${token}`)
      .join(","),
  },
});
const stop = () => api.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

for (let i = 0; i < 50; i++) {
  const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
  if (ok) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const head = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { head: { seq: number } };
if (head.head.seq === 0) {
  const seed = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "clients/seed.ts")], { stdio: "inherit" });
  await new Promise((resolve) => seed.on("exit", resolve));
}
console.log(`\nDisplay: http://127.0.0.1:${port}\nNext: npm run replay, then npm run decide\n`);
