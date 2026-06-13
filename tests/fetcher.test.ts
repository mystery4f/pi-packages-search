import { describe, test, expect, mock } from "bun:test";
import { fetchPage } from "../src/crawler/fetcher";

describe("fetcher", () => {
  test("成功返回文本", async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response("<html>ok</html>", { status: 200 })
    )) as any;
    const txt = await fetchPage("https://example.com");
    expect(txt).toBe("<html>ok</html>");
  });
  test("HTTP 错误抛出", async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response("nope", { status: 500 })
    )) as any;
    expect(fetchPage("https://example.com", 2, 10)).rejects.toThrow();
  });
  test("重试后成功", async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      if (calls < 2) return Promise.resolve(new Response("", { status: 500 }));
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as any;
    const txt = await fetchPage("https://example.com", 3, 10);
    expect(txt).toBe("ok");
    expect(calls).toBe(2);
  });
});
