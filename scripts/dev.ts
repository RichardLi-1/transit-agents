// One command for the whole local demo: builds the display, starts the service
// (seeding it the first time), then the Gemini chat agent and the media agent.
// Ctrl+C stops everything.
//
// Usage: npm run dev [-- --fresh]. --fresh starts from an empty log. PORT and
// DATA_DIR work as for the demo; the agents read GEMINI_API_KEY from agents/.env.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const port = process.env.PORT ?? "4100";
const url = `http://127.0.0.1:${port}`;
const python = join(root, "agents/.venv/bin/python");
const children: ChildProcess[] = [];

// Each process's lines, with its name in front, so one terminal reads clearly.
const run = (name: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}] `;
  const relay = (out: NodeJS.WriteStream) => (chunk: Buffer) =>
    out.write(
      chunk
        .toString()
        .split("\n")
        .filter((line, i, all) => line || i < all.length - 1)
        .map((line) => tag + line)
        .join("\n") + "\n",
    );
  child.stdout?.on("data", relay(process.stdout));
  child.stderr?.on("data", relay(process.stderr));
  child.on("exit", (code) => console.log(`${tag}stopped${code ? ` (exit ${code})` : ""}`));
  children.push(child);
  return child;
};

const stopAll = () => {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

console.log("Building the display…");
if (spawnSync("npx", ["vite", "build", "apps/display", "--logLevel", "warn"], { cwd: root, stdio: "inherit" }).status !== 0) {
  console.error("The display didn't build.");
  process.exit(1);
}

run("service", process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "scripts/demo.ts"), ...process.argv.slice(2)], { DEV_ALL: "1" });

// The agents start once the service answers.
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  up = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!up) {
  console.error(`The service didn't start on ${url}.`);
  stopAll();
} else if (!existsSync(python)) {
  console.log(`\nNo agents/.venv yet, so the agents aren't running. Set it up with:\n  python3 -m venv agents/.venv && agents/.venv/bin/pip install -r agents/requirements.txt\n`);
} else {
  // The agents start once the studies are there, so the chat has somewhere to talk.
  for (let i = 0; i < 300; i++) {
    const studies = await fetch(`${url}/v1/studies`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (Array.isArray(studies) && studies.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const env = { TRANSIT_URL: url, ...(process.env.DATA_DIR ? { DATA_DIR: process.env.DATA_DIR } : {}) };
  run("agent", python, [join(root, "agents/main.py"), "listen"], env);
  run("media", python, [join(root, "agents/media.py"), "listen"], env);
  console.log(`\nOpen ${url}. The chat agent and the media agent are listening. Ctrl+C stops everything.\n`);
}
