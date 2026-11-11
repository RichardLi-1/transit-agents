// The docs' data: each skill as its SKILL.md and the eval cases give it, and the
// committed skills.json kept true to them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readCases as readEvalCases } from "../evals/score-run.ts";
import { countBySkill } from "../evals/score.ts";
import { type Case, docsData, type DocsData, format, frontmatter, OUT, readCases, readSkills, summary } from "./build-docs-data.ts";

const committed = JSON.parse(readFileSync(OUT, "utf8")) as DocsData;

describe("the docs data", () => {
  it("reads a SKILL.md's name and description as agents/skills.py does", () => {
    const text = ["---", "name: quote-check", "description: Check that a quote", "  is on its page.", "# a comment", "other: 'quoted'", "---", "Read the page."].join("\n");
    assert.deepEqual(frontmatter(text), { name: "quote-check", description: "Check that a quote is on its page.", other: "quoted" });
    assert.throws(() => frontmatter("name: x"), /start with frontmatter/);
    assert.throws(() => frontmatter("---\nname: x\n"), /close the frontmatter/);
  });

  it("drops only the sentences that send the lead to another skill", () => {
    assert.equal(
      summary("Count trips (O. Reg. 191/11 p. 4). For headways use gtfs-analyst. Forecasts no growth. For the lead, with get_study."),
      "Count trips (O. Reg. 191/11 p. 4). Forecasts no growth.",
    );
    assert.equal(summary("Lay out a case. It fills in no figures."), "Lay out a case. It fills in no figures.");
  });

  it("gives each skill its scripts' tools and its cases by split, and the eval set's totals", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-skills-"));
    try {
      for (const [name, tools] of [["alpha", true], ["beta", false]] as const) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}. For more use beta.\n---\nSteps.\n`);
        if (tools) writeFileSync(join(dir, name, "tools.py"), "def tools(session, study): return []\n");
      }
      mkdirSync(join(dir, "notes")); // a folder without a SKILL.md isn't a skill
      const cases: Case[] = [
        { id: "a1", skill: "alpha", split: "dev" },
        { id: "a2", skill: "alpha", split: "test", review: "planner" },
        { id: "a3", skill: "alpha", split: "future", perturbed: true },
        { id: "b1", skill: "beta", split: "test" },
      ];
      const data = docsData(readSkills(dir), cases, { alpha: 3 });
      assert.deepEqual(data.skills, [
        { name: "alpha", description: "Does alpha. For more use beta.", summary: "Does alpha.", scripts: true, tools: 3, cases: { dev: 1, test: 1, future: 1 } },
        { name: "beta", description: "Does beta. For more use beta.", summary: "Does beta.", scripts: false, tools: null, cases: { dev: 0, test: 1, future: 0 } },
      ]);
      assert.deepEqual(data.evals, { cases: 4, dev: 1, test: 2, future: 1, review: 1, changed: 1 });
      // Without the agents' Python, the counts it had are kept.
      assert.equal(docsData(readSkills(dir), cases, null, data).skills[0]?.tools, 3);
      assert.equal(docsData(readSkills(dir), cases, null).skills[0]?.tools, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skills.json is up to date with agents/skills and evals/cases.jsonl (npm run build writes it)", () => {
    const fresh = docsData(readSkills(), readCases(), null, committed);
    assert.equal(format(committed), format(fresh), "run npm run build, or node scripts/build-docs-data.ts, and commit skills.json");
    for (const skill of committed.skills) {
      if (skill.scripts) assert.ok((skill.tools ?? 0) > 0, `${skill.name} has scripts, but no tools counted`);
    }
  });

  it("counts each skill's cases as npm run agent:cases does", () => {
    const counts = countBySkill(readEvalCases());
    assert.deepEqual(
      committed.skills.map(({ name, cases }) => ({ skill: name, ...cases })),
      counts.map(({ skill, dev, test, future }) => ({ skill, dev, test, future })),
    );
  });
});
