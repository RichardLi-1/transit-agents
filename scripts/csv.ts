// Streams rows of a GTFS file. Handles quoted fields, which some feeds use for
// every headsign and others for none.
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function parseCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

export async function* rows(directory: string, file: string): AsyncGenerator<Record<string, string>> {
  const lines = createInterface({ input: createReadStream(join(directory, file)), crlfDelay: Infinity });
  let header: string[] | undefined;
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, "");
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells.map((h) => h.trim());
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((key, i) => (row[key] = (cells[i] ?? "").trim()));
    yield row;
  }
}
