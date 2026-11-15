import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { liveSkills, skillFiles, skillHash, waiting } from "./skill-hash.ts";

// The same folder as agents/tests/test_skills.py hashes, and the same hash: a planner
// approving it here approves what the agents' loader loads.
const FILES: Record<string, string> = {
  "SKILL.md": "---\nname: tally\ndescription: Count the rows.\n---\nCall tally.\n",
  "tools.py": "def tools(session, study):\n    return []\n",
  "data/rows.json": "[1, 2]\n",
};
const HASH = "ee723d94291e47bdda228f9c32b99d257e1d43f0c278aba8d2c7e78811387869";

describe("skill hash", () => {
  let root: string;
  let folder: string;
  const write = (path: string, text: string, under = folder) => {
    mkdirSync(join(under, path, ".."), { recursive: true });
    writeFileSync(join(under, path), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-hash-"));
    folder = join(root, "tally");
    for (const [path, text] of Object.entries(FILES).reverse()) write(path, text);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("hashes every file's path and bytes, in a stable order, as the agents' loader does", () => {
    assert.deepEqual(skillFiles(folder), ["SKILL.md", "data/rows.json", "tools.py"]);
    assert.equal(skillHash(folder), HASH);
  });

  it("leaves out what Python and Finder write", () => {
    write("__pycache__/tools.cpython-314.pyc", "bytecode");
    write("data/__pycache__/x.pyc", "bytecode");
    write(".DS_Store", "finder");
    assert.equal(skillHash(folder), HASH);
  });

  it("changes when any file changes, moves, or is added", () => {
    write("data/rows.json", "[1, 3]\n");
    const changed = skillHash(folder);
    assert.notEqual(changed, HASH);
    write("data/rows.json", FILES["data/rows.json"] as string);
    assert.equal(skillHash(folder), HASH);
    rmSync(join(folder, "data"), { recursive: true });
    write("rows.json", "[1, 2]\n");
    assert.notEqual(skillHash(folder), HASH);
    rmSync(join(folder, "rows.json"));
    write("data/rows.json", FILES["data/rows.json"] as string);
    write("notes.txt", "");
    assert.notEqual(skillHash(folder), HASH);
  });

  it("follows links, so a candidate's folder of links hashes as a copy would", () => {
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(join(folder, "data"), join(linked, "data"));
    symlinkSync(join(folder, "tools.py"), join(linked, "tools.py"));
    write("SKILL.md", FILES["SKILL.md"] as string, linked);
    assert.equal(skillHash(linked), HASH);
  });

  it("lists the live skills, and those whose hash isn't their current approved version", () => {
    write("SKILL.md", "---\nname: other\ndescription: Other.\n---\nOther.\n", join(root, "other"));
    mkdirSync(join(root, "no-skill-md"));
    const live = liveSkills(root);
    assert.deepEqual(live.map(({ name }) => name), ["other", "tally"]);
    assert.equal(live[1]?.hash, HASH);
    assert.deepEqual(waiting({ tally: HASH }, root), ["other"]);
    assert.deepEqual(waiting({ tally: "0".repeat(64), other: live[0]?.hash as string }, root), ["tally"]);
  });
});
