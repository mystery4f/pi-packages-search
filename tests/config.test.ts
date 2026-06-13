import { describe, test, expect } from "bun:test";
import { DATA_DIR, DB_PATH, JSON_PATH, META_PATH, BASE_URL } from "../src/shared/config";

describe("config", () => {
  test("DATA_DIR 在 ~/pi-data/pi-packages-search 下", () => {
    expect(DATA_DIR).toContain("pi-data");
    expect(DATA_DIR).toContain("pi-packages-search");
  });
  test("DB/JSON/META 路径都在 DATA_DIR 下", () => {
    expect(DB_PATH.startsWith(DATA_DIR)).toBe(true);
    expect(JSON_PATH.startsWith(DATA_DIR)).toBe(true);
    expect(META_PATH.startsWith(DATA_DIR)).toBe(true);
  });
  test("BASE_URL 是 pi.dev/packages", () => {
    expect(BASE_URL).toBe("https://pi.dev/packages");
  });
});
