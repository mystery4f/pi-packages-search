#!/usr/bin/env bun
import { openDb } from "../src/db/connection";
import { runCrawler } from "../src/crawler";

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

  crawl          爬取/更新索引（默认增量）
  --full         全量详情（首次/修复）
  --proxy <url>  代理地址（中国用户建议 http://localhost:4444）`);
}
