import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGET_SPENT, RATE_LIMITED } from "@transit-agents/contracts";
import { unsaid } from "./notice.ts";

describe("the notice under the chat", () => {
  it("says why a message wasn't sent, unless the chat's last message just said it", () => {
    assert.equal(unsaid(BUDGET_SPENT, BUDGET_SPENT), null);
    assert.equal(unsaid(BUDGET_SPENT, "Draft ready for planners."), BUDGET_SPENT);
    assert.equal(unsaid(RATE_LIMITED, BUDGET_SPENT), RATE_LIMITED);
    assert.equal(unsaid(BUDGET_SPENT, undefined), BUDGET_SPENT);
    assert.equal(unsaid(null, BUDGET_SPENT), null);
  });
});
