import type { DatabaseDriver } from "../db/driver";
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
  private stmtUpsert;
  private stmtFts;

  constructor(private db: DatabaseDriver, private batchSize: number = WRITE_BATCH) {
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
    const stmt = this.db.prepare("UPDATE packages SET archived=1 WHERE name=?");
    const mark = this.db.transaction(() => {
      for (const n of names) stmt.run(n);
    });
    mark();
  }
}
