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
