import { describe, test, expect } from "bun:test";
import { parseDetailHtml, extractManifestTools } from "../src/crawler/detail-parser";

const SAMPLE = `
<article>
  <h2>context-mode</h2>
  <p>MCP plugin that saves 98% of your context window.</p>
  <dl>
    <dt>Version</dt><dd>1.0.162</dd>
    <dt>Author</dt><dd>mksglu</dd>
    <dt>License</dt><dd>Elastic-2.0</dd>
    <dt>Size</dt><dd>3.9 MB</dd>
    <dt>Dependencies</dt><dd>8 dependencies</dd>
    <dt>Downloads</dt><dd>118.3K/mo · 17.8K/wk</dd>
    <dt>Published</dt><dd>Jun 2, 2026</dd>
  </dl>
  <span data-copy-text="pi install npm:context-mode"></span>
  <a href="https://www.npmjs.com/package/context-mode">npm</a>
  <a href="https://github.com/mksglu/context-mode">repo</a>
</article>
<pre><code>{"extensions":["./build/adapters/pi/extension.js"],"skills":["./skills"]}</code></pre>
<main id="readme"><h2>Context Mode</h2><p>The other half of the context problem.</p></main>
`;

describe("detail-parser", () => {
  test("解析元数据", () => {
    const pkg = parseDetailHtml(SAMPLE, "context-mode");
    expect(pkg.name).toBe("context-mode");
    expect(pkg.version).toBe("1.0.162");
    expect(pkg.author).toBe("mksglu");
    expect(pkg.license).toBe("Elastic-2.0");
    expect(pkg.size).toBe("3.9 MB");
    expect(pkg.dependenciesCount).toBe(8);
  });
  test("解析下载量", () => {
    const pkg = parseDetailHtml(SAMPLE, "context-mode");
    expect(pkg.downloadsMonthly).toBe(118300);
    expect(pkg.downloadsWeekly).toBe(17800);
  });
  test("解析 README 与 manifest", () => {
    const pkg = parseDetailHtml(SAMPLE, "context-mode");
    expect(pkg.readme).toContain("Context Mode");
    expect(pkg.manifest).toContain('"extensions"');
  });
  test("searchText 合并 name+description", () => {
    const pkg = parseDetailHtml(SAMPLE, "context-mode");
    expect(pkg.searchText).toContain("context-mode");
    expect(pkg.installCmd).toBe("pi install npm:context-mode");
  });
  test("extractManifestTools 提取扩展/技能路径", () => {
    const tools = extractManifestTools('{"extensions":["./a.js","./b.js"],"skills":["./skills"]}');
    expect(tools).toContain("a.js");
    expect(tools).toContain("b.js");
  });
});
