// The display's security policy forbids new Function, so its schemas must not try it.
import assert from "node:assert/strict";
import { it } from "node:test";

it("makes and parses schemas without new Function once jitless.ts is imported first", async () => {
  const original = globalThis.Function;
  let made = 0;
  globalThis.Function = new Proxy(original, {
    construct(target, args) {
      made += 1;
      return Reflect.construct(target, args);
    },
  });
  try {
    await import("./jitless.ts");
    const { Activity } = await import("./index.ts");
    Activity.parse({ kind: "message", text: "Hello" });
    Activity.parse({ kind: "run.started" });
  } finally {
    globalThis.Function = original;
  }
  assert.equal(made, 0);
});
