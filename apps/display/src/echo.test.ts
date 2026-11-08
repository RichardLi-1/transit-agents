import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { echoesDocument } from "./echo.ts";

const URL_PATH = "/v1/media/4e82741a839450cac8d19a64a686e46094a3058afd06bda91ab08ff1e078d186";

describe("a document's ready line", () => {
  it("echoes a document the chat shows, at any address", () => {
    assert.equal(echoesDocument(`Document ready: TPAP brief: Ontario Line. http://127.0.0.1:4610${URL_PATH}`, [URL_PATH]), true);
    assert.equal(echoesDocument(`Document ready: TPAP brief. https://transit-agents.fly.dev${URL_PATH}`, [`https://transit-agents.fly.dev${URL_PATH}`]), true);
  });

  it("doesn't echo one the chat doesn't show, or any other answer", () => {
    assert.equal(echoesDocument(`Document ready: TPAP brief. http://127.0.0.1:4610${URL_PATH}`, []), false);
    assert.equal(echoesDocument(`Document ready: TPAP brief. http://127.0.0.1:4610/v1/media/other`, [URL_PATH]), false);
    assert.equal(echoesDocument(`The brief is at ${URL_PATH}`, [URL_PATH]), false);
    assert.equal(echoesDocument("The document couldn't be made: a point had no page.", [URL_PATH]), false);
  });
});
