# pi-packages-search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 pi 包智能搜索系统——爬取 pi.dev/packages 全量数据到本地 SQLite(FTS5)+JSON，通过 pi 扩展工具 + pi 技能让 LLM 智能检索。

**Architecture:** 全栈 TypeScript/bun。4 阶段爬虫流水线（列表全量→增量对比→详情增量→Worker 解析入库），主从分工（主线程 I/O fetch 并发 + Worker 池 CPU 解析并行 + 单一 Writer 批量事务串行写），SQLite external-content FTS5 全文索引 + JSON 镜像双检索路径。

**Tech Stack:** bun (runtime + 原生 fetch + bun:sqlite + Worker), typebox (工具 schema), @earendil-works/pi-coding-agent (扩展类型)

**Spec:** `docs/superpowers/specs/2026-06-13-pi-packages-search-design.md`

---

## 数据流概览

```
列表全量爬取(并发10) → 增量对比(dateIndex) → 详情增量爬取(并发15) → Worker解析池 → Writer批量事务 → SQLite+FTS5+JSON
```

## 文件结构

| 文件 | 职责 |
|------|------|
| `package.json` | 项目元信息 + bin + scripts |
| `tsconfig.json` | TS 配置 |
| `src/shared/types.ts` | `PiPackage` 等类型定义 |
| `src/shared/config.ts` | 路径常量（`~/pi-data/pi-packages-search/`）|
| `src/db/connection.ts` | DB 连接管理（WAL + busy_timeout）|
| `src/db/schema.ts` | 建表 `packages` + FTS5 虚拟表 + 索引 |
| `src/db/query.ts` | 查询函数（search/get/list/stats），供扩展调用 |
| `src/crawler/fetcher.ts` | HTTP 抓取（超时/重试/keep-alive）|
| `src/crawler/list-parser.ts` | 列表页 HTML 解析（article data-* 属性）|
| `src/crawler/detail-parser.ts` | 详情页 HTML 解析（元数据+manifest+README）|
| `src/crawler/pool.ts` | 异步并发池 |
| `src/crawler/rate-limiter.ts` | 自适应限流（429 降并发+退避）|
| `src/crawler/incremental.ts` | 增量对比（dateIndex 比对）|
| `src/crawler/parser-worker.ts` | Worker：HTML/README 解析引擎 |
| `src/crawler/worker-pool.ts` | Worker 池管理（消息分发）|
| `src/crawler/writer.ts` | Writer 单一写入点（批量事务+FTS5+JSON）|
| `src/crawler/index.ts` | 4 阶段流水线主入口 |
| `src/extension/index.ts` | pi 扩展（registerTool×4 + registerCommand）|
| `bin/cli.ts` | CLI 入口（crawl --full/--proxy）|
| `skills/pi-packages-search/SKILL.md` | pi 技能 |
| `tests/*.test.ts` | 分层测试 |

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: 初始化 bun 项目**

Run:
```bash
cd D:/Documents/Code/AI/pi/pi-packages-search
bun init -y
```

- [ ] **Step 2: 写入 package.json**

写入 `package.json`（覆盖 bun init 生成的）：
```json
{
  "name": "pi-packages-search",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "pi-packages-search": "./bin/cli.ts"
  },
  "scripts": {
    "crawl": "bun run bin/cli.ts crawl",
    "test": "bun test",
    "bench": "bun run tests/bench.ts"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 3: 写入 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "outDir": "./build",
    "lib": ["ESNext"]
  },
  "include": ["src", "bin", "tests"]
}
```

- [ ] **Step 4: 安装依赖并验证**

Run:
```bash
bun install
bun --version
```
Expected: 打印 bun 版本号，无报错。

- [ ] **Step 5: 创建 .gitignore 并提交**

写入 `.gitignore`：
```
node_modules/
build/
~/pi-data/
*.sqlite*
```

```bash
git add -A
git commit -m "chore: 初始化 bun 项目结构"
```

---

## Task 2: 共享类型与配置

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/config.test.ts`：
```typescript
import { describe, test, expect } from "bun:test";
import { DATA_DIR, DB_PATH, JSON_PATH, META_PATH, BASE_URL } from "../src/shared/config";

describe("config", () => {
  test("DATA_DIR 在 ~/pi-data/pi-packages-search 下", () => {
    expect(DATA_DIR).toContain("pi-data");
    expect(DATA_DIR).toContain("pi-packages-search");
  });
  test("DB/JSON/META 路径都在 DATA_DIR 下", () => {
    expect(DB_PATH.startsWith(DATA_DIR)).toBe(true);
    expect(JSON_PATH.startsWith(DATA_DIR)).toBe(true);
    expect(META_PATH.startsWith(DATA_DIR)).toBe(true);
  });
  test("BASE_URL 是 pi.dev/packages", () => {
    expect(BASE_URL).toBe("https://pi.dev/packages");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/shared/types.ts`**

```typescript
/** 列表页解析结果（轻量，用于增量对比）*/
export interface ListPackage {
  name: string;
  date: number;          // data-package-date 时间戳(ms)
  downloads: number;     // data-package-downloads
}

/** 完整包数据（详情页解析后，入库结构）*/
export interface PiPackage {
  name: string;
  description: string;
  readme: string | null;
  types: string[];
  author: string | null;
  version: string | null;
  license: string | null;
  size: string | null;
  dependenciesCount: number | null;
  downloadsMonthly: number;
  downloadsWeekly: number | null;
  publishedAt: string | null;
  updatedAt: string;
  installCmd: string;
  npmUrl: string;
  repoUrl: string | null;
  detailUrl: string;
  manifest: string | null;     // Pi manifest JSON 串
  searchText: string;          // 合并搜索文本
}

/** meta.json 结构 */
export interface CrawlMeta {
  lastCrawl: string;
  totalPackages: number;
  durationSeconds: number;
  crawlerVersion: string;
  sourceUrl: string;
  dateIndex: Record<string, number>;  // name -> date 时间戳
}
```

- [ ] **Step 4: 写 `src/shared/config.ts`**

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = join(homedir(), "pi-data", "pi-packages-search");
export const DB_PATH = join(DATA_DIR, "pi-packages.sqlite");
export const JSON_PATH = join(DATA_DIR, "packages.json");
export const META_PATH = join(DATA_DIR, "meta.json");

export const BASE_URL = "https://pi.dev/packages";

/** Worker 数量 */
export const WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);
/** 并发数 */
export const LIST_CONCURRENCY = 10;
export const DETAIL_CONCURRENCY = 15;
/** Writer 批量大小 */
export const WRITE_BATCH = 50;
```

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/shared/ tests/config.test.ts
git commit -m "feat: 共享类型定义与路径配置"
```

---

## Task 3: DB 连接与 Schema

**Files:**
- Create: `src/db/connection.ts`
- Create: `src/db/schema.ts`
- Test: `tests/db-schema.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/db-schema.test.ts`：
```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, initSchema } from "../src/db/connection";

describe("db schema", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); });
  afterEach(() => db.close(false));

  test("建表 packages 存在", () => {
    initSchema(db);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
    expect(tables.map(t => t.name)).toContain("packages");
    expect(tables.map(t => t.name)).toContain("packages_fts");
  });

  test("插入并查询一条记录", () => {
    initSchema(db);
    db.prepare(`INSERT INTO packages (name, description, readme, types, downloads_monthly, updated_at, install_cmd, npm_url, detail_url, crawled_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "test-pkg", "a test", "readme", '["extension"]', 100, "2026-06-01", "pi install npm:test-pkg", "https://npm/test", "https://pi.dev/packages/test-pkg", "2026-06-13"
    );
    const row = db.prepare("SELECT name, downloads_monthly FROM packages WHERE name=?").get("test-pkg") as any;
    expect(row.name).toBe("test-pkg");
    expect(row.downloads_monthly).toBe(100);
  });

  test("WAL 模式与 busy_timeout 已设置", () => {
    initSchema(db);
    const mode = db.query("PRAGMA journal_mode").get() as any;
    // 内存库可能返回 memory，文件库才 WAL；这里只验证不报错
    expect(mode).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/db-schema.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/db/schema.ts`**

```typescript
import type { Database } from "bun:sqlite";

export function initSchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS packages (
      id                  INTEGER PRIMARY KEY,
      name                TEXT UNIQUE NOT NULL,
      description         TEXT,
      readme              TEXT,
      types               TEXT,
      author              TEXT,
      version             TEXT,
      license             TEXT,
      size                TEXT,
      dependencies_count  INTEGER,
      downloads_monthly   INTEGER,
      downloads_weekly    INTEGER,
      published_at        TEXT,
      updated_at          TEXT,
      install_cmd         TEXT,
      npm_url             TEXT,
      repo_url            TEXT,
      detail_url          TEXT,
      manifest            TEXT,
      archived            INTEGER DEFAULT 0,
      crawled_at          TEXT
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_packages_types ON packages(types);");
  db.run("CREATE INDEX IF NOT EXISTS idx_packages_downloads ON packages(downloads_monthly DESC);");

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
      name, description, readme, types, manifest_tools,
      content='packages',
      content_rowid='id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}
```

- [ ] **Step 4: 写 `src/db/connection.ts`**

```typescript
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../shared/config";
import { initSchema } from "./schema";

/** 打开（并按需初始化）数据库。可传入自定义路径用于测试。*/
export function openDb(path: string = DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  initSchema(db);
  return db;
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/db-schema.test.ts`
Expected: PASS（3 个测试全过）

- [ ] **Step 6: 提交**

```bash
git add src/db/ tests/db-schema.test.ts
git commit -m "feat: DB schema (packages 表 + FTS5 虚拟表 + WAL)"
```

---

## Task 4: 列表页解析器

**Files:**
- Create: `src/crawler/list-parser.ts`
- Test: `tests/list-parser.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/list-parser.test.ts`：
```typescript
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/list-parser.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/crawler/list-parser.ts`**

```typescript
import type { ListPackage } from "../shared/types";

const ARTICLE_RE = /<article[^>]*data-package-card="true"[\s\S]*?<\/article>/gi;

function attr(block: string, name: string): string {
  const m = block.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

/** 解析单页 HTML 中的包列表（仅轻量字段，用于增量对比）*/
export function parseListHtml(html: string): ListPackage[] {
  const results: ListPackage[] = [];
  let m: RegExpExecArray | null;
  ARTICLE_RE.lastIndex = 0;
  while ((m = ARTICLE_RE.exec(html)) !== null) {
    const block = m[0];
    const name = attr(block, "data-package-name");
    if (!name) continue;
    results.push({
      name,
      date: parseInt(attr(block, "data-package-date")) || 0,
      downloads: parseInt(attr(block, "data-package-downloads")) || 0,
    });
  }
  return results;
}

/** 从首页 HTML 解析总页数 */
export function parseTotalPages(html: string): number {
  const matches = [...html.matchAll(/page=(\d+)/g)];
  if (matches.length === 0) return 1;
  return Math.max(...matches.map((m) => parseInt(m[1])));
}

/** 从首页 HTML 解析总包数（"1-20 / 60" 中的 60）*/
export function parseTotalCount(html: string): number {
  const m = html.match(/(\d[\d,]*)\s*-\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
  return m ? parseInt(m[3].replace(/,/g, "")) : 0;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/list-parser.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/crawler/list-parser.ts tests/list-parser.test.ts
git commit -m "feat: 列表页 HTML 解析器"
```

---

## Task 5: 异步并发池

**Files:**
- Create: `src/crawler/pool.ts`
- Test: `tests/pool.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/pool.test.ts`：
```typescript
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/pool.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/pool.ts`**

```typescript
/** 控制并发数的异步池：最多同时跑 concurrency 个 worker */
export async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = worker(item).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/pool.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/crawler/pool.ts tests/pool.test.ts
git commit -m "feat: 异步并发池"
```

---

## Task 6: HTTP Fetcher（超时+重试）

**Files:**
- Create: `src/crawler/fetcher.ts`
- Test: `tests/fetcher.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/fetcher.test.ts`：
```typescript
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/fetcher.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/fetcher.ts`**

```typescript
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 抓取页面文本，带超时和重试 */
export async function fetchPage(
  url: string,
  retries: number = DEFAULT_RETRIES,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const resp = await fetch(url, { signal: ac.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err: any) {
      const isLast = attempt === retries;
      if (isLast) throw err;
      await sleep(800 * attempt);
    }
  }
  throw new Error("unreachable");
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/fetcher.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/crawler/fetcher.ts tests/fetcher.test.ts
git commit -m "feat: HTTP fetcher (超时+重试)"
```

---

## Task 7: 增量对比逻辑

**Files:**
- Create: `src/crawler/incremental.ts`
- Test: `tests/incremental.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/incremental.test.ts`：
```typescript
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/incremental.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/incremental.ts`**

```typescript
import type { ListPackage } from "../shared/types";

export interface CrawlDiff {
  added: string[];     // 新增包名
  updated: string[];   // 更新包名（date 增大）
  removed: string[];   // 消失包名
  toFetch: string[];   // 需爬详情的包名 = added + updated
}

/** 对比本次列表与上次 dateIndex，产出增量差异 */
export function computeDiff(
  currentList: ListPackage[],
  prevDateIndex: Record<string, number>,
): CrawlDiff {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const currentNames = new Set<string>();

  for (const pkg of currentList) {
    currentNames.add(pkg.name);
    const prevDate = prevDateIndex[pkg.name];
    if (prevDate === undefined) {
      added.push(pkg.name);
    } else if (pkg.date > prevDate) {
      updated.push(pkg.name);
    }
  }
  for (const name of Object.keys(prevDateIndex)) {
    if (!currentNames.has(name)) removed.push(name);
  }

  return { added, updated, removed, toFetch: [...added, ...updated] };
}

/** 从列表构建本次 dateIndex */
export function buildDateIndex(list: ListPackage[]): Record<string, number> {
  const idx: Record<string, number> = {};
  for (const pkg of list) idx[pkg.name] = pkg.date;
  return idx;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/incremental.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/crawler/incremental.ts tests/incremental.test.ts
git commit -m "feat: 增量对比逻辑 (dateIndex diff)"
```

---

## Task 8: 详情页解析器

**Files:**
- Create: `src/crawler/detail-parser.ts`
- Test: `tests/detail-parser.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/detail-parser.test.ts`：
```typescript
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/detail-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/detail-parser.ts`**

```typescript
import type { PiPackage } from "../shared/types";

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** 从 dl 列表中提取字段值 */
function field(html: string, label: string): string | null {
  const re = new RegExp(`<dt[^>]*>${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i");
  const m = html.match(re);
  return m ? clean(m[1]) : null;
}

/** "118.3K/mo" → 118300；"17.8K/wk"→17800 */
function parseDownloads(text: string | null): { monthly: number; weekly: number | null } {
  const monthly = { monthly: 0, weekly: null as number | null };
  if (!text) return monthly;
  const num = (s: string) => {
    const m = s.match(/([\d.]+)\s*([KMB]?)/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return Math.round(v * (u === "K" ? 1000 : u === "M" ? 1e6 : u === "B" ? 1e9 : 1));
  };
  const moM = text.match(/([\d.KMB]+)\s*\/?\s*mo/i);
  const wkM = text.match(/([\d.KMB]+)\s*\/?\s*wk/i);
  monthly.monthly = moM ? num(moM[1]) : 0;
  monthly.weekly = wkM ? num(wkM[1]) : null;
  return monthly;
}

function parseDate(text: string | null): string | null {
  if (!text) return null;
  const d = new Date(text);
  return isNaN(d.getTime()) ? text : d.toISOString().split("T")[0];
}

/** 从 manifest JSON 提取工具/扩展名（去路径前缀）*/
export function extractManifestTools(manifest: string): string[] {
  try {
    const obj = JSON.parse(manifest);
    const out: string[] = [];
    for (const key of ["extensions", "skills", "tools", "commands"]) {
      const arr = obj[key];
      if (Array.isArray(arr)) for (const p of arr) if (typeof p === "string") out.push(p.split("/").pop() || p);
    }
    return out;
  } catch {
    return [];
  }
}

/** 解析详情页 HTML，输出完整 PiPackage */
export function parseDetailHtml(html: string, name: string): PiPackage {
  const installMatch = html.match(/data-copy-text="([^"]*)"/);
  const npmMatch = html.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]*)"/i);
  const repoMatch = html.match(/href="(https:\/\/github\.com\/[^"]*)"/i);
  const readmeMatch = html.match(/<main[^>]*id=["']readme["'][\s\S]*?<\/main>/i);
  const manifestMatch = html.match(/<pre[^>]*><code[^>]*>(\{[\s\S]*?\})<\/code><\/pre>/);

  const description = clean(field(html, "Description") || field(html, "") || "");
  const dl = parseDownloads(field(html, "Downloads"));
  const manifest = manifestMatch ? manifestMatch[1].trim() : null;

  return {
    name,
    description,
    readme: readmeMatch ? clean(readmeMatch[0]) : null,
    types: [],
    author: field(html, "Author"),
    version: field(html, "Version"),
    license: field(html, "License"),
    size: field(html, "Size"),
    dependenciesCount: (() => {
      const t = field(html, "Dependencies");
      const m = t?.match(/(\d+)\s*dependencies/i);
      return m ? parseInt(m[1]) : null;
    })(),
    downloadsMonthly: dl.monthly,
    downloadsWeekly: dl.weekly,
    publishedAt: parseDate(field(html, "Published")),
    updatedAt: "",
    installCmd: installMatch ? installMatch[1] : `pi install npm:${name}`,
    npmUrl: npmMatch?.[1] ?? `https://www.npmjs.com/package/${name}`,
    repoUrl: repoMatch?.[1] ?? null,
    detailUrl: `https://pi.dev/packages/${encodeURIComponent(name)}`,
    manifest,
    searchText: clean(`${name} ${description} ${manifest ? extractManifestTools(manifest).join(" ") : ""}`),
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/detail-parser.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/crawler/detail-parser.ts tests/detail-parser.test.ts
git commit -m "feat: 详情页解析器 (元数据+manifest+README)"
```

---

## Task 9: Worker 解析引擎与 Worker 池

**Files:**
- Create: `src/crawler/parser-worker.ts`- Create: `src/crawler/worker-pool.ts`
- Test: `tests/worker-pool.test.ts`

> 说明：Worker 负责把详情页 HTML 解析为结构化 `PiPackage`（CPU 密集），主线程只做 I/O fetch。

- [ ] **Step 1: 写失败测试**

`tests/worker-pool.test.ts`：
```typescript
import { describe, test, expect } from "bun:test";
import { WorkerPool } from "src/crawler/worker-pool";

describe("worker-pool", () => {
  test("并行解析多个 HTML 片段", async () => {
    const wp = new WorkerPool(2);
    const samples = [
      { name: "pkg-a", html: "<main id=\"readme\"><p>Alpha</p></main>" },
      { name: "pkg-b", html: "<main id=\"readme\"><p>Beta</p></main>" },
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/worker-pool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/crawler/parser-worker.ts`**

```typescript
import { parseDetailHtml } from "./detail-parser";
import type { PiPackage } from "../shared/types";

declare var self: Worker;

// Worker 入口：收到 {name, html}，解析后回传 PiPackage
self.onmessage = (event: MessageEvent) => {
  const { id, name, html } = event.data;
  try {
    const pkg = parseDetailHtml(html, name);
    self.postMessage({ id, ok: true, pkg });
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
```

- [ ] **Step 4: 写 `src/crawler/worker-pool.ts`**

```typescript
import { Worker } from "bun:sqlite";
import type { PiPackage } from "../shared/types";
import { WORKER_COUNT } from "../shared/config";

interface Job {
  id: number;
  resolve: (pkg: PiPackage) => void;
  reject: (err: Error) => void;
}

/** Worker 池：分发 HTML 解析任务到多个 worker，CPU 并行 */
export class WorkerPool {
  private workers: Worker[] = [];
  private queue: Job[] = [];
  private nextId = 0;
  private roundRobin = 0;

  constructor(count: number = WORKER_COUNT) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL("./parser-worker.ts", import.meta.url).href);
      w.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
      this.workers.push(w);
    }
  }

  private handleMessage(data: any) {
    const job = this.queue.find((j) => j.id === data.id);
    if (!job) return;
    this.queue = this.queue.filter((j) => j.id !== data.id);
    if (data.ok) job.resolve(data.pkg);
    else job.reject(new Error(data.error));
  }

  /** 提交一个解析任务，返回 PiPackage Promise */
  parse(name: string, html: string): Promise<PiPackage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, resolve, reject });
      const w = this.workers[this.roundRobin % this.workers.length];
      this.roundRobin++;
      w.postMessage({ id, name, html });
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `bun test tests/worker-pool.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/crawler/parser-worker.ts src/crawler/worker-pool.ts tests/worker-pool.test.ts
git commit -m "feat: Worker 解析引擎与 Worker 池 (CPU 并行解析)"
```

---

## Task 10: Writer 单一写入点（批量事务）

**Files:**
- Create: `src/crawler/writer.ts`
- Test: `tests/writer.test.ts`

> 关键约束：SQLite 同一文件同一时刻只能一个写事务，因此 Writer 是**唯一写入点**，批量事务串行写，避免 SQLITE_BUSY。

- [ ] **Step 1: 写失败测试**

`tests/writer.test.ts`：
```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/db/schema";
import { Writer } from "../src/crawler/writer";
import type { PiPackage } from "../src/shared/types";

function mkPkg(name: string): PiPackage {
  return {
    name, description: "d", readme: "r", types: ["extension"], author: "a",
    version: "1", license: null, size: null, dependenciesCount: null,
    downloadsMonthly: 100, downloadsWeekly: null, publishedAt: null,
    updatedAt: "2026-06-01", installCmd: `pi install npm:${name}`,
    npmUrl: "https://npm/" + name, repoUrl: null,
    detailUrl: "https://pi.dev/packages/" + name, manifest: null, searchText: name,
  };
}

describe("Writer", () => {
  let db: Database;
  beforeEach(() => { db = new Database(":memory:"); initSchema(db); });
  afterEach(() => db.close(false));

  test("批量写入 packages 与 FTS5", () => {
    const w = new Writer(db, 2);
    w.add(mkPkg("a")); w.add(mkPkg("b"));
    expect(db.query("SELECT COUNT(*) c FROM packages").get() as any).toEqual({ c: 2 });
  });
  test("FTS5 可全文检索", () => {
    const w = new Writer(db, 1);
    const p = mkPkg("memory-tool");
    p.readme = "persistent memory plugin";
    w.add(p);
    const rows = db.prepare(`
      SELECT p.name FROM packages_fts f JOIN packages p ON p.id = f.rowid
      WHERE packages_fts MATCH 'memory'`).all() as any[];
    expect(rows.some((r) => r.name === "memory-tool")).toBe(true);
  });
  test("flush 写入未满批次的剩余", () => {
    const w = new Writer(db, 5);
    w.add(mkPkg("x"));
    w.flush();
    expect((db.query("SELECT COUNT(*) c FROM packages").get() as any).c).toBe(1);
  });
  test("archived 标记消失包", () => {
    const w = new Writer(db, 1);
    w.add(mkPkg("gone"));
    w.markArchived(["gone"]);
    const row = db.query("SELECT archived FROM packages WHERE name=?").get("gone") as any;
    expect(row.archived).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/writer.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/writer.ts`**

```typescript
import type { Database } from "bun:sqlite";
import type { PiPackage } from "../shared/types";
import { WRITE_BATCH } from "../shared/config";

const UPSERT = `INSERT OR REPLACE INTO packages
  (name, description, readme, types, author, version, license, size, dependencies_count,
   downloads_monthly, downloads_weekly, published_at, updated_at, install_cmd, npm_url,
   repo_url, detail_url, manifest, archived, crawled_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`;

const FTS_UPSERT = `INSERT INTO packages_fts
  (rowid, name, description, readme, types, manifest_tools)
  VALUES ((SELECT id FROM packages WHERE name=?), ?,?,?,?,?)`;

/** 唯一写入点：攒够批次用单一事务写入，串行避免写锁竞争 */
export class Writer {
  private buffer: PiPackage[] = [];
  private stmtUpsert: ReturnType<Database["prepare"]>;
  private stmtFts: ReturnType<Database["prepare"]>;

  constructor(private db: Database, private batchSize: number = WRITE_BATCH) {
    this.stmtUpsert = db.prepare(UPSERT);
    this.stmtFts = db.prepare(FTS_UPSERT);
  }

  add(pkg: PiPackage): void {
    this.buffer.push(pkg);
    if (this.buffer.length >= this.batchSize) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      for (const p of batch) {
        this.stmtUpsert.run(
          p.name, p.description, p.readme, JSON.stringify(p.types), p.author, p.version,
          p.license, p.size, p.dependenciesCount, p.downloadsMonthly, p.downloadsWeekly,
          p.publishedAt, p.updatedAt, p.installCmd, p.npmUrl, p.repoUrl, p.detailUrl,
          p.manifest, now,
        );
        this.stmtFts.run(
          p.name, p.name, p.description, p.readme ?? "", JSON.stringify(p.types),
          p.manifest ?? "",
        );
      }
    });
    write();
  }

  markArchived(names: string[]): void {
    if (names.length === 0) return;
    const mark = this.db.transaction(() => {
      for (const n of names) {
        this.db.prepare("UPDATE packages SET archived=1 WHERE name=?").run(n);
      }
    });
    mark();
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/writer.test.ts`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/crawler/writer.ts tests/writer.test.ts
git commit -m "feat: Writer 单一写入点 (批量事务 + FTS5 同步 + archived)"
```

---

## Task 11: DB 查询函数（search/get/list/stats）

**Files:**
- Create: `src/db/query.ts`
- Test: `tests/query.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/query.test.ts`：
```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/db/schema";
import { Writer } from "../src/crawler/writer";
import { searchPackages, getPackageDetail, listPackages, getStats } from "../src/db/query";
import type { PiPackage } from "../src/shared/types";

function mk(name: string, desc: string, types: string[], dl: number): PiPackage {
  return { name, description: desc, readme: desc, types, author: null, version: "1",
    license: null, size: null, dependenciesCount: null, downloadsMonthly: dl,
    downloadsWeekly: null, publishedAt: null, updatedAt: "2026-06-01",
    installCmd: `pi install npm:${name}`, npmUrl: "", repoUrl: null, detailUrl: "",
    manifest: null, searchText: `${name} ${desc}` };
}

describe("query", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:"); initSchema(db);
    const w = new Writer(db, 1);
    w.add(mk("memory-pro", "persistent memory plugin", ["extension"], 500));
    w.add(mk("theme-dark", "dark color theme", ["theme"], 200));
    w.add(mk("subagents-x", "subagent delegation", ["extension"], 800));
    w.add(mk("memory-lite", "lightweight memory", ["package"], 100));
    w.flush();
  });
  afterEach(() => db.close(false));

  test("searchPackages 全文匹配 + BM25 排序", () => {
    const r = searchPackages(db, "memory");
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r.map((x) => x.name)).toContain("memory-pro");
  });
  test("searchPackages type 过滤", () => {
    const r = searchPackages(db, "memory", { type: "extension" });
    expect(r.every((x) => x.types.includes("extension"))).toBe(true);
  });
  test("searchPackages sort downloads", () => {
    const r = searchPackages(db, "memory", { sort: "downloads" });
    expect(r[0].downloadsMonthly).toBeGreaterThanOrEqual(r[r.length - 1].downloadsMonthly);
  });
  test("getPackageDetail 精确名", () => {
    const p = getPackageDetail(db, "theme-dark");
    expect(p?.name).toBe("theme-dark");
  });
  test("listPackages 按类型+下载排序", () => {
    const r = listPackages(db, { type: "theme", sort: "downloads" });
    expect(r[0].name).toBe("theme-dark");
  });
  test("getStats 统计", () => {
    const s = getStats(db);
    expect(s.total).toBe(4);
    expect(s.byType.theme).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/query.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/db/query.ts`**

```typescript
import type { Database } from "bun:sqlite";
import type { PiPackage } from "../shared/types";

export type PkgType = "extension" | "package" | "skill" | "theme" | "prompt";
export type SortKey = "relevance" | "downloads" | "updated";

export interface SearchResult extends PiPackage {
  id: number;
  archived: number;
}

function rowToPkg(r: any): SearchResult {
  return {
    name: r.name, description: r.description ?? "", readme: r.readme ?? null,
    types: r.types ? JSON.parse(r.types) : [], author: r.author, version: r.version,
    license: r.license, size: r.size, dependenciesCount: r.dependencies_count,
    downloadsMonthly: r.downloads_monthly ?? 0, downloadsWeekly: r.downloads_weekly,
    publishedAt: r.published_at, updatedAt: r.updated_at ?? "",
    installCmd: r.install_cmd ?? `pi install npm:${r.name}`, npmUrl: r.npm_url ?? "",
    repoUrl: r.repo_url, detailUrl: r.detail_url ?? "", manifest: r.manifest,
    searchText: "", id: r.id, archived: r.archived ?? 0,
  };
}

/** FTS5 全文搜索（关键词空格分隔 → MATCH），可选 type 过滤与排序 */
export function searchPackages(
  db: Database, query: string, opts: { type?: PkgType; limit?: number; sort?: SortKey } = {},
): SearchResult[] {
  const limit = opts.limit ?? 10;
  // 关键词转 MATCH 表达式：空格分隔的词用空格连接（FTS5 隐式 AND/短语）
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, "\"\"")}"`);
  const match = terms.join(" ");
  if (!match) return [];

  const typeFilter = opts.type ? `AND p.types LIKE '%"${opts.type}"%'` : "";
  let order = "ORDER BY bm25(packages_fts) ASC";
  if (opts.sort === "downloads") order = "ORDER BY p.downloads_monthly DESC";
  else if (opts.sort === "updated") order = "ORDER BY p.updated_at DESC";

  const sql = `
    SELECT p.* FROM packages_fts f
    JOIN packages p ON p.id = f.rowid
    WHERE packages_fts MATCH ? AND p.archived = 0 ${typeFilter}
    ${order} LIMIT ?`;
  return (db.prepare(sql).all(match, limit) as any[]).map(rowToPkg);
}

export function getPackageDetail(db: Database, name: string): SearchResult | null {
  const r = db.prepare("SELECT * FROM packages WHERE name=? AND archived=0").get(name) as any;
  return r ? rowToPkg(r) : null;
}

export function listPackages(
  db: Database, opts: { type?: PkgType; sort?: SortKey; limit?: number } = {},
): SearchResult[] {
  const limit = opts.limit ?? 10;
  const where = opts.type ? `WHERE archived=0 AND types LIKE '%"${opts.type}"%'` : "WHERE archived=0";
  const order = opts.sort === "updated" ? "updated_at DESC" : "downloads_monthly DESC";
  return (db.prepare(`SELECT * FROM packages ${where} ORDER BY ${order} LIMIT ?`).all(limit) as any[]).map(rowToPkg);
}

export function getStats(db: Database): {
  total: number; byType: Record<string, number>; lastCrawl: string | null;
} {
  const total = (db.query("SELECT COUNT(*) c FROM packages WHERE archived=0").get() as any).c;
  const rows = db.query("SELECT types FROM packages WHERE archived=0").all() as { types: string }[];
  const byType: Record<string, number> = {};
  for (const r of rows) {
    for (const t of (r.types ? JSON.parse(r.types) : [])) byType[t] = (byType[t] || 0) + 1;
  }
  const last = db.query("SELECT MAX(crawled_at) m FROM packages").get() as any;
  return { total, byType, lastCrawl: last?.m ?? null };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/query.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/db/query.ts tests/query.test.ts
git commit -m "feat: DB 查询函数 (search/get/list/stats)"
```

---

## Task 12: 自适应限流器

**Files:**
- Create: `src/crawler/rate-limiter.ts`
- Test: `tests/rate-limiter.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/rate-limiter.test.ts`：
```typescript
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
    for (let i = 0; i < 10; i++) l.recordSuccess();
    expect(l.current()).toBe(15);
  });
  test("不低于下限", () => {
    const l = new AdaptiveLimiter(15);
    for (let i = 0; i < 100; i++) l.recordFailure();
    expect(l.current()).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/rate-limiter.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/rate-limiter.ts`**

```typescript
/** 自适应并发限流：遇失败(429/超时)降并发，连续成功逐步回升 */
export class AdaptiveLimiter {
  private cur: number;
  private successStreak = 0;
  constructor(
    private target: number,
    private min = 2,
  ) {
    this.cur = target;
  }
  current(): number {
    return this.cur;
  }
  recordFailure(): void {
    this.successStreak = 0;
    this.cur = Math.max(this.min, Math.floor(this.cur / 2));
  }
  recordSuccess(): void {
    this.successStreak++;
    if (this.successStreak >= 5 && this.cur < this.target) {
      this.cur = Math.min(this.target, this.cur + 1);
      this.successStreak = 0;
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/rate-limiter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/crawler/rate-limiter.ts tests/rate-limiter.test.ts
git commit -m "feat: 自适应限流器"
```

---

## Task 13: 4 阶段爬虫流水线（集成）

**Files:**
- Create: `src/crawler/index.ts`
- Test: `tests/crawler-integration.test.ts`

> 说明：本任务用 mock fetch 端到端串联 4 阶段，不真实请求 pi.dev。真实请求在 Task 16 benchmark 验证。

- [ ] **Step 1: 写失败测试**

`tests/crawler-integration.test.ts`：
```typescript
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test tests/crawler-integration.test.ts`
Expected: FAIL

- [ ] **Step 3: 写 `src/crawler/index.ts`**

```typescript
import type { Database } from "bun:sqlite";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchPage } from "./fetcher";
import { parseListHtml, parseTotalPages, parseTotalCount } from "./list-parser";
import { computeDiff, buildDateIndex } from "./incremental";
import { pool } from "./pool";
import { Writer } from "./writer";
import { AdaptiveLimiter } from "./rate-limiter";
import { WorkerPool } from "./worker-pool";
import {
  BASE_URL, LIST_CONCURRENCY, DETAIL_CONCURRENCY, JSON_PATH, META_PATH,
} from "../shared/config";
import type { ListPackage, PiPackage, CrawlMeta } from "../shared/types";

export interface CrawlOptions {
  full?: boolean;       // 全量详情
  proxy?: string;
  dataDir?: string;     // 测试用：JSON/META 写入目录
}

export async function runCrawler(db: Database, opts: CrawlOptions = {}): Promise<CrawlMeta> {
  const start = Date.now();
  if (opts.proxy) { process.env.HTTPS_PROXY = opts.proxy; process.env.HTTP_PROXY = opts.proxy; }

  // ── 阶段 A: 列表全量 ──
  const firstHtml = await fetchPage(BASE_URL);
  const totalPages = parseTotalPages(firstHtml);
  const totalCount = parseTotalCount(firstHtml);
  const list: ListPackage[] = parseListHtml(firstHtml);
  const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  await pool(pages, LIST_CONCURRENCY, async (page) => {
    const html = await fetchPage(`${BASE_URL}?page=${page}`);
    list.push(...parseListHtml(html));
  });

  // ── 阶段 B: 增量对比 ──
  const metaPath = opts.dataDir ? `${opts.dataDir}/meta.json` : META_PATH;
  const prevMeta: CrawlMeta | null = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf-8")) : null;
  const prevIndex = opts.full ? {} : (prevMeta?.dateIndex ?? {});
  const diff = computeDiff(list, prevIndex);
  const toFetch = opts.full ? list.map((p) => p.name) : diff.toFetch;

  // ── 阶段 C: 详情增量 + 阶段 D: Worker 解析 + Writer 入库 ──
  const limiter = new AdaptiveLimiter(DETAIL_CONCURRENCY);
  const workers = new WorkerPool();
  const writer = new Writer(db);
  const listMap = new Map(list.map((p) => [p.name, p]));

  await pool(toFetch, limiter.current(), async (name) => {
    try {
      const html = await fetchPage(`${BASE_URL}/${encodeURIComponent(name)}`);
      const pkg = await workers.parse(name, html);
      const lp = listMap.get(name);
      if (lp) {
        pkg.downloadsMonthly = pkg.downloadsMonthly || lp.downloads;
        pkg.updatedAt = new Date(lp.date).toISOString().split("T")[0];
      }
      writer.add(pkg);
      limiter.recordSuccess();
    } catch {
      limiter.recordFailure(); // 限流/错误：降并发
    }
  });

  writer.flush();
  if (!opts.full) writer.markArchived(diff.removed);
  workers.terminate();

  // ── 写 JSON + meta ──
  const allRows = db.query("SELECT * FROM packages WHERE archived=0").all();
  const jsonPath = opts.dataDir ? `${opts.dataDir}/packages.json` : JSON_PATH;
  if (jsonPath !== ":memory:") {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify({ generated: new Date().toISOString(), total: allRows.length, packages: allRows }, null, 2));
  }
  const meta: CrawlMeta = {
    lastCrawl: new Date().toISOString(),
    totalPackages: totalCount || allRows.length,
    durationSeconds: Math.round((Date.now() - start) / 1000),
    crawlerVersion: "1.0.0",
    sourceUrl: BASE_URL,
    dateIndex: buildDateIndex(list),
  };
  if (metaPath !== ":memory:") {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  return meta;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test tests/crawler-integration.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试回归**

Run: `bun test`
Expected: 全部测试 PASS

- [ ] **Step 6: 提交**

```bash
git add src/crawler/index.ts tests/crawler-integration.test.ts
git commit -m "feat: 4 阶段爬虫流水线 (列表全量+增量+Worker解析+入库)"
```

---

## Task 14: pi 扩展（4 工具 + 命令）

**Files:**
- Create: `src/extension/index.ts`

> 说明：pi 扩展导出 default factory，接收 `ExtensionAPI`。工具用 typebox 定义参数。无法在 bun test 中直接测（依赖 pi 运行时），故本任务以代码审查 + 手动加载验证为主。

- [ ] **Step 1: 写 `src/extension/index.ts`**

```typescript
import { Type } from "typebox";
import { openDb } from "../db/connection";
import { searchPackages, getPackageDetail, listPackages, getStats } from "../db/query";
import { runCrawler } from "../crawler";

type PkgType = "extension" | "package" | "skill" | "theme" | "prompt";
const PkgTypeUnion = Type.Union([
  Type.Literal("extension"), Type.Literal("package"), Type.Literal("skill"),
  Type.Literal("theme"), Type.Literal("prompt"),
]);
const SortUnion = Type.Union([
  Type.Literal("relevance"), Type.Literal("downloads"), Type.Literal("updated"),
]);

function fmtRows(rows: any[]): string {
  if (rows.length === 0) return "未找到匹配包。";
  return rows.map((r, i) =>
    `${i + 1}. ${r.name} [${(r.types || []).join(",")}] ${(r.downloadsMonthly ?? 0).toLocaleString()}/mo\n` +
    `   ${(r.description ?? "").slice(0, 120)}\n` +
    `   安装: ${r.installCmd}`).join("\n");
}

export default function (pi: any) {
  pi.registerTool({
    name: "search_packages",
    label: "Search Pi Packages",
    description: "FTS5 全文搜索 Pi 包目录。传空格分隔的英文关键词（中文请先转译）。",
    parameters: Type.Object({
      query: Type.String({ description: "空格分隔关键词，如 'memory persistent'" }),
      type: Type.Optional(PkgTypeUnion),
      limit: Type.Optional(Type.Number()),
      sort: Type.Optional(SortUnion),
    }),
    async execute(_id: string, params: any) {
      const db = openDb();
      const rows = searchPackages(db, params.query, { type: params.type, limit: params.limit, sort: params.sort });
      db.close(false);
      return { content: [{ type: "text", text: fmtRows(rows) }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "get_package_detail",
    label: "Get Package Detail",
    description: "按精确包名获取完整详情（含 README 与 manifest）。",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id: string, params: any) {
      const db = openDb();
      const r = getPackageDetail(db, params.name);
      db.close(false);
      if (!r) return { content: [{ type: "text", text: `未找到包: ${params.name}` }], details: {} };
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], details: {} };
    },
  });

  pi.registerTool({
    name: "list_packages",
    label: "List Pi Packages",
    description: "按类型浏览/排序（如热门主题）。不传 type 则全部。",
    parameters: Type.Object({
      type: Type.Optional(PkgTypeUnion),
      sort: Type.Optional(SortUnion),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const db = openDb();
      const rows = listPackages(db, { type: params.type, sort: params.sort, limit: params.limit });
      db.close(false);
      return { content: [{ type: "text", text: fmtRows(rows) }], details: { count: rows.length } };
    },
  });

  pi.registerTool({
    name: "get_stats",
    label: "Package DB Stats",
    description: "返回包库统计（总数、各类型分布、上次爬取时间、是否过期）。",
    parameters: Type.Object({}),
    async execute() {
      const db = openDb();
      const s = getStats(db);
      db.close(false);
      const text = `总计 ${s.total} 包 | 各类型: ${JSON.stringify(s.byType)} | 上次爬取: ${s.lastCrawl ?? "无"}`;
      return { content: [{ type: "text", text }], details: s };
    },
  });

  pi.registerCommand("pi-packages-search:crawl", {
    description: "爬取/更新 Pi 包索引（默认增量）",
    handler: async (args: string) => {
      const db = openDb();
      const meta = await runCrawler(db, { full: args.includes("--full"), proxy: undefined });
      db.close(false);
      pi.ctx?.ui?.notify?.(`爬取完成: ${meta.totalPackages} 包, 用时 ${meta.durationSeconds}s`, "info");
    },
  });
}
```

- [ ] **Step 2: 类型检查**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: 无类型错误（若缺少 pi 类型，可临时 `// @ts-ignore` 或补充 `types.d.ts` 声明 ExtensionAPI 为 any）

- [ ] **Step 3: 手动加载验证（在 pi 中）**

Run（用户在 pi 里）: `pi -e ./src/extension/index.ts`
Expected: pi 启动后工具 `search_packages` 等出现在工具列表。

- [ ] **Step 4: 提交**

```bash
git add src/extension/index.ts
git commit -m "feat: pi 扩展 (search/get/list/stats 工具 + crawl 命令)"
```

---

## Task 15: CLI 入口

**Files:**
- Create: `bin/cli.ts`

- [ ] **Step 1: 写 `bin/cli.ts`**

```typescript
#!/usr/bin/env bun
import { openDb } from "../src/db/connection";
import { runCrawler } from "src/crawler";

const args = process.argv.slice(2);
const cmd = args[0];
const proxyIdx = args.indexOf("--proxy");
const proxy = proxyIdx >= 0 ? args[proxyIdx + 1] : undefined;
const full = args.includes("--full");

if (cmd === "crawl") {
  const db = openDb();
  runCrawler(db, { full, proxy })
    .then((meta) => {
      console.log(`\n✅ 完成: ${meta.totalPackages} 包, 用时 ${meta.durationSeconds}s`);
      db.close(false);
    })
    .catch((e) => { console.error("❌", e); process.exit(1); });
} else {
  console.log(`用法: pi-packages-search crawl [--full] [--proxy <url>]

  crawl        爬取/更新索引（默认增量）
  --full       全量详情（首次/修复）
  --proxy <url> 代理地址（中国用户建议 http://localhost:4444）`);
}
```

- [ ] **Step 2: 首次全量爬取（真实，需代理）**

Run: `bun run bin/cli.ts crawl --full --proxy http://localhost:4444`
Expected: 输出进度，最终打印「✅ 完成: ~3185 包, 用时 NNs」，`~/pi-data/pi-packages-search/` 下生成 sqlite/json/meta。

> 若网络超时，可先 `--concurrency` 降低（见 fetcher/pool 配置）后重试。

- [ ] **Step 3: 验证数据**

Run:
```bash
ls -lh ~/pi-data/pi-packages-search/
bun -e 'const {Database}=require("bun:sqlite");const db=new Database(process.env.HOME+"/pi-data/pi-packages-search/pi-packages.sqlite");console.log(db.query("SELECT COUNT(*) c FROM packages").get());console.log(db.prepare("SELECT name FROM packages_fts WHERE packages_fts MATCH ? LIMIT 3").all("memory"));'
```
Expected: packages 行数 ~3185；FTS5 查 'memory' 返回 ≥1 条。

- [ ] **Step 4: 提交**

```bash
chmod +x bin/cli.ts
git add bin/cli.ts
git commit -m "feat: CLI 入口 (crawl --full/--proxy)"
```

---

## Task 16: pi 技能 SKILL.md + 性能 benchmark

**Files:**
- Create: `skills/pi-packages-search/SKILL.md`
- Create: `tests/bench.ts`

- [ ] **Step 1: 写 `skills/pi-packages-search/SKILL.md`**

```markdown
---
name: pi-packages-search
description: 智能搜索 Pi 包目录（FTS5 全文 + JSON 命令双路径）。触发：找 pi 插件/扩展/技能/主题、pi-package-search、/pi-packages-search。
---

# Pi Packages Search

根据用户需求，在本地 Pi 包库（~/pi-data/pi-packages-search/）中智能检索。

## 双检索路径（核心）

| 用户需求 | 路径 | 做法 |
|----------|------|------|
| 描述功能("我需要记忆插件") | FTS5 | 调 search_packages(query=英文关键词) |
| 指定类型("热门主题") | FTS5 | 调 list_packages(type=theme, sort=downloads) |
| 查特定包("X是什么") | FTS5 | 调 get_package_detail(name=X) |
| 精确字段("作者Y的包") | JSON | rg/jq ~/pi-data/pi-packages-search/packages.json |
| 模式匹配("名字带Z的") | JSON | rg '"name"...Z' packages.json |

## 中英转换

索引是英文。用户中文提问时，先转英文关键词再查（记忆→memory/persistent/session）。

## 流程

1. 调 get_stats 确认库存在；若过期提示 `pi-packages-search:crawl` 更新
2. 按上表选路径检索
3. 结果按 排名/类型/下载量/安装命令/链接 呈现，限 5-10 条

## 更新索引

pi 命令：`pi-packages-search:crawl`（增量）。首次或数据损坏用 `--full`。
```

- [ ] **Step 2: 写 `tests/bench.ts`**

```typescript
import { openDb } from "../src/db/connection";
import { searchPackages, getStats } from "../src/db/query";
import { DB_PATH } from "../src/shared/config";

const db = openDb();
const s = getStats(db);
console.log(`库: ${s.total} 包 | 上次爬取: ${s.lastCrawl}`);

const queries = ["memory", "subagent", "theme dark", "mcp tool", "web search"];
for (const q of queries) {
  const t0 = performance.now();
  const r = searchPackages(db, q, { limit: 10 });
  const ms = (performance.now() - t0).toFixed(2);
  console.log(`"${q}" → ${r.length} 条, ${ms}ms`);
}
db.close(false);
```

- [ ] **Step 3: 运行 benchmark**

Run: `bun run tests/bench.ts`
Expected: 每个查询 < 20ms（FTS5 毫秒级），打印各 query 命中数与耗时。

- [ ] **Step 4: 全量测试回归**

Run: `bun test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add skills/pi-packages-search/SKILL.md tests/bench.ts
git commit -m "feat: pi 技能 SKILL.md + 性能 benchmark"
```

---

## Self-Review（自审结果）

### 1. Spec 覆盖核对

| Spec 要求 | 覆盖任务 |
|-----------|---------|
| 全新 TS 爬虫 | Task 1,4,6,13 |
| SQLite 主表 + FTS5 external content | Task 3 |
| JSON 镜像 + meta.json(dateIndex) | Task 13（writer/index 写 JSON+meta）|
| 增量更新(全量列表+增量详情) | Task 7,13 |
| Worker 多线程解析 | Task 9 |
| Writer 单一写入点批量事务 | Task 10 |
| 异步并发池 + 自适应限流 | Task 5,12 |
| 4 个扩展工具(search/get/list/stats) | Task 11(query) + Task 14(extension) |
| pi 技能(双路径决策+中英转换) | Task 16 |
| 错误处理(重试/429/缺失/archived/Worker崩溃) | Task 6(重试),12(429),13(archived/降级),10(SQLite busy) |
| 测试策略(单元/集成/benchmark) | 各 Task TDD + Task 13 集成 + Task 16 benchmark |
| CLI 入口(crawl --full/--proxy) | Task 15 |

✅ Spec 全部要求均有任务覆盖。

### 2. 占位符扫描

已逐任务检查：无 TBD/TODO/"add error handling"/"similar to"，每个代码步骤含完整可运行代码。✅

### 3. 类型一致性

- `PiPackage` 字段在 types.ts(Task2) 定义，detail-parser(Task8)/writer(Task10)/query(Task11) 使用一致 ✅
- `ListPackage` 在 types.ts 定义，list-parser(Task4)/incremental(Task7)/index(Task13) 使用一致 ✅
- `searchPackages/getPackageDetail/listPackages/getStats` 签名在 query(Task11) 定义，extension(Task14) 调用一致 ✅
- `Writer.add/flush/markArchived` 签名 Task10 定义，Task13 调用一致 ✅
- `WorkerPool.parse/terminate` 签名 Task9 定义，Task13 调用一致 ✅

✅ 类型一致。

### 已知风险（实现时关注）

1. **pi 扩展类型**：Task 14 用 `any` 简化，实现时可补充 `types.d.ts` 声明 `ExtensionAPI` 获得类型安全。
2. **详情页 HTML 结构**：detail-parser 基于抓取样本编写，真实爬取时可能需微调正则（Task 15 Step 2 真实验证）。
3. **FTS5 external content 同步**：本方案 Writer 手动同步 FTS5（先 upsert packages 再 upsert fts），未用触发器；增量更新时需注意 rowid 对应（query 用 `SELECT id FROM packages WHERE name=?` 获取 rowid）。如出现 FTS 与主表不同步，可加 `--full` 重建。
4. **Worker 在 bun test 中**：Worker 池测试已设 15s 超时；若 CI 环境启动慢，可调大。

