import { describe, test, expect } from "bun:test";
import { WorkerPool } from "../src/crawler/worker-pool";

describe("worker-pool", () => {
  test("并行解析多个 HTML 片段", async () => {
    const wp = new WorkerPool(2);
    const samples = [
      { name: "pkg-a", html: '<main id="readme"><p>Alpha</p></main>' },
      { name: "pkg-b", html: '<main id="readme"><p>Beta</p></main>' },
    ];
    const results = await Promise.all(
      samples.map((s) => wp.parse(s.name, s.html))
    );
    expect(results[0].name).toBe("pkg-a");
    expect(results[0].readme).toContain("Alpha");
    expect(results[1].name).toBe("pkg-b");
    wp.terminate();
  }, 15000);
});
