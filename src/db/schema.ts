import type { DatabaseDriver } from "./driver";

export function initSchema(db: DatabaseDriver): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id                  INTEGER PRIMARY KEY,
      name                TEXT UNIQUE NOT NULL,
      description         TEXT,
      readme              TEXT,
      types               TEXT,
      author              TEXT,
      version             TEXT,
      license             TEXT,
      size                TEXT,
      dependencies_count  INTEGER,
      downloads_monthly   INTEGER,
      downloads_weekly    INTEGER,
      published_at        TEXT,
      updated_at          TEXT,
      install_cmd         TEXT,
      npm_url             TEXT,
      repo_url            TEXT,
      detail_url          TEXT,
      manifest            TEXT,
      archived            INTEGER DEFAULT 0,
      crawled_at          TEXT,
      detail_source       TEXT
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_packages_types ON packages(types);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_packages_downloads ON packages(downloads_monthly DESC);");

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
      name, description, readme, types, manifest_tools,
      content='packages',
      content_rowid='id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  // ── 轻量迁移：为老库补列（CREATE TABLE IF NOT EXISTS 不会更新既有表结构）──
  addColumnIfNotExists(db, "packages", "detail_source", "TEXT");
}

/** 仅当列不存在时 ALTER TABLE ADD COLUMN（SQLite 不支持 ADD COLUMN IF NOT EXISTS）*/
function addColumnIfNotExists(db: DatabaseDriver, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}
