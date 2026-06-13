import type { DatabaseDriver } from "../db/driver";
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
  BASE_URL, LIST_CONCURRENCY, DETAIL_CONCURRENCY, JSON_PATH, META_PATH, FAILED_PATH,
} from "../shared/config";
import type { ListPackage, CrawlMeta } from "../shared/types";

export interface CrawlOptions {
  full?: boolean;       // 全量详情
  retryOnly?: boolean;   // 只补漏：跳过列表扫描，仅重试 failed.json + DB 缺失的包
  proxy?: string;
  dataDir?: string;     // 测试用：JSON/META 写入目录
  onLog?: (msg: string) => void;  // 日志回调（默认 console.log）
  silent?: boolean;     // 静默模式（测试用）
}

/** 日志器工厂：onLog 优先（显式回调总生效）；否则 silent 返回空函数；否则默认 stdout */
function makeLogger(opts: CrawlOptions) {
  if (opts.onLog) return opts.onLog;
  if (opts.silent) return (_msg: string) => {};
  return (msg: string) => process.stdout.write(msg);
}

export async function runCrawler(db: DatabaseDriver, opts: CrawlOptions = {}): Promise<CrawlMeta> {
  const start = Date.now();
  const log = makeLogger(opts);
  if (opts.proxy) { process.env.HTTPS_PROXY = opts.proxy; process.env.HTTP_PROXY = opts.proxy; }

  // ── 阶段 A: 列表全量 ──
  log("📋 阶段 A: 爬取列表页...\n");
  const firstHtml = await fetchPage(BASE_URL);
  const totalPages = parseTotalPages(firstHtml);
  const totalCount = parseTotalCount(firstHtml);
  log(`   发现 ${totalCount} 个包，共 ${totalPages} 页\n`);
  const list: ListPackage[] = parseListHtml(firstHtml);
  let listPagesDone = 1;
  const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  await pool(pages, LIST_CONCURRENCY, async (page) => {
    const html = await fetchPage(`${BASE_URL}?page=${page}`);
    list.push(...parseListHtml(html));
    listPagesDone++;
    log(`\r   列表页 ${listPagesDone}/${totalPages}  (${list.length} 包)      \r`);
  });

  // ── 阶段 B: 决定要爬哪些详情页 ──
  const metaPath = opts.dataDir ? `${opts.dataDir}/meta.json` : META_PATH;
  const skipMetaRead = opts.dataDir === ":memory:" || !existsSync(metaPath);
  const prevMeta: CrawlMeta | null = skipMetaRead
    ? null
    : JSON.parse(readFileSync(metaPath, "utf-8"));
  const prevIndex = prevMeta?.dateIndex ?? {};
  const toFetch: string[] = [];
  let removedNames: string[] = [];

  if (opts.retryOnly) {
    // ── retry 模式：只补漏，不爬全量列表 ──
    log("🔧 补漏模式：仅重试失败/缺失的包\n");
    // 从 failed.json 拿上次失败的包名
    const failedPath = opts.dataDir ? `${opts.dataDir}/failed.json` : FAILED_PATH;
    const failedSet = new Set<string>();
    if (existsSync(failedPath)) {
      try {
        const failedData = JSON.parse(readFileSync(failedPath, "utf-8"));
        (failedData.items ?? failedData.names ?? []).forEach((item: any) => {
          failedSet.add(typeof item === "string" ? item : item.name);
        });
      } catch { /* ignore */ }
    }
    // 从 DB 查 prevIndex 里有但 packages 表里缺的
    const existingNames = new Set(
      (db.prepare("SELECT name FROM packages WHERE archived=0").all() as any[]).map((r) => r.name),
    );
    const currentNames = new Set(list.map((p) => p.name));
    for (const name of Object.keys(prevIndex)) {
      if (currentNames.has(name) && !existingNames.has(name)) failedSet.add(name);
    }
    toFetch.push(...failedSet);
    log(`   需补漏 ${toFetch.length} 个包\n`);
  } else if (opts.full) {
    log("🔧 全量模式：将爬取全部详情页\n");
    toFetch.push(...list.map((p) => p.name));
  } else {
    // ── 增量模式 ──
    const diff = computeDiff(list, prevIndex);
    toFetch.push(...diff.toFetch);
    removedNames = diff.removed;
    log(`🔍 阶段 B: 增量对比 — 新增 ${diff.added.length} / 更新 ${diff.updated.length} / 消失 ${diff.removed.length}，需爬 ${diff.toFetch.length} 个详情页\n`);
    // 补漏：上次爬取失败的包
    if (prevMeta) {
      const existingNames = new Set(
        (db.prepare("SELECT name FROM packages WHERE archived=0").all() as any[]).map((r) => r.name),
      );
      const currentNames2 = new Set(list.map((p) => p.name));
      const missing: string[] = [];
      for (const name of Object.keys(prevIndex)) {
        if (currentNames2.has(name) && !existingNames.has(name) && !toFetch.includes(name)) {
          missing.push(name);
        }
      }
      if (missing.length > 0) {
        toFetch.push(...missing);
        log(`   🔄 补漏: ${missing.length} 个包上次失败/缺失，本次重试\n`);
      }
    }
  }

  // ── 阶段 C+D: 详情爬取 + Worker 解析 + Writer 入库 ──
  const failedItems: { name: string; error: string }[] = [];
  if (toFetch.length === 0) {
    log("✨ 无需更新，所有包已是最新\n");
  } else {
    log(`🌐 阶段 C: 爬取详情页 (并发 ${DETAIL_CONCURRENCY})...\n`);
    const limiter = new AdaptiveLimiter(DETAIL_CONCURRENCY);
    const workers = new WorkerPool();
    const writer = new Writer(db);
    const listMap = new Map(list.map((p) => [p.name, p]));
    let done = 0;
    const detailStart = Date.now();

    await pool(toFetch, limiter.current(), async (name) => {
      try {
        const html = await fetchPage(`${BASE_URL}/${encodeURIComponent(name)}`);
        const pkg = await workers.parse(name, html);
        const lp = listMap.get(name);
        if (lp) {
          pkg.downloadsMonthly = pkg.downloadsMonthly || lp.downloads;
          pkg.updatedAt = lp.date ? new Date(lp.date).toISOString().split("T")[0] : "";
          pkg.types = lp.types.length ? lp.types : pkg.types;
        }
        writer.add(pkg);
        limiter.recordSuccess();
      } catch (err: any) {
        failedItems.push({ name, error: err?.message || String(err) });
        limiter.recordFailure();
      }
      done++;
      const pct = ((done / toFetch.length) * 100).toFixed(0);
      const elapsed = (Date.now() - detailStart) / 1000;
      const speed = elapsed > 0 ? (done / elapsed).toFixed(1) : "0";
      const remain = toFetch.length - done;
      const eta = elapsed > 0 && done > 0 ? Math.round(remain / (done / elapsed)) : 0;
      log(`\r   [${pct}%] ${done}/${toFetch.length}  ${speed}/s  剩余 ~${eta}s  失败 ${failedItems.length}  并发 ${limiter.current()}    \r`);
    });

    writer.flush();
    if (!opts.full && !opts.retryOnly) writer.markArchived(removedNames);
    workers.terminate();
  }

  // ── 写 JSON + meta + failed.json ──
  const skipFiles = opts.dataDir === ":memory:";
  const allRows = db.prepare("SELECT * FROM packages WHERE archived=0").all();
  const jsonPath = opts.dataDir ? `${opts.dataDir}/packages.json` : JSON_PATH;
  const failedPath = opts.dataDir ? `${opts.dataDir}/failed.json` : FAILED_PATH;
  if (!skipFiles) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify({ generated: new Date().toISOString(), total: allRows.length, packages: allRows }, null, 2));
    if (failedItems.length > 0) {
      writeFileSync(failedPath, JSON.stringify({ lastCrawl: new Date().toISOString(), count: failedItems.length, items: failedItems }, null, 2));
    }
  }
  const meta: CrawlMeta = {
    lastCrawl: new Date().toISOString(),
    totalPackages: totalCount || allRows.length,
    durationSeconds: Math.round((Date.now() - start) / 1000),
    crawlerVersion: "1.0.0",
    sourceUrl: BASE_URL,
    dateIndex: buildDateIndex(list),
    failedCount: failedItems.length,
  };
  if (!skipFiles) {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  // 区分全成功 / 部分失败（仅 CLI 模式输出；扩展模式由 handler 根据 meta.failedCount 决定通知）
  if (!opts.onLog) {
    if (failedItems.length > 0) {
      log(`\n⚠ 完成: ${meta.totalPackages} 包, 用时 ${meta.durationSeconds}s, 但 ${failedItems.length} 个失败\n`);
    } else {
      log(`\n✅ 完成: ${meta.totalPackages} 包, 用时 ${meta.durationSeconds}s\n`);
    }
  }
  return meta;
}
