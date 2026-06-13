import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = join(homedir(), "pi-data", "pi-packages-search");
export const DB_PATH = join(DATA_DIR, "pi-packages.sqlite");
export const JSON_PATH = join(DATA_DIR, "packages.json");
export const META_PATH = join(DATA_DIR, "meta.json");
export const FAILED_PATH = join(DATA_DIR, "failed.json");

export const BASE_URL = "https://pi.dev/packages";

/** Worker 数量 */
export const WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);
/** 并发数 */
export const LIST_CONCURRENCY = 10;
export const DETAIL_CONCURRENCY = 15;
/** Writer 批量大小 */
export const WRITE_BATCH = 50;
