import { describe, test, expect, mock, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/driver";
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
  test("外部中止：立即抛 AbortError 且不落盘", async () => {
    const db = openDatabase(":memory:");
    initSchema(db);
    // 预先中止的 signal：阶段 A 第一跳就失败，不发起任何网络请求
    await expect(
      runCrawler(db, { dataDir: ":memory:", silent: true, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(getStats(db).total).toBe(0);
  });
  test("全量爬取入库 2 个包", async () => {
    const db = openDatabase(":memory:");
    initSchema(db);
    await runCrawler(db, { full: true, dataDir: ":memory:", silent: true });
    const s = getStats(db);
    expect(s.total).toBe(2);
    expect(s.byType.extension).toBe(1);
    expect(s.byType.theme).toBe(1);
    db.close(false);
  }, 20000);
  test("增量模式自动补齐空描述，且爬过仍无描述的包被标记跳过", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pkg-desc-"));
    // meta：两包日期与列表一致 → diff 不产生更新，只走"补描述"分支
    fs.writeFileSync(path.join(dataDir, "meta.json"), JSON.stringify({ dateIndex: { "pkg-a": 1000, "pkg-b": 2000 } }));
    const db = openDatabase(":memory:");
    initSchema(db);
    db.exec(`INSERT INTO packages (name, description, types, archived) VALUES ('pkg-a', '', '["extension"]', 0)`);
    db.exec(`INSERT INTO packages (name, description, types, archived) VALUES ('pkg-b', 'has desc', '["theme"]', 0)`);

    // pkg-a 详情页带 content-description；pkg-b 本次不应被爬
    let detailCalls = 0;
    globalThis.fetch = mock((url: string) => {
      const u = String(url);
      const body = u.includes("page=2") ? LIST_P2
        : u.includes("page=1") || u.endsWith("/packages") ? LIST_P1
        : u.endsWith("/packages/pkg-a") ? (() => { detailCalls++; return `<p class="content-description">auto backfilled desc</p>`; })()
        : u.endsWith("/packages/pkg-b") ? (() => { detailCalls++; return "<dl></dl>"; })()
        : "";
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as any;

    // 第一轮增量：pkg-a（空描述）被自动补齐；pkg-b 有描述不碰
    await runCrawler(db, { dataDir, silent: true });
    const a = db.prepare("SELECT description, desc_attempted FROM packages WHERE name='pkg-a'").get() as any;
    expect(a.description).toBe("auto backfilled desc");
    expect(a.desc_attempted ?? 0).toBe(0);

    // 空描述且页面真没描述的包 → 标记 desc_attempted=1
    db.exec(`UPDATE packages SET description='', desc_attempted=NULL WHERE name='pkg-b'`);
    globalThis.fetch = mock((url: string) => {
      const u = String(url);
      const body = u.includes("page=2") ? LIST_P2
        : u.includes("page=1") || u.endsWith("/packages") ? LIST_P1
        : u.endsWith("/packages/pkg-a") ? "<dl></dl>"
        : u.endsWith("/packages/pkg-b") ? "<dl></dl>" : "";
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as any;
    await runCrawler(db, { dataDir, silent: true });
    const b = db.prepare("SELECT desc_attempted FROM packages WHERE name='pkg-b'").get() as any;
    expect(b.desc_attempted).toBe(1);

    // 第三轮：pkg-b 已标记 → 不再发起详情请求（detailCalls 不再增长）
    let callsBefore = detailCalls;
    globalThis.fetch = mock((url: string) => {
      const u = String(url);
      const body = u.includes("page=2") ? LIST_P2
        : u.includes("page=1") || u.endsWith("/packages") ? LIST_P1
        : u.includes("/packages/pkg-") ? (() => { detailCalls++; return "<dl></dl>"; })() : "";
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as any;
    await runCrawler(db, { dataDir, silent: true });
    expect(detailCalls).toBe(callsBefore);

    fs.rmSync(dataDir, { recursive: true, force: true });
    db.close(false);
  }, 20000);
});
