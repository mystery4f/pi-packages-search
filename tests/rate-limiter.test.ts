import { describe, test, expect } from "bun:test";
import { AdaptiveLimiter } from "../src/crawler/rate-limiter";

describe("AdaptiveLimiter", () => {
  test("初始并发为目标值", () => {
    const l = new AdaptiveLimiter(15);
    expect(l.current()).toBe(15);
  });
  test("记录失败降并发", () => {
    const l = new AdaptiveLimiter(15);
    l.recordFailure();
    expect(l.current()).toBeLessThan(15);
  });
  test("记录成功逐步回升", () => {
    const l = new AdaptiveLimiter(15);
    l.recordFailure();
    const afterFail = l.current();
    // 每 5 次成功 +1，足够多次后回升到 target
    for (let i = 0; i < 100; i++) l.recordSuccess();
    expect(l.current()).toBe(15);
    expect(l.current()).toBeGreaterThan(afterFail);
  });
  test("不低于下限", () => {
    const l = new AdaptiveLimiter(15);
    for (let i = 0; i < 100; i++) l.recordFailure();
    expect(l.current()).toBeGreaterThanOrEqual(2);
  });
});
