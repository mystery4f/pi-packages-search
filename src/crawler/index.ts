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
import type { ListPackage, CrawlMeta } from "../shared/types";

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
  const skipMetaRead = opts.dataDir === ":memory:" || !existsSync(metaPath);
  const prevMeta: CrawlMeta | null = skipMetaRead
    ? null
    : JSON.parse(readFileSync(metaPath, "utf-8"));
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
        pkg.updatedAt = lp.date ? new Date(lp.date).toISOString().split("T")[0] : "";
        pkg.types = lp.types.length ? lp.types : pkg.types;
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
  const skipFiles = opts.dataDir === ":memory:";
  const allRows = db.query("SELECT * FROM packages WHERE archived=0").all();
  const jsonPath = opts.dataDir ? `${opts.dataDir}/packages.json` : JSON_PATH;
  if (!skipFiles) {
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
  if (!skipFiles) {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  return meta;
}
