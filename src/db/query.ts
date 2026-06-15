import type { DatabaseDriver } from "./driver";
import type { PiPackage } from "../shared/types";
import { enrichFromNpm } from "../shared/npm-registry";

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
    searchText: "", detailSource: r.detail_source ?? null, id: r.id, archived: r.archived ?? 0,
  };
}

/** FTS5 全文搜索（关键词空格分隔 → MATCH），可选 type 过滤与排序 */
export function searchPackages(
  db: DatabaseDriver, query: string, opts: { type?: PkgType; limit?: number; sort?: SortKey } = {},
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
  return db.prepare(sql).all(match, limit).map(rowToPkg);
}

/**
 * 按包名取详情。当 README 为空时，自动从 npm registry 补充并写回数据库，
 * 下次查询直接命中缓存。npm 请求失败则降级返回本地数据。
 */
export async function getPackageDetail(db: DatabaseDriver, name: string): Promise<SearchResult | null> {
  const r = db.prepare("SELECT * FROM packages WHERE name=? AND archived=0").get(name) as any;
  if (!r) return null;
  const pkg = rowToPkg(r);

  // README 为空 → npm registry 实时补充 + 写回缓存
  const enriched = await enrichFromNpm(pkg);
  if (enriched.detailSource === "npm") writeBackNpmDetail(db, enriched);
  return enriched;
}

/** 把 npm 补充的数据写回 packages 表 + FTS 索引，下次查询直接命中 */
function writeBackNpmDetail(db: DatabaseDriver, pkg: SearchResult): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const id = (db.prepare("SELECT id FROM packages WHERE name=?").get(pkg.name) as any)?.id;
    // FTS 是 external content table（content='packages'），其列 manifest_tools 与
    // 主表列名 manifest 不一致。普通 DELETE 会触发 FTS5 从 content table 读列 → 报错。
    // 改用 FTS5 special delete command（用 UPDATE 前的旧值定位索引项）再 insert 新值。
    const old = id != null
      ? (db.prepare("SELECT name, description, readme, types, manifest FROM packages WHERE name=?").get(pkg.name) as any)
      : null;

    db.prepare(`
      UPDATE packages SET
        readme=?, description=?, manifest=?, author=?, version=?, license=?,
        repo_url=?, dependencies_count=?, published_at=?, detail_source=?, crawled_at=?
      WHERE name=?`).run(
      pkg.readme, pkg.description, pkg.manifest, pkg.author, pkg.version,
      pkg.license, pkg.repoUrl, pkg.dependenciesCount, pkg.publishedAt,
      pkg.detailSource, now, pkg.name,
    );

    if (id != null && old) {
      // 删除旧索引项（用旧值）
      db.prepare(
        "INSERT INTO packages_fts(packages_fts, rowid, name, description, readme, types, manifest_tools) VALUES('delete', ?, ?, ?, ?, ?, ?)"
      ).run(id, old.name, old.description ?? "", old.readme ?? "", old.types ?? "[]", old.manifest ?? "");
      // 插入新索引项
      db.prepare(
        "INSERT INTO packages_fts(rowid, name, description, readme, types, manifest_tools) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, pkg.name, pkg.description, pkg.readme ?? "", JSON.stringify(pkg.types), pkg.manifest ?? "");
    }
  });
  tx();
}

export function listPackages(
  db: DatabaseDriver, opts: { type?: PkgType; sort?: SortKey; limit?: number } = {},
): SearchResult[] {
  const limit = opts.limit ?? 10;
  const where = opts.type ? `WHERE archived=0 AND types LIKE '%"${opts.type}"%'` : "WHERE archived=0";
  const order = opts.sort === "updated" ? "updated_at DESC" : "downloads_monthly DESC";
  return db.prepare(`SELECT * FROM packages ${where} ORDER BY ${order} LIMIT ?`).all(limit).map(rowToPkg);
}

export function getStats(db: DatabaseDriver): {
  total: number; byType: Record<string, number>; lastCrawl: string | null;
} {
  const total = (db.prepare("SELECT COUNT(*) c FROM packages WHERE archived=0").get() as any).c;
  const rows = db.prepare("SELECT types FROM packages WHERE archived=0").all() as { types: string }[];
  const byType: Record<string, number> = {};
  for (const r of rows) {
    for (const t of (r.types ? JSON.parse(r.types) : [])) byType[t] = (byType[t] || 0) + 1;
  }
  const last = db.prepare("SELECT MAX(crawled_at) m FROM packages").get() as any;
  return { total, byType, lastCrawl: last?.m ?? null };
}
