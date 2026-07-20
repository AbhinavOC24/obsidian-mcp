import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerQuestionTools } from "./tools/questions.js";
import { registerReviewTools } from "./tools/review.js";

// ─── Server factory ───────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "obsidian-mcp",
    version: "1.0.0",
  });

  // ─── Register all tools ───────────────────────────────────────────────────

  // Vault reading tools (M2/M3)
  registerVaultTools(server);

  // Question management (M5)
  registerQuestionTools(server);

  // Active recall / SM-2 review (M4/M6)
  registerReviewTools(server);

  return server;
}
