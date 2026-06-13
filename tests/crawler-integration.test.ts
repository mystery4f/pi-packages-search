import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/db/schema";
import { getStats } from "../src/db/query";
import { runCrawler } from "../src/crawler";

// mock pi.dev 列表页（2 页）+ 2 个详情页
const LIST_P1 = `<div>1-1 / 2</div><a href="/packages?page=1">1</a><a href="/packages?page=2">2</a>
<article data-package-card="true" data-package-name="pkg-a" data-package-search="pkg-a alpha" data-package-types="extension" data-package-downloads="100" data-package-date="1000"></article>`;
const LIST_P2 = `<article data-package-card="true" data-package-name="pkg-b" data-package-search="pkg-b beta" data-package-types="theme" data-package-downloads="200" data-package-date="2000"></article>`;
const DETAIL = (n: string) => `<main id="readme"><p>${n} readme</p></main><dl><dt>Version</dt><dd>1.0</dd></dl>`;

beforeEach(() => {
  globalThis.fetch = mock((url: string) => {
    const u = String(url);
    const body = u.includes("page=2") ? LIST_P2
      : u.includes("page=1") || u.endsWith("/packages") ? LIST_P1
      : u.endsWith("/packages/pkg-a") ? DETAIL("pkg-a")
      : u.endsWith("/packages/pkg-b") ? DETAIL("pkg-b") : "";
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as any;
});

describe("crawler integration", () => {
  test("全量爬取入库 2 个包", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    await runCrawler(db, { full: true, dataDir: ":memory:" });
    const s = getStats(db);
    expect(s.total).toBe(2);
    expect(s.byType.extension).toBe(1);
    expect(s.byType.theme).toBe(1);
    db.close(false);
  }, 20000);
});
