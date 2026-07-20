import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NoteRow {
  id: number;
  path: string;
  title: string;
  folder: string;
  tags: string; // JSON array string
  frontmatter: string; // JSON object string
  content: string;
  mtime: number; // unix ms
  wikilinks: string; // JSON array string
  headings: string; // JSON array string
}

export interface QuestionRow {
  id: number;
  note_path: string;
  question_text: string;
  answer_text: string;
  ease_factor: number;
  interval_days: number;
  due_date: string; // ISO date string YYYY-MM-DD
  last_reviewed: string | null;
  review_count: number;
  created_at: string;
}

export interface ReviewSessionRow {
  id: number;
  topic: string | null;
  started_at: string;
  ended_at: string | null;
  questions_asked: number;
  questions_correct: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Notes index
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  folder      TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  frontmatter TEXT    NOT NULL DEFAULT '{}',   -- JSON object
  content     TEXT    NOT NULL DEFAULT '',
  mtime       INTEGER NOT NULL DEFAULT 0,      -- unix ms
  wikilinks   TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  headings    TEXT    NOT NULL DEFAULT '[]'    -- JSON array
);

-- Full-text search over title + content
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  content,
  content='notes',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS triggers to keep in sync
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;

-- Embedding chunks (one note can have multiple chunks)
CREATE TABLE IF NOT EXISTS embeddings (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk    TEXT    NOT NULL,
  vector   BLOB    NOT NULL  -- raw Float32Array bytes
);

CREATE INDEX IF NOT EXISTS embeddings_note_id ON embeddings(note_id);

-- Questions (SM-2 state per question)
CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  note_path     TEXT    NOT NULL,
  question_text TEXT    NOT NULL,
  answer_text   TEXT    NOT NULL DEFAULT '',
  ease_factor   REAL    NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 1,
  due_date      TEXT    NOT NULL DEFAULT (date('now')),  -- YYYY-MM-DD
  last_reviewed TEXT    DEFAULT NULL,
  review_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS questions_due ON questions(due_date);
CREATE INDEX IF NOT EXISTS questions_note ON questions(note_path);

-- Review sessions
CREATE TABLE IF NOT EXISTS review_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  topic             TEXT    DEFAULT NULL,
  started_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT    DEFAULT NULL,
  questions_asked   INTEGER NOT NULL DEFAULT 0,
  questions_correct INTEGER NOT NULL DEFAULT 0
);

-- Sync health tracking
CREATE TABLE IF NOT EXISTS sync_health (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  last_pull   TEXT    DEFAULT NULL,   -- ISO datetime
  commit_hash TEXT    DEFAULT NULL
);

INSERT OR IGNORE INTO sync_health(id) VALUES(1);
`;

// ─── Open / initialise DB ────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolved = dbPath ?? process.env["DB_PATH"] ?? "./data/obsidian-mcp.db";
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(resolved);
  _db.exec(SCHEMA);

  // Try to load sqlite-vec extension for vector operations
  // Falls back gracefully if unavailable (semantic search disabled)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as { load: (db: Database.Database) => void };
    sqliteVec.load(_db);
    console.error("[db] sqlite-vec extension loaded — semantic search enabled");
  } catch {
    console.error("[db] sqlite-vec not available — semantic search will use JS fallback");
  }

  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
