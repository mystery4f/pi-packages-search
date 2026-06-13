import { openDb } from "../src/db/connection";
import { searchPackages, getStats } from "../src/db/query";

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
