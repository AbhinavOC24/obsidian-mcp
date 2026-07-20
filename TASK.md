# Task: Obsidian Notes MCP Server with Sync + Active Recall (Anki-style Q&A)

## 1. Goal

Build an MCP (Model Context Protocol) server that:

1. Exposes my Obsidian vault's notes to any MCP-compatible client (Claude Desktop, Claude Code, etc.) so they can be retrieved and reasoned over.
2. Keeps the vault in sync between my local MacBook and a remote EC2 instance (where the MCP server actually runs / reads from).
3. Supports "cross-questioning" — the ability to be quizzed on a topic, get generated questions from notes on that topic, and track recall performance over time in a spaced-repetition (Anki-like) style.

---

## 2. High-Level Architecture

```
┌─────────────────┐        sync         ┌──────────────────────────┐
│  MacBook         │ ──────────────────▶ │  EC2 instance             │
│  Obsidian Vault  │   (rsync/git/       │  ~/vault (mirrored copy)  │
│  (source of      │    Syncthing/S3)    │                           │
│   truth)         │ ◀────────────────── │  MCP Server (this repo)  │
└─────────────────┘   (bi-directional,   │   - reads vault           │
                        optional)         │   - indexes notes         │
                                          │   - serves MCP tools      │
                                          │   - stores review state   │
                                          └──────────────────────────┘
                                                     ▲
                                                     │ MCP (stdio/SSE/HTTP)
                                                     │
                                          ┌──────────────────────────┐
                                          │  MCP Client               │
                                          │  (Claude Desktop/Code,    │
                                          │   any MCP host)           │
                                          └──────────────────────────┘
```

---

## 3. Components to Build

### 3.1 Sync Mechanism (MacBook ⇄ EC2)

- [x] Strategy chosen: **Git**. Vault is a git repo; commit + push from Mac, pull on EC2. Trade-off accepted: not real-time (there's a commit/push/pull lag), but gives versioning/history for free and is simple to reason about and debug.
- [ ] Set up:
  - [ ] Private git repo for the vault (self-hosted, or a private GitHub/GitLab repo — vault content will live there, so factor that into where you're comfortable hosting it)
  - [ ] SSH key-based auth: Mac → git remote, and EC2 → git remote (deploy key, read-only is enough on the EC2 side if EC2 never writes back)
  - [ ] `.gitignore` for `.obsidian/workspace*.json`, `.trash/`, and other non-content/local-state files
  - [ ] Conflict policy: since git is the sync mechanism, conflicts surface as real git merge conflicts if the vault is ever edited from two places at once — decide whether EC2-side is strictly read-only (recommended, avoids conflicts entirely) or also writes back
  - [ ] Logging of sync events (for debugging missed/failed pulls)
- [ ] Trigger sync:
  - [ ] Mac → remote: `launchd` job that runs `git add -A && git commit -m "auto-sync" && git push` on a timer (e.g. every 5 min) or on file save via `fswatch`
  - [ ] Remote → EC2: `systemd` timer or cron running `git pull` every N minutes, or a webhook (e.g. GitHub webhook → small endpoint on EC2) for near-instant pulls instead of polling
- [ ] Health check: MCP tool or endpoint that reports last successful `git pull` timestamp + current commit hash, so you can verify EC2's vault copy is current

### 3.2 MCP Server (runs on EC2)

- [ ] Choose SDK/language: Python (`mcp` SDK) or TypeScript (`@modelcontextprotocol/sdk`)
- [ ] Transport: stdio for local testing, then SSE/HTTP for remote access from MCP clients over the network
- [ ] Auth: token-based auth on the HTTP/SSE endpoint since this is exposed on EC2, not local stdio
- [ ] Vault indexing:
  - [ ] Parse all `.md` files in the vault
  - [ ] Extract: title, tags, frontmatter, headings, backlinks/`[[wikilinks]]`, creation/modified dates
  - [ ] Build a lightweight index (SQLite or JSON) for fast lookup — re-index on file change (watch EC2-side vault dir) rather than full rescan every call
  - [ ] Optional: embeddings-based semantic index (e.g., local embedding model or an API) for topic/semantic search, stored in SQLite/`sqlite-vec` or a simple vector store
- [ ] MCP Tools to expose:
  - [ ] `list_notes(tag?, folder?)` — list notes, optionally filtered
  - [ ] `get_note(path | title)` — return full content of a note
  - [ ] `search_notes(query)` — full-text and/or semantic search across vault
  - [ ] `get_notes_by_topic(topic)` — return all notes/sections relevant to a topic (tag match + semantic match)
  - [ ] `get_backlinks(note)` — notes linking to this note
  - [ ] `get_recent_notes(n)` — recently modified notes
  - [ ] `get_vault_stats()` — note count, tags, last sync time (useful sanity check)
- [ ] MCP Resources (optional): expose notes as MCP resources so clients can browse the vault tree directly

### 3.3 Active Recall / "Anki-style" Q&A Layer

- [ ] Question generation:
  - [ ] `generate_questions(topic | note)` tool — server returns a set of candidate questions derived from the note content (this can just return content + let the calling LLM generate questions, or the server can call an LLM API itself to pre-generate and cache them)
  - [ ] Decide: should question generation happen **client-side** (the MCP client's LLM reads the note and asks you) or **server-side** (server calls an LLM API to generate/cache questions)? Recommendation: server-side generation + caching, since it lets you track questions across sessions.
- [ ] Spaced repetition state:
  - [ ] Store per-question review state (SQLite table): `question_id, note_path, question_text, answer_text, ease_factor, interval, due_date, last_reviewed, review_count`
  - [ ] Implement SM-2 (the classic Anki algorithm) or a simplified variant for scheduling
- [ ] MCP Tools for review flow:
  - [ ] `get_due_questions(topic?, limit?)` — questions due for review today, optionally scoped to a topic
  - [ ] `submit_review(question_id, grade)` — grade (e.g., again/hard/good/easy) updates the schedule via SM-2
  - [ ] `get_topic_mastery(topic)` — aggregate stats: how many questions answered well vs poorly, streaks, weak areas
  - [ ] `cross_question(topic, depth?)` — the "quiz me" entry point: pulls relevant notes, surfaces open questions, and can chain follow-ups based on your answer (this is really an interaction pattern the client LLM drives using `get_notes_by_topic` + `get_due_questions`, with the server just supplying data + tracking state)
- [ ] Session log: track each Q&A session (topic, date, questions asked, self-rated performance) for later review/analytics

### 3.4 Deployment

- [ ] EC2 setup:
  - [ ] Instance sizing (small is fine — t3.small/t3.micro — this is I/O light, not compute heavy, unless running local embeddings)
  - [ ] systemd service for the MCP server (auto-restart on crash/reboot)
  - [ ] Reverse proxy (nginx/Caddy) + TLS if exposing HTTP/SSE endpoint publicly
  - [ ] Security group locked down to your IP or via VPN/SSH tunnel — do not expose the MCP endpoint openly
- [ ] Secrets management: LLM API keys (if server-side question generation), auth tokens — via `.env` + EC2 instance role or a secrets manager, not committed to repo
- [ ] Backups: periodic snapshot of the SQLite review-state DB (this is the one thing that isn't reconstructable from the vault)

---

## 4. Suggested Build Order (Milestones)

1. **M1 — Sync working**: MacBook vault reliably mirrored to EC2 (pick rsync or Syncthing, verify with a health check).
2. **M2 — Read-only MCP server**: `list_notes`, `get_note`, `search_notes` working over stdio locally, then over SSE/HTTP from EC2.
3. **M3 — Semantic/topic search**: `get_notes_by_topic`, embeddings index.
4. **M4 — Review state + SM-2 scheduler**: DB schema, `get_due_questions`, `submit_review`.
5. **M5 — Question generation**: server-side or client-driven generation, cached questions per note.
6. **M6 — Cross-questioning flow**: `cross_question` tool/pattern, topic mastery stats, session logging.
7. **M7 — Hardening**: auth, TLS, systemd, backups, monitoring/logging.

---

## 5. Decisions (locked in)

- [x] **Sync tool: Git.** Vault is a git repo; commit + push from MacBook, pull/webhook on EC2. Simple, versioned, auditable. Note: need a strategy for auto-committing (e.g. a `launchd` job on Mac that commits+pushes on a timer or on file save, since manual `git commit` for a notes vault gets tedious) and auto-pulling on EC2 (`git pull` on a cron/webhook/systemd timer). `.gitignore` for `.obsidian/workspace*.json`, `.trash/`, etc.
- [x] **Language/SDK: TypeScript** (`@modelcontextprotocol/sdk` for Node).
- [x] **Question generation: client-side.** The MCP server does NOT call an LLM itself — it only supplies tools like `get_notes_by_topic` and `get_due_questions`; the connected MCP client's own LLM (Claude, etc.) generates the actual questions from the returned note content. Server just stores/schedules the resulting Q&A pairs. This avoids a second LLM API cost/dependency on the server side.
- [x] **Exposure: public HTTPS with auth.** MCP server runs on EC2 behind nginx/Caddy with TLS (Let's Encrypt), and a bearer-token (or OAuth, if the SDK supports it) auth layer in front of the SSE/HTTP MCP endpoint. Still worth restricting via security group / IP allowlist as defense-in-depth even with auth.
- [x] **Embeddings: local model.** Consistent with keeping question-gen client-side and notes private — no note content should leave the EC2 box for indexing either. Use a small local embedding model via `transformers.js` (e.g. `Xenova/all-MiniLM-L6-v2`) running in the same Node/TypeScript process as the MCP server, storing vectors in SQLite via `sqlite-vec`. Runs fine on a t3.small.
