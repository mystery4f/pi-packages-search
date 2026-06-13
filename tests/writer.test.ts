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
    expect((db.query("SELECT COUNT(*) c FROM packages").get() as any)).toEqual({ c: 2 });
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
