import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDatabase } from "../src/db/driver";
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
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(":memory:"); initSchema(db);
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
