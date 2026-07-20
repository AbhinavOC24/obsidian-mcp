import { glob } from "glob";
import chokidar from "chokidar";
import path from "node:path";
import { getDb } from "../db/schema.js";
import { parseNote, chunkContent } from "./parser.js";
import { embedText, vectorToBlob } from "../embeddings/model.js";
import type Database from "better-sqlite3";

// ─── Indexer ─────────────────────────────────────────────────────────────────

export class VaultIndexer {
  private db: Database.Database;
  private vaultRoot: string;
  private watcher?: chokidar.FSWatcher;

  constructor(vaultRoot: string) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.db = getDb();
  }

  /** Full initial index of the vault. */
  async indexAll(): Promise<{ indexed: number; skipped: number }> {
    console.error(`[indexer] Scanning vault: ${this.vaultRoot}`);

    const files = await glob("**/*.md", {
      cwd: this.vaultRoot,
      absolute: true,
      ignore: [
        "**/.obsidian/**",
        "**/.trash/**",
        "**/node_modules/**",
      ],
    });

    let indexed = 0;
    let skipped = 0;

    for (const file of files) {
      const changed = await this.indexFile(file);
      if (changed) indexed++;
      else skipped++;
    }

    console.error(`[indexer] Done: ${indexed} indexed, ${skipped} unchanged`);
    return { indexed, skipped };
  }

  /** Index a single file; skips if mtime hasn't changed. Returns true if re-indexed. */
  async indexFile(absolutePath: string): Promise<boolean> {
    try {
      const note = parseNote(absolutePath, this.vaultRoot);

      // Check if already up-to-date
      const existing = this.db
        .prepare("SELECT id, mtime FROM notes WHERE path = ?")
        .get(note.path) as { id: number; mtime: number } | undefined;

      if (existing && existing.mtime >= note.mtime) return false;

      // Upsert note row
      const upsert = this.db.prepare(`
        INSERT INTO notes (path, title, folder, tags, frontmatter, content, mtime, wikilinks, headings)
        VALUES (@path, @title, @folder, @tags, @frontmatter, @content, @mtime, @wikilinks, @headings)
        ON CONFLICT(path) DO UPDATE SET
          title       = excluded.title,
          folder      = excluded.folder,
          tags        = excluded.tags,
          frontmatter = excluded.frontmatter,
          content     = excluded.content,
          mtime       = excluded.mtime,
          wikilinks   = excluded.wikilinks,
          headings    = excluded.headings
      `);

      upsert.run({
        path: note.path,
        title: note.title,
        folder: note.folder,
        tags: JSON.stringify(note.tags),
        frontmatter: JSON.stringify(note.frontmatter),
        content: note.content,
        mtime: note.mtime,
        wikilinks: JSON.stringify(note.wikilinks),
        headings: JSON.stringify(note.headings),
      });

      const noteId = (
        this.db.prepare("SELECT id FROM notes WHERE path = ?").get(note.path) as { id: number }
      ).id;

      // Re-embed (delete old embeddings, insert new)
      await this.embedNote(noteId, note.content);

      return true;
    } catch (err) {
      console.error(`[indexer] Failed to index ${absolutePath}:`, err);
      return false;
    }
  }

  /** Remove a deleted file from the index. */
  removeFile(absolutePath: string): void {
    const relativePath = path.relative(this.vaultRoot, absolutePath).replace(/\\/g, "/");
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(relativePath);
  }

  /** Start watching the vault for file changes. */
  startWatching(): void {
    this.watcher = chokidar.watch("**/*.md", {
      cwd: this.vaultRoot,
      ignoreInitial: true,
      ignored: [/(^|[/\\])\../, "**/node_modules/**"],
    });

    this.watcher.on("add", (relPath) => {
      const abs = path.join(this.vaultRoot, relPath);
      this.indexFile(abs).catch(console.error);
    });

    this.watcher.on("change", (relPath) => {
      const abs = path.join(this.vaultRoot, relPath);
      this.indexFile(abs).catch(console.error);
    });

    this.watcher.on("unlink", (relPath) => {
      const abs = path.join(this.vaultRoot, relPath);
      this.removeFile(abs);
    });

    console.error("[indexer] Watching vault for changes...");
  }

  async close(): Promise<void> {
    await this.watcher?.close();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async embedNote(noteId: number, content: string): Promise<void> {
    // Delete stale embeddings
    this.db.prepare("DELETE FROM embeddings WHERE note_id = ?").run(noteId);

    const chunks = chunkContent(content);
    for (const chunk of chunks) {
      try {
        const vector = await embedText(chunk);
        const blob = vectorToBlob(vector);
        this.db
          .prepare("INSERT INTO embeddings (note_id, chunk, vector) VALUES (?, ?, ?)")
          .run(noteId, chunk, blob);
      } catch {
        // Embeddings are optional — continue without them
      }
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _indexer: VaultIndexer | null = null;

export function getIndexer(vaultRoot?: string): VaultIndexer {
  if (!_indexer) {
    const root = vaultRoot ?? process.env["VAULT_PATH"];
    if (!root) throw new Error("VAULT_PATH not set and no vaultRoot provided");
    _indexer = new VaultIndexer(root);
  }
  return _indexer;
}
