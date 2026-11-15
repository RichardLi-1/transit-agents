import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkPrivate, fingerprints, privateDir, readPrivateCases, ROOT, type PrivateCase } from "./private.ts";
import { readCases } from "./score-run.ts";

const CANARY = "transit-agents private eval canary 7f3c9e21-4b8a";
const SECRET: PrivateCase = {
  id: "private-001",
  capability: "find",
  skill: "ttc-standards",
  split: "test",
  query: "What is the late-evening minimum for a Tier 2 bus?",
  canary: CANARY,
  expect: { behaviour: "answer", value: 4321, mentions: ["every thirty minutes until close", "bus"] },
};

const folders: string[] = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const temp = () => {
  const folder = mkdtempSync(join(tmpdir(), "private-split-"));
  folders.push(folder);
  return folder;
};
// A private split's folder, outside the repo, with these cases.
const split = (...cases: unknown[]) => {
  const folder = temp();
  writeFileSync(join(folder, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  return folder;
};
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("the private split", () => {
  it("lives outside the repo, in EVAL_PRIVATE_DIR's cases.jsonl", () => {
    assert.equal(privateDir({}), undefined);
    assert.throws(() => privateDir({ EVAL_PRIVATE_DIR: join(ROOT, "evals") }), /must be outside the repo/);
    assert.throws(() => privateDir({ EVAL_PRIVATE_DIR: temp() }), /has no cases\.jsonl/);
    const folder = split(SECRET);
    assert.equal(privateDir({ EVAL_PRIVATE_DIR: folder }), folder);
  });

  it("holds only test cases, each with a canary and an id of its own", () => {
    assert.deepEqual(readPrivateCases(split(SECRET)), [SECRET]);
    assert.throws(() => readPrivateCases(split({ ...SECRET, canary: undefined })), /line 1: give each private case a canary/);
    assert.throws(() => readPrivateCases(split({ ...SECRET, canary: "short" })), /a canary of 20 characters/);
    assert.throws(() => readPrivateCases(split({ ...SECRET, split: "dev" })), /a private case is a test case/);
    assert.throws(() => readPrivateCases(split(SECRET), ["private-001"]), /already a case's id/);
    assert.throws(() => readPrivateCases(split(SECRET, SECRET)), /line 2: private-001 is already a case's id/);
  });

  it("is merged with the committed cases for scoring, only when EVAL_PRIVATE_DIR is set", () => {
    const committed = readCases(undefined, {});
    const merged = readCases(undefined, { EVAL_PRIVATE_DIR: split(SECRET) });
    assert.equal(merged.length, committed.length + 1);
    assert.deepEqual(merged.at(-1), SECRET);
    assert.throws(() => readCases(undefined, { EVAL_PRIVATE_DIR: split({ ...SECRET, id: "find-001" }) }), /find-001 is already a case's id/);
  });
});

describe("checkPrivate", () => {
  // Folders like the repo's skills, candidates and runs, to plant leaks in.
  const setup = () => {
    const base = temp();
    write(join(base, "agents/skills/ttc-standards/SKILL.md"), "---\nname: ttc-standards\n---\nUse list_rules.\n");
    write(join(base, "evals/runs/20261115T000000Z.jsonl"), JSON.stringify({ id: "find-001", answer: { text: "20" } }) + "\n");
    return { base, roots: ["agents/skills", "agents/skill-candidates", "evals/runs"].map((path) => join(base, path)) };
  };

  it("finds nothing in clean folders", () => {
    const { base, roots } = setup();
    assert.deepEqual(checkPrivate([SECRET], roots, base), []);
  });

  it("finds a canary, a gold answer, required wording or an answer, wherever agents or the evolver read", () => {
    const { base, roots } = setup();
    write(join(base, "agents/skills/ttc-standards/notes.md"), `Copied: ${CANARY}\n`);
    // The gold answer as Python writes it, spaced and with \u escapes, in a candidate.
    const pythonish = JSON.stringify(SECRET.expect).replace(/,/g, ", ").replace(/:/g, ": ");
    write(join(base, "agents/skill-candidates/ttc-standards/abc/SKILL.md"), `---\nname: x\n---\nThe answer: ${pythonish}\n`);
    write(join(base, "evals/runs/20261115T010000Z.jsonl"), JSON.stringify({ id: "private-001", answer: { text: "4321" } }) + "\n");
    write(join(base, "evals/runs/20261115T010000Z/private-001.log.jsonl"), "{}\n");
    const found = checkPrivate([SECRET], roots, base).map((leak) => `${leak.file} ${leak.case} ${leak.what}`);
    assert.deepEqual(found.sort(), [
      "agents/skill-candidates/ttc-standards/abc/SKILL.md private-001 gold answer",
      // The gold answer holds the required wording too.
      "agents/skill-candidates/ttc-standards/abc/SKILL.md private-001 required wording",
      "agents/skills/ttc-standards/notes.md private-001 canary",
      "evals/runs/20261115T010000Z.jsonl private-001 answer to a private case",
      "evals/runs/20261115T010000Z/private-001.log.jsonl private-001 answer to a private case",
    ]);
  });

  it("reads the required wording of three words or more, in any case and spacing", () => {
    const { base, roots } = setup();
    write(join(base, "agents/skill-candidates/ttc-standards/abc/SKILL.md"), "Run EVERY THIRTY\n  minutes until close.\n");
    assert.deepEqual(checkPrivate([SECRET], roots, base).map((leak) => leak.what), ["required wording"]);
    assert.deepEqual(fingerprints(SECRET).wording, ["every thirty minutes until close"]); // "bus" alone is too common
  });

  it("is a command that passes on the repo's own folders and never prints what it found", () => {
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "check-private.ts")], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    const clean = run({ EVAL_PRIVATE_DIR: split(SECRET) });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /^No sign of 1 private cases in agents\/skills, agents\/skill-candidates, evals\/runs\.$/m);
    const inside = run({ EVAL_PRIVATE_DIR: join(ROOT, "evals") });
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /must be outside the repo/);
    assert.equal(run({ EVAL_PRIVATE_DIR: "" }).status, 0);
  });
});
