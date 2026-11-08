import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

type Feature = {
  properties: { kind: string; name: string; alongMetres?: number };
  geometry: { type: string; coordinates: number[] | number[][] };
};

const read = (name: string) => (JSON.parse(readFileSync(join(import.meta.dirname, "data", name), "utf8")) as { features: Feature[] }).features;
const ontario = read("ontario-line.geojson");
const extension = read("don-mills-extension.geojson");

const stations = (features: Feature[]) => features.filter((f) => f.properties.kind === "station");
const line = (features: Feature[]) => features.find((f) => f.properties.kind === "line")?.geometry.coordinates as number[][];
const inOrder = (list: Feature[]) => list.every((s, i) => !i || (s.properties.alongMetres ?? 0) > (list[i - 1]?.properties.alongMetres ?? 0));

describe("Ontario Line geometry", () => {
  it("runs from Exhibition to Don Valley through 15 stations, in order", () => {
    const list = stations(ontario);
    assert.equal(list.length, 15);
    assert.equal(list[0]?.properties.name, "Exhibition");
    assert.equal(list.at(-1)?.properties.name, "Don Valley");
    assert.ok(inOrder(list));
  });

  it("extends from Don Valley to Sheppard, ending at its last station", () => {
    const list = stations(extension);
    assert.deepEqual(line(extension)[0], line(ontario).at(-1));
    assert.deepEqual(
      list.map((s) => s.properties.name),
      ["Lawrence", "York Mills", "Don Mills"],
    );
    assert.ok(inOrder(list));
    assert.deepEqual(list.at(-1)?.geometry.coordinates, line(extension).at(-1));
  });
});
