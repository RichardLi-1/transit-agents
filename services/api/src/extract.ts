// Reads text out of files thrown at the service. PDFs need poppler's pdftotext.
// Without it a PDF is still stored, but it can't back a citation.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Page = { page: number; text: string };

const TEXT_FILE = /\.(txt|md|csv|json|geojson|xml|html?)$/i;

export async function extractPages(name: string, bytes: Uint8Array): Promise<Page[]> {
  if (TEXT_FILE.test(name)) return [{ page: 1, text: new TextDecoder().decode(bytes) }];
  if (!/\.pdf$/i.test(name)) return [];
  const dir = await mkdtemp(join(tmpdir(), "transit-agents-"));
  try {
    const file = join(dir, "upload.pdf");
    await writeFile(file, bytes);
    const { stdout } = await run("pdftotext", ["-layout", file, "-"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout
      .split("\f")
      .map((text, i) => ({ page: i + 1, text }))
      .filter(({ text }) => text.trim());
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
