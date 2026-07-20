import matter from "gray-matter";
import path from "node:path";
import fs from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Note {
  /** Relative path from vault root, e.g. "Projects/MyNote.md" */
  path: string;
  title: string;
  folder: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  content: string; // raw markdown (without frontmatter)
  rawContent: string; // full file content
  mtime: number; // unix ms
  wikilinks: string[]; // [[linked note]] targets
  headings: string[]; // ## Heading text
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a single markdown file into a Note object.
 * @param absolutePath - Full OS path to the .md file
 * @param vaultRoot    - Vault root path; used to compute relative note path
 */
export function parseNote(absolutePath: string, vaultRoot: string): Note {
  const rawContent = fs.readFileSync(absolutePath, "utf-8");
  const { data: frontmatter, content } = matter(rawContent);

  const stat = fs.statSync(absolutePath);
  const mtime = stat.mtimeMs;

  const relativePath = path.relative(vaultRoot, absolutePath).replace(/\\/g, "/");
  const folder = path.dirname(relativePath) === "." ? "" : path.dirname(relativePath);

  // Title: frontmatter.title > first H1 in content > filename stem
  const title = extractTitle(frontmatter, content, absolutePath);

  // Tags: merge frontmatter.tags + inline #tags in content
  const tags = extractTags(frontmatter, content);

  // WikiLinks: [[Note Title]] or [[Note Title|Alias]]
  const wikilinks = extractWikilinks(content);

  // Headings: ## Heading
  const headings = extractHeadings(content);

  return {
    path: relativePath,
    title,
    folder,
    tags,
    frontmatter: frontmatter as Record<string, unknown>,
    content,
    rawContent,
    mtime,
    wikilinks,
    headings,
  };
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

function extractTitle(
  frontmatter: Record<string, unknown>,
  content: string,
  filePath: string
): string {
  if (typeof frontmatter["title"] === "string" && frontmatter["title"].trim()) {
    return frontmatter["title"].trim();
  }
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return path.basename(filePath, ".md");
}

function extractTags(frontmatter: Record<string, unknown>, content: string): string[] {
  const tags = new Set<string>();

  // Frontmatter tags: can be string, string[], or comma-separated
  const fmTags = frontmatter["tags"];
  if (typeof fmTags === "string") {
    fmTags.split(/[\s,]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, "")));
  } else if (Array.isArray(fmTags)) {
    fmTags.forEach((t) => {
      if (typeof t === "string") tags.add(t.replace(/^#/, ""));
    });
  }

  // Inline #tags in content (not inside code blocks)
  const inlineTags = content.match(/(?<![`\w])#([a-zA-Z][a-zA-Z0-9/_-]*)/g) ?? [];
  inlineTags.forEach((t) => tags.add(t.slice(1)));

  return [...tags].sort();
}

function extractWikilinks(content: string): string[] {
  const links = new Set<string>();
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    links.add(match[1].trim());
  }
  return [...links];
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m) headings.push(m[1].trim());
  }
  return headings;
}

// ─── Chunking (for embeddings) ────────────────────────────────────────────────

const CHUNK_SIZE = 400; // approximate tokens (~chars / 4)
const CHUNK_OVERLAP = 50;

/**
 * Split note content into overlapping chunks suitable for embedding.
 * Tries to split on paragraph boundaries.
 */
export function chunkContent(content: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > chunkSize * 4 && current.length > 0) {
      chunks.push(current.trim());
      // Start next chunk with overlap from end of current
      const words = current.split(/\s+/);
      current = words.slice(-overlap).join(" ") + "\n\n" + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 20);
}
