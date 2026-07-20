import { getDb, type NoteRow } from "../db/schema.js";
import { embedText, cosineSimilarity, blobToVector } from "../embeddings/model.js";
import type Database from "better-sqlite3";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  title: string;
  folder: string;
  tags: string[];
  score: number;
  snippet: string;
}

// ─── Full-text search ─────────────────────────────────────────────────────────

export function fullTextSearch(query: string, limit = 20): SearchResult[] {
  const db = getDb();

  // Sanitise FTS query (remove characters that break fts5 syntax)
  const safeQuery = query.replace(/['"*^()\[\]{}]/g, " ").trim();
  if (!safeQuery) return [];

  try {
    const rows = db
      .prepare(`
        SELECT
          n.path,
          n.title,
          n.folder,
          n.tags,
          bm25(notes_fts) AS score,
          snippet(notes_fts, 1, '<mark>', '</mark>', '…', 32) AS snippet
        FROM notes_fts
        JOIN notes n ON n.id = notes_fts.rowid
        WHERE notes_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `)
      .all(safeQuery, limit) as Array<{
        path: string;
        title: string;
        folder: string;
        tags: string;
        score: number;
        snippet: string;
      }>;

    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      folder: r.folder,
      tags: parseJson<string[]>(r.tags, []),
      score: Math.abs(r.score), // bm25 returns negative
      snippet: r.snippet,
    }));
  } catch {
    // FTS query syntax error — fall back to LIKE
    return likeSearch(db, query, limit);
  }
}

function likeSearch(db: Database.Database, query: string, limit: number): SearchResult[] {
  const rows = db
    .prepare(`
      SELECT path, title, folder, tags, content
      FROM notes
      WHERE content LIKE ? OR title LIKE ?
      LIMIT ?
    `)
    .all(`%${query}%`, `%${query}%`, limit) as NoteRow[];

  return rows.map((r) => ({
    path: r.path,
    title: r.title,
    folder: r.folder,
    tags: parseJson<string[]>(r.tags, []),
    score: 1,
    snippet: extractSnippet(r.content, query),
  }));
}

// ─── Semantic search ──────────────────────────────────────────────────────────

export async function semanticSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const db = getDb();

  let queryVector: Float32Array;
  try {
    queryVector = await embedText(query);
  } catch {
    return []; // embedding model not available
  }

  // Load all embedding chunks and compute cosine similarity in JS
  // (Fallback for when sqlite-vec is not loaded — works fine for vaults up to ~5k notes)
  const rows = db
    .prepare("SELECT e.note_id, e.chunk, e.vector, n.path, n.title, n.folder, n.tags FROM embeddings e JOIN notes n ON n.id = e.note_id")
    .all() as Array<{
      note_id: number;
      chunk: string;
      vector: Buffer;
      path: string;
      title: string;
      folder: string;
      tags: string;
    }>;

  const scored = rows.map((r) => {
    const vec = blobToVector(r.vector);
    const score = cosineSimilarity(queryVector, vec);
    return { path: r.path, title: r.title, folder: r.folder, tags: r.tags, score, snippet: r.chunk };
  });

  // Deduplicate by path — keep highest scoring chunk per note
  const byPath = new Map<string, (typeof scored)[0]>();
  for (const s of scored) {
    const existing = byPath.get(s.path);
    if (!existing || s.score > existing.score) byPath.set(s.path, s);
  }

  return [...byPath.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      path: r.path,
      title: r.title,
      folder: r.folder,
      tags: parseJson<string[]>(r.tags, []),
      score: r.score,
      snippet: r.snippet.slice(0, 300),
    }));
}

// ─── Hybrid search ────────────────────────────────────────────────────────────

export async function hybridSearch(query: string, limit = 15): Promise<SearchResult[]> {
  const [ftsResults, semResults] = await Promise.all([
    Promise.resolve(fullTextSearch(query, limit)),
    semanticSearch(query, limit),
  ]);

  // Merge results — deduplicate by path, combine scores
  const merged = new Map<string, SearchResult>();

  const maxFts = ftsResults[0]?.score ?? 1;
  for (const r of ftsResults) {
    merged.set(r.path, { ...r, score: (r.score / maxFts) * 0.6 });
  }

  const maxSem = semResults[0]?.score ?? 1;
  for (const r of semResults) {
    const existing = merged.get(r.path);
    const semScore = (r.score / maxSem) * 0.4;
    if (existing) {
      merged.set(r.path, { ...existing, score: existing.score + semScore });
    } else {
      merged.set(r.path, { ...r, score: semScore });
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Topic search (semantic + tag match) ─────────────────────────────────────

export async function topicSearch(topic: string, limit = 15): Promise<SearchResult[]> {
  const db = getDb();
  const topicLower = topic.toLowerCase();

  // Tag match: notes whose tags include the topic word
  const tagMatches = db
    .prepare(`
      SELECT path, title, folder, tags
      FROM notes
      WHERE lower(tags) LIKE ?
      LIMIT ?
    `)
    .all(`%${topicLower}%`, limit) as NoteRow[];

  const tagPaths = new Set(tagMatches.map((r) => r.path));

  // Semantic match
  const semResults = await semanticSearch(topic, limit);

  // Merge
  const results = new Map<string, SearchResult>();

  for (const r of tagMatches) {
    results.set(r.path, {
      path: r.path,
      title: r.title,
      folder: r.folder,
      tags: parseJson<string[]>(r.tags, []),
      score: 1.2, // boost tag matches
      snippet: `Tag match for topic "${topic}"`,
    });
  }

  for (const r of semResults) {
    const existing = results.get(r.path);
    const boost = tagPaths.has(r.path) ? 0.3 : 0; // extra boost if also tag-matched
    if (existing) {
      existing.score += r.score + boost;
    } else {
      results.set(r.path, { ...r, score: r.score + boost });
    }
  }

  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractSnippet(content: string, query: string, length = 200): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, length) + "…";
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + length);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}
