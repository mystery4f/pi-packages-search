import { describe, test, expect } from "bun:test";
import { computeDiff } from "../src/crawler/incremental";
import type { ListPackage } from "../src/shared/types";

describe("incremental computeDiff", () => {
  const now: ListPackage[] = [
    { name: "a", date: 100, downloads: 1 },
    { name: "b", date: 200, downloads: 2 },  // 更新了(date 增大)
    { name: "c", date: 300, downloads: 3 },  // 新增
  ];
  const prev = { a: 100, b: 100, d: 50 };  // d 消失

  test("识别新增包", () => {
    const diff = computeDiff(now, prev);
    expect(diff.added).toEqual(["c"]);
  });
  test("识别更新包", () => {
    const diff = computeDiff(now, prev);
    expect(diff.updated).toEqual(["b"]);
  });
  test("识别消失包", () => {
    const diff = computeDiff(now, prev);
    expect(diff.removed).toEqual(["d"]);
  });
  test("toFetch = added + updated", () => {
    const diff = computeDiff(now, prev);
    expect(diff.toFetch.sort()).toEqual(["b", "c"]);
  });
  test("prev 为空时全部为新增", () => {
    const diff = computeDiff(now, {});
    expect(diff.added.sort()).toEqual(["a", "b", "c"]);
    expect(diff.toFetch.sort()).toEqual(["a", "b", "c"]);
  });
});
