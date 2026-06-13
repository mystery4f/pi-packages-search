import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../shared/config";
import { initSchema } from "./schema";

export { initSchema };

/** 打开（并按需初始化）数据库。可传入自定义路径用于测试。*/
export function openDb(path: string = DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  initSchema(db);
  return db;
}
