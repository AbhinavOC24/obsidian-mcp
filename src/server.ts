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

  // ─── Live Logging Wrapper ──────────────────────────────────────────────────
  // Intercepts all tool registrations to log calls to stderr live.
  // Must use console.error so that it doesn't corrupt stdout in stdio mode.
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = (name: string, schema: any, handler: any) => {
    return originalRegisterTool(name, schema, async (args: any) => {
      console.error(`[mcp] 🔌 Tool invoked: "${name}" | args: ${JSON.stringify(args)}`);
      try {
        const result = await handler(args);
        console.error(`[mcp] ✅ Tool "${name}" succeeded`);
        return result;
      } catch (err: any) {
        console.error(`[mcp] ❌ Tool "${name}" failed: ${err?.message || err}`);
        throw err;
      }
    });
  };

  // ─── Register all tools ───────────────────────────────────────────────────

  // Vault reading tools (M2/M3)
  registerVaultTools(server);

  // Question management (M5)
  registerQuestionTools(server);

  // Active recall / SM-2 review (M4/M6)
  registerReviewTools(server);

  return server;
}
