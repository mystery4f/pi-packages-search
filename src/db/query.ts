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
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
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
