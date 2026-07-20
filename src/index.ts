#!/usr/bin/env node
/**
 * Obsidian MCP Server — Entry Point
 *
 * Environment variables:
 *   VAULT_PATH      Path to the Obsidian vault (required)
 *   TRANSPORT       "stdio" (default) | "http"
 *   PORT            HTTP port when TRANSPORT=http (default 3000)
 *   MCP_AUTH_TOKEN  Bearer token for HTTP auth
 *   DB_PATH         SQLite database path (default ./data/obsidian-mcp.db)
 *   LOG_LEVEL       debug | info | warn | error (default info)
 */

import "node:process";
import path from "node:path";
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { getDb } from "./db/schema.js";
import { getIndexer } from "./vault/indexer.js";
import { warmUpEmbeddings } from "./embeddings/model.js";
import { startHttpServer } from "./transport/http.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate vault path
  const vaultPath = process.env["VAULT_PATH"];
  if (!vaultPath) {
    console.error("[fatal] VAULT_PATH environment variable is not set.");
    console.error("  Set it to the absolute path of your Obsidian vault.");
    process.exit(1);
  }

  const resolvedVault = path.resolve(vaultPath);
  if (!fs.existsSync(resolvedVault)) {
    console.error(`[fatal] Vault path does not exist: ${resolvedVault}`);
    process.exit(1);
  }

  console.error(`[init] Vault: ${resolvedVault}`);

  // Initialise database
  getDb();
  console.error("[init] Database ready.");

  // Start warming up the embedding model in the background
  warmUpEmbeddings();

  // Index vault (full scan on startup; incremental via file watcher after)
  const indexer = getIndexer(resolvedVault);
  const { indexed, skipped } = await indexer.indexAll();
  console.error(`[init] Vault indexed: ${indexed} new/changed, ${skipped} unchanged.`);

  // Start file watcher
  indexer.startWatching();

  // Create MCP server
  const mcpServer = createMcpServer();

  // Start transport
  const transport = process.env["TRANSPORT"] ?? "stdio";

  if (transport === "http") {
    startHttpServer(mcpServer);
  } else {
    // stdio transport — used for local dev and Claude Desktop
    const stdioTransport = new StdioServerTransport();
    await mcpServer.connect(stdioTransport);
    console.error("[init] Obsidian MCP server running on stdio.");
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[shutdown] Closing...");
    await indexer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[fatal] Unhandled error during startup:", err);
  process.exit(1);
});
