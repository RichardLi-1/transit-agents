// Prints each skill's eval cases by split, to check the scorecard in docs/agents.md.
//
// Usage: node evals/count.ts    (or npm run agent:cases)
import { readCases } from "./score-run.ts";
import { countBySkill, type SkillCount } from "./score.ts";

export function formatCounts(rows: SkillCount[]): string {
  const head = ["skill", "dev", "test", "future", "all", "refuse or flag", "to review"];
  const body = rows.map((r) => [r.skill, r.dev, r.test, r.future, r.dev + r.test + r.future, r.handOver, r.toReview].map(String));
  const sum = (key: "dev" | "test" | "future" | "handOver" | "toReview") => rows.reduce((n, r) => n + r[key], 0);
  const all = sum("dev") + sum("test") + sum("future");
  body.push(["all", sum("dev"), sum("test"), sum("future"), all, sum("handOver"), sum("toReview")].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)));
  const line = (row: string[]) => row.map((cell, i) => (i ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0))).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}

if (import.meta.main) console.log(formatCounts(countBySkill(readCases())));
