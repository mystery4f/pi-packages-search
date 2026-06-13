import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../shared/config";
import { openDatabase, type DatabaseDriver } from "./driver";
import { initSchema } from "./schema";

export { initSchema };

/** 打开（并按需初始化）数据库。自动适配 bun/node 运行时。可传入自定义路径用于测试。*/
export function openDb(path: string = DB_PATH): DatabaseDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  initSchema(db);
  return db;
}
