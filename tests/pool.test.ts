import { describe, test, expect } from "bun:test";
import { pool } from "../src/crawler/pool";

describe("pool", () => {
  test("处理所有项", async () => {
    const items = [1, 2, 3, 4, 5];
    const out: number[] = [];
    await pool(items, 2, async (n) => { out.push(n); });
    expect(out.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  test("并发数不超限", async () => {
    let running = 0, maxRunning = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await pool(items, 3, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(10);
      running--;
    });
    expect(maxRunning).toBeLessThanOrEqual(3);
  });
  test("空数组直接完成", async () => {
    await pool([], 5, async () => {});
  });
});
