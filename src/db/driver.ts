/**
 * DB 适配层：运行时检测，统一 bun:sqlite 与 better-sqlite3 的 API 差异。
 *
 * 背景（critical 约束）：
 * - pi 扩展在 Node.js 运行（jiti 转译），bun:sqlite 不可用 → 必须 better-sqlite3
 * - 爬虫 CLI 用 bun 运行，better-sqlite3 是 native addon 会直接崩溃（不可 try/catch）→ 必须 bun:sqlite
 *
 * 因此加载时用 typeof Bun 检测运行时，选择对应驱动。
 *
 * 统一的 API（对外暴露）：
 * - exec(sql)          DDL/批量语句
 * - prepare(sql)       返回统一的 Statement：.all(...b)/.get(...b)/.run(...b)
 * - transaction(fn)    返回包装函数，调用即事务执行
 * - close(throwOnError)
 */

export interface Statement {
  all(...bind: any[]): any[];
  get(...bind: any[]): any;
  run(...bind: any[]): any;
}

export interface DatabaseDriver {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(throwOnError?: boolean): void;
}

const isBun = typeof (globalThis as any).Bun !== "undefined";

function createBunDriver(path: string): DatabaseDriver {
  // bun:sqlite 只能在 bun 运行时 import
  const mod = require("bun:sqlite");
  const db = new mod.Database(path, { create: true });
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        all: (...b) => stmt.all(...b),
        get: (...b) => stmt.get(...b),
        run: (...b) => stmt.run(...b),
      };
    },
    transaction: (fn) => db.transaction(fn) as any,
    close: (throwOnError) => db.close(throwOnError),
  };
}

function createNodeDriver(path: string): DatabaseDriver {
  // node:sqlite (Node 22+ 内置, 无需编译) — pi 扩展运行在 node 上
  const mod = require("node:sqlite");
  const db = new mod.DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        all: (...b) => stmt.all(...b),
        get: (...b) => stmt.get(...b),
        run: (...b) => stmt.run(...b),
      };
    },
    transaction: (fn) => db.transaction(fn) as any,
    close: () => db.close(),
  };
}

/** 打开数据库，自动选择适配当前运行时的驱动 */
export function openDatabase(path: string = ":memory:"): DatabaseDriver {
  if (isBun) return createBunDriver(path);
  return createNodeDriver(path);
}

/** 运行时类型（调试/日志用） */
export const runtime = isBun ? "bun" : "node";
