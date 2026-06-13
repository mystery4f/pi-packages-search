import { describe, test, expect } from "bun:test";
import { parseListHtml, parseTotalPages, parseTotalCount } from "../src/crawler/list-parser";

const SAMPLE = `
<nav><a href="/packages?page=1">1</a><a href="/packages?page=2">2</a><a href="/packages?page=3">3</a></nav>
<div>1-20 / 60</div>
<article data-package-card="true" data-package-name="context-mode" data-package-search="context-mode MCP plugin saves context" data-package-types="extension,skill" data-package-downloads="118300" data-package-date="1749800000000">
  <a href="https://www.npmjs.com/package/context-mode">npm</a>
  <span data-copy-text="pi install npm:context-mode">install</span>
</article>
<article data-package-card="true" data-package-name="pi-subagents" data-package-search="pi-subagents delegate tasks" data-package-types="package" data-package-downloads="97400" data-package-date="1749700000000">
</article>
`;

describe("list-parser", () => {
  test("解析总页数", () => {
    expect(parseTotalPages(SAMPLE)).toBe(3);
  });
  test("解析总包数", () => {
    expect(parseTotalCount(SAMPLE)).toBe(60);
  });
  test("解析包列表", () => {
    const pkgs = parseListHtml(SAMPLE);
    expect(pkgs).toHaveLength(2);
    expect(pkgs[0].name).toBe("context-mode");
    expect(pkgs[0].date).toBe(1749800000000);
    expect(pkgs[0].downloads).toBe(118300);
    expect(pkgs[1].name).toBe("pi-subagents");
  });
  test("无包时返回空数组", () => {
    expect(parseListHtml("<html></html>")).toEqual([]);
  });
});
