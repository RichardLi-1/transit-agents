// A watched folder. For a system that can only export files on a schedule, this
// is the whole integration: point the export here, or sync a shared folder.
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { NewContext } from "@transit-agents/contracts";
import { extractPages } from "./extract.ts";
import type { Service } from "./service.ts";

const POLL_MS = 2000;

export function watchInbox(service: Service, directory: string) {
  const done = join(directory, "processed");
  const seen = new Map<string, number>();
  let stopped = false;

  const scan = async () => {
    await mkdir(done, { recursive: true });
    for (const name of await readdir(directory)) {
      if (name.startsWith(".") || name === "processed") continue;
      const path = join(directory, name);
      const info = await stat(path);
      if (!info.isFile()) continue;
      // A file still being copied changes size, so wait for two equal readings.
      if (seen.get(name) !== info.size) {
        seen.set(name, info.size);
        continue;
      }
      seen.delete(name);
      const bytes = await readFile(path);
      const pages = await extractPages(name, bytes);
      service.addContext("integration:inbox", NewContext.parse({ title: name, folder: "Inbox", pages }));
      await rename(path, join(done, `${Date.now()}-${name}`));
    }
  };

  const loop = async () => {
    while (!stopped) {
      await scan().catch((error) => console.error("Inbox scan failed:", error));
      await new Promise((resolve) => setTimeout(resolve, POLL_MS).unref());
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
