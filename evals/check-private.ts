// Checks that nothing of the private test split is where agents or the evolver read:
// the skills, the skill candidates and the eval runs. It fails, with each file and the
// case it holds something of, if it finds a private case's canary, its gold answer, its
// required wording, or an answer to it. It never prints what it found.
//
// Usage: EVAL_PRIVATE_DIR=<folder outside the repo> npm run eval:check-private
import { readCases } from "./score-run.ts";
import { checkPrivate, privateDir, readPrivateCases, SCANNED } from "./private.ts";

try {
  const folder = privateDir();
  if (!folder) {
    console.log("EVAL_PRIVATE_DIR isn't set, so there is no private split to look for.");
    process.exit(0);
  }
  const committed = readCases(undefined, {});
  const cases = readPrivateCases(folder, committed.map((c) => c.id));
  const leaks = checkPrivate(cases);
  if (!leaks.length) {
    console.log(`No sign of ${cases.length} private cases in ${SCANNED.join(", ")}.`);
    process.exit(0);
  }
  console.error(`Found ${leaks.length} ${leaks.length === 1 ? "leak" : "leaks"} of the private split:`);
  for (const leak of leaks) console.error(`  ${leak.file}: ${leak.case}'s ${leak.what}`);
  process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
