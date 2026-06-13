import type { Database } from "bun:sqlite";

export function initSchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");

  db.run(`
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
      crawled_at          TEXT
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_packages_types ON packages(types);");
  db.run("CREATE INDEX IF NOT EXISTS idx_packages_downloads ON packages(downloads_monthly DESC);");

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
      name, description, readme, types, manifest_tools,
      content='packages',
      content_rowid='id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}
