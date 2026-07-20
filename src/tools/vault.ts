import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, type NoteRow } from "../db/schema.js";
import { fullTextSearch, hybridSearch, topicSearch } from "../vault/search.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function noteRowToObject(row: NoteRow) {
  return {
    path: row.path,
    title: row.title,
    folder: row.folder || "/",
    tags: parseJson<string[]>(row.tags, []),
    headings: parseJson<string[]>(row.headings, []),
    wikilinks: parseJson<string[]>(row.wikilinks, []),
    mtime: new Date(row.mtime).toISOString(),
  };
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerVaultTools(server: McpServer): void {
  const db = getDb();
  const vaultRoot = process.env["VAULT_PATH"] ?? "";

  // ── list_notes ─────────────────────────────────────────────────────────────

  server.registerTool(
    "list_notes",
    {
      title: "List Notes",
      description: "List notes in the vault, optionally filtered by tag and/or folder.",
      inputSchema: {
        tag: z.string().optional().describe("Filter by tag (partial match)"),
        folder: z.string().optional().describe("Filter by folder path prefix (e.g. 'Projects')"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max results (default 50)"),
      },
    },
    async ({ tag, folder, limit }) => {
      let query = "SELECT * FROM notes WHERE 1=1";
      const params: unknown[] = [];

      if (tag) {
        query += " AND lower(tags) LIKE ?";
        params.push(`%${tag.toLowerCase()}%`);
      }
      if (folder) {
        query += " AND (folder = ? OR folder LIKE ?)";
        params.push(folder, `${folder}/%`);
      }

      query += " ORDER BY mtime DESC LIMIT ?";
      params.push(limit ?? 50);

      const rows = db.prepare(query).all(...params) as NoteRow[];
      const notes = rows.map(noteRowToObject);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: notes.length, notes }, null, 2),
          },
        ],
      };
    }
  );

  // ── get_note ───────────────────────────────────────────────────────────────

  server.registerTool(
    "get_note",
    {
      title: "Get Note",
      description: "Return the full content of a note by its path or title.",
      inputSchema: {
        identifier: z.string().describe("Note path (relative, e.g. 'Projects/MyNote.md') or exact title"),
      },
    },
    async ({ identifier }) => {
      // Try by path first, then by title
      let row = db.prepare("SELECT * FROM notes WHERE path = ?").get(identifier) as NoteRow | undefined;
      if (!row) {
        row = db.prepare("SELECT * FROM notes WHERE lower(title) = lower(?)").get(identifier) as NoteRow | undefined;
      }
      if (!row) {
        // Fuzzy: path ends with identifier
        row = db
          .prepare("SELECT * FROM notes WHERE path LIKE ? ORDER BY mtime DESC LIMIT 1")
          .get(`%${identifier}`) as NoteRow | undefined;
      }

      if (!row) {
        return {
          content: [{ type: "text" as const, text: `Note not found: "${identifier}"` }],
          isError: true,
        };
      }

      // Read raw content from disk (index stores processed content; raw has frontmatter)
      const absPath = path.join(vaultRoot, row.path);
      let rawContent = row.content;
      try {
        rawContent = fs.readFileSync(absPath, "utf-8");
      } catch {
        // Fall back to indexed content
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...noteRowToObject(row),
                frontmatter: parseJson<Record<string, unknown>>(row.frontmatter, {}),
                content: rawContent,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── search_notes ───────────────────────────────────────────────────────────

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      description: "Full-text and semantic hybrid search across the vault.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        mode: z
          .enum(["hybrid", "fulltext", "semantic"])
          .default("hybrid")
          .describe("Search mode (default: hybrid)"),
        limit: z.number().int().min(1).max(50).default(15).describe("Max results"),
      },
    },
    async ({ query, mode, limit }) => {
      let results;
      switch (mode) {
        case "fulltext":
          results = fullTextSearch(query, limit ?? 15);
          break;
        case "semantic":
          results = await hybridSearch(query, limit ?? 15); // semantic-only path
          break;
        default:
          results = await hybridSearch(query, limit ?? 15);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ query, count: results.length, results }, null, 2),
          },
        ],
      };
    }
  );

  // ── get_notes_by_topic ─────────────────────────────────────────────────────

  server.registerTool(
    "get_notes_by_topic",
    {
      title: "Get Notes by Topic",
      description: "Return all notes relevant to a topic using tag matching and semantic similarity.",
      inputSchema: {
        topic: z.string().min(1).describe("Topic to search for"),
        limit: z.number().int().min(1).max(30).default(10).describe("Max results"),
      },
    },
    async ({ topic, limit }) => {
      const results = await topicSearch(topic, limit ?? 10);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ topic, count: results.length, results }, null, 2),
          },
        ],
      };
    }
  );

  // ── get_backlinks ──────────────────────────────────────────────────────────

  server.registerTool(
    "get_backlinks",
    {
      title: "Get Backlinks",
      description: "Find all notes that link to the given note via [[wikilinks]].",
      inputSchema: {
        note: z.string().describe("Note path or title to find backlinks for"),
      },
    },
    async ({ note }) => {
      // Resolve target note title
      let targetTitle = note;
      const row = db.prepare("SELECT title FROM notes WHERE path = ? OR lower(title) = lower(?)").get(note, note) as
        | { title: string }
        | undefined;
      if (row) targetTitle = row.title;

      // Notes that wikilink to targetTitle (case-insensitive)
      const backlinks = db
        .prepare(`
          SELECT path, title, folder, tags, mtime
          FROM notes
          WHERE lower(wikilinks) LIKE ?
          ORDER BY mtime DESC
        `)
        .all(`%${targetTitle.toLowerCase()}%`) as NoteRow[];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                note,
                targetTitle,
                count: backlinks.length,
                backlinks: backlinks.map(noteRowToObject),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── get_recent_notes ───────────────────────────────────────────────────────

  server.registerTool(
    "get_recent_notes",
    {
      title: "Get Recent Notes",
      description: "Return the N most recently modified notes.",
      inputSchema: {
        n: z.number().int().min(1).max(100).default(10).describe("Number of notes to return (default 10)"),
      },
    },
    async ({ n }) => {
      const rows = db
        .prepare("SELECT * FROM notes ORDER BY mtime DESC LIMIT ?")
        .all(n ?? 10) as NoteRow[];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: rows.length, notes: rows.map(noteRowToObject) }, null, 2),
          },
        ],
      };
    }
  );

  // ── get_vault_stats ────────────────────────────────────────────────────────

  server.registerTool(
    "get_vault_stats",
    {
      title: "Get Vault Stats",
      description: "Return vault statistics: note count, tag list, last git sync info.",
      inputSchema: {},
    },
    async () => {
      const noteCount = (db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number }).c;
      const questionCount = (db.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
      const dueCount = (
        db.prepare("SELECT COUNT(*) as c FROM questions WHERE due_date <= date('now')").get() as { c: number }
      ).c;

      // Collect all tags
      const tagRows = db.prepare("SELECT tags FROM notes").all() as { tags: string }[];
      const allTags = new Set<string>();
      for (const row of tagRows) {
        parseJson<string[]>(row.tags, []).forEach((t) => allTags.add(t));
      }

      // Folders
      const folderRows = db.prepare("SELECT DISTINCT folder FROM notes ORDER BY folder").all() as { folder: string }[];

      // Git sync health
      const syncRow = db.prepare("SELECT last_pull, commit_hash FROM sync_health WHERE id = 1").get() as
        | { last_pull: string | null; commit_hash: string | null }
        | undefined;

      // Try to get live git info from vault dir
      let liveCommit: string | null = null;
      try {
        liveCommit = execSync("git rev-parse --short HEAD", { cwd: vaultRoot, stdio: ["pipe", "pipe", "pipe"] })
          .toString()
          .trim();
      } catch {
        // Not a git repo or git not available
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                vault_path: vaultRoot,
                database_path: path.resolve(process.env["DB_PATH"] ?? "./data/obsidian-mcp.db"),
                notes: noteCount,
                questions: questionCount,
                due_for_review: dueCount,
                tags: [...allTags].sort(),
                folders: folderRows.map((r) => r.folder || "/").filter(Boolean),
                sync: {
                  last_pull: syncRow?.last_pull ?? null,
                  stored_commit: syncRow?.commit_hash ?? null,
                  current_commit: liveCommit,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
