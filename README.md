# obsidian-mcp

A TypeScript [MCP](https://modelcontextprotocol.io/) server that exposes your Obsidian vault to any MCP-compatible client (Claude Desktop, Claude Code, etc.) with **full-text + semantic search** and **Anki-style spaced-repetition active recall**.

---

## Features

| Capability | Tools |
|---|---|
| **Vault reading** | `list_notes`, `get_note`, `get_recent_notes`, `get_backlinks`, `get_vault_stats` |
| **Search** | `search_notes` (hybrid FTS5 + semantic), `get_notes_by_topic` |
| **Active recall** | `cross_question`, `get_due_questions`, `submit_review`, `get_topic_mastery` |
| **Question store** | `add_questions`, `list_questions`, `delete_question` |

- **Local embeddings** — `all-MiniLM-L6-v2` via `@xenova/transformers`. No note content leaves the machine.
- **SQLite** — FTS5 full-text index + embedding vectors (pure-JS cosine similarity fallback if `sqlite-vec` is unavailable).
- **Git sync** — vault mirrored from MacBook → EC2 via git; health status reported in `get_vault_stats`.
- **SM-2 scheduler** — classic SuperMemo-2 algorithm for spaced repetition.
- **stdio + HTTP/SSE** transports — stdio for Claude Desktop, SSE for remote EC2 access.

---

## Quick Start (local / Claude Desktop)

```bash
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/obsidian-mcp.git
cd obsidian-mcp
npm install

# If on Node 25+ (no prebuilt better-sqlite3 binary yet), build from source:
npm run rebuild:sqlite

# 2. Build
npm run build

# 3. Copy and edit .env
cp .env.example .env
# Set VAULT_PATH to your Obsidian vault directory

# 4. Run (stdio mode)
VAULT_PATH=/path/to/your/vault npm start
```

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | ✅ | — | Absolute path to Obsidian vault |
| `TRANSPORT` | No | `stdio` | `stdio` or `http` |
| `PORT` | No | `3000` | HTTP port (when `TRANSPORT=http`) |
| `MCP_AUTH_TOKEN` | No* | — | Bearer token for HTTP auth (*required in production) |
| `DB_PATH` | No | `./data/obsidian-mcp.db` | SQLite database path |
| `LOG_LEVEL` | No | `info` | `debug` \| `info` \| `warn` \| `error` |
| `TRANSFORMERS_CACHE` | No | `~/.cache/huggingface` | Where to cache the embedding model |

---

## EC2 Deployment

### 1. Set up EC2 → GitHub SSH access

```bash
# On EC2: generate a deploy key (read-only) for the vault repo
ssh-keygen -t ed25519 -C "ec2-vault-deploy" -f ~/.ssh/vault_deploy_key -N ""
cat ~/.ssh/vault_deploy_key.pub
# Add the public key to your vault repo as a read-only deploy key on GitHub
```

### 2. Run the bootstrap script

```bash
# On EC2 (as ec2-user):
export REPO_URL="https://github.com/YOUR_USERNAME/obsidian-mcp.git"
export VAULT_REPO="git@github.com:YOUR_USERNAME/obsidian-vault.git"
bash scripts/setup-ec2.sh
```

The script:
- Installs Node.js 20 via nvm
- Clones vault + server repos
- Builds TypeScript
- Creates `.env` with a randomly generated `MCP_AUTH_TOKEN`
- Installs and starts all systemd units (MCP server + 5-min vault sync timer)

### 3. Set up nginx + TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Copy config and replace domain
sudo cp nginx/obsidian-mcp.conf /etc/nginx/sites-available/obsidian-mcp
sudo ln -s /etc/nginx/sites-available/obsidian-mcp /etc/nginx/sites-enabled/
# Edit: sed -i 's/mcp.yourdomain.com/your.actual.domain/g' /etc/nginx/sites-available/obsidian-mcp

sudo certbot --nginx -d your.actual.domain
sudo systemctl reload nginx
```

### 4. Mac → EC2 vault sync (auto git push)

```bash
# Edit VAULT_DIR in the plist first
nano launchd/com.obsidian.sync.plist

# Install
cp launchd/com.obsidian.sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.obsidian.sync.plist

# Verify
launchctl list | grep obsidian
tail -f /tmp/obsidian-sync.log
```

### 5. Claude Desktop → EC2 (HTTP/SSE)

```json
{
  "mcpServers": {
    "obsidian-remote": {
      "url": "https://your.actual.domain/sse",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

---

## Active Recall Workflow

```
User: "Quiz me on machine learning"
  → cross_question(topic="machine learning", depth="medium")
  ← Server returns: relevant notes + due questions

Claude reads notes, asks due questions first, then generates new ones
  → submit_review(question_id=42, grade="good")
  ← SM-2 schedules next review in N days

  → add_questions(note_path="ML/Backprop.md", questions=[...])
  ← Stored for future review sessions

User: "How am I doing on ML?"
  → get_topic_mastery(topic="machine learning")
  ← Stats: 23 questions, 18 reviewed, avg ease 2.3, 3 weak areas
```

---

## MCP Tools Reference

### Vault Tools

| Tool | Description |
|---|---|
| `list_notes` | List notes, filter by `tag` and/or `folder` |
| `get_note` | Get full note content by path or title |
| `search_notes` | Hybrid FTS + semantic search (`mode`: hybrid/fulltext/semantic) |
| `get_notes_by_topic` | Semantic + tag search for a topic |
| `get_backlinks` | Find notes linking to a note via `[[wikilinks]]` |
| `get_recent_notes` | N most recently modified notes |
| `get_vault_stats` | Note count, tags, folders, git sync status |

### Review Tools

| Tool | Description |
|---|---|
| `cross_question` | Quiz-me entry point: returns notes + due questions for a topic |
| `get_due_questions` | Questions due for review today (SM-2 scheduled) |
| `submit_review` | Record grade (again/hard/good/easy), update SM-2 schedule |
| `get_topic_mastery` | Aggregate stats: reviewed, overdue, avg ease, weak areas |

### Question Tools

| Tool | Description |
|---|---|
| `add_questions` | Store LLM-generated questions for a note |
| `list_questions` | List all questions, filtered by note path |
| `delete_question` | Remove a question from the review queue |

---

## Architecture

```
obsidian-mcp/
├── src/
│   ├── index.ts              # Entry point (stdio / HTTP)
│   ├── server.ts             # McpServer factory
│   ├── db/
│   │   ├── schema.ts         # SQLite init (FTS5, embeddings, SM-2 state)
│   │   └── sm2.ts            # SM-2 algorithm
│   ├── embeddings/
│   │   └── model.ts          # @xenova/transformers wrapper + cosine fallback
│   ├── vault/
│   │   ├── parser.ts         # Markdown → Note (gray-matter, wikilinks, tags)
│   │   ├── indexer.ts        # Full scan + chokidar file watcher
│   │   └── search.ts         # FTS5 + semantic + hybrid + topic search
│   ├── tools/
│   │   ├── vault.ts          # Vault reading tools
│   │   ├── questions.ts      # Question CRUD tools
│   │   └── review.ts         # Active recall + SM-2 tools
│   └── transport/
│       └── http.ts           # Express SSE + bearer auth
├── systemd/                  # EC2 systemd units + timer
├── launchd/                  # Mac launchd plist (auto git push)
├── nginx/                    # nginx reverse proxy config
└── scripts/
    └── setup-ec2.sh          # EC2 one-shot bootstrap
```

---

## Notes on sqlite-vec

The server automatically attempts to load the `sqlite-vec` native extension for vector operations. If it fails to load (e.g. on some Apple Silicon configs without Rosetta), it falls back seamlessly to a **pure-JS cosine similarity** implementation. This fallback works well for vaults up to ~5,000 notes; for larger vaults, ensure `sqlite-vec` is available.

```bash
# Test if sqlite-vec loads on your system
node -e "require('sqlite-vec')"
```

---

## Backups

The SQLite DB (`data/obsidian-mcp.db`) holds your review state — this is the **only** data that can't be reconstructed from the vault. Back it up:

```bash
# Manual backup
cp data/obsidian-mcp.db "data/obsidian-mcp-$(date +%Y%m%d).db"

# Cron backup on EC2 (add to crontab)
0 3 * * * sqlite3 /home/ec2-user/obsidian-mcp/data/obsidian-mcp.db ".backup '/home/ec2-user/backups/obsidian-mcp-$(date +\%Y\%m\%d).db'"
```

---

## License

MIT
