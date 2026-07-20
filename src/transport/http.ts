import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ─── Auth middleware ───────────────────────────────────────────────────────────

function bearerAuth(req: Request, res: Response, next: express.NextFunction): void {
  const token = process.env["MCP_AUTH_TOKEN"];
  if (!token) {
    // No token configured — allow all (dev mode)
    next();
    return;
  }

  const authHeader = req.headers["authorization"] ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (provided !== token) {
    res.status(401).json({ error: "Unauthorized — invalid or missing bearer token" });
    return;
  }
  next();
}

// ─── HTTP/SSE server ──────────────────────────────────────────────────────────

export function createHttpServer(mcpServer: McpServer): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "obsidian-mcp", time: new Date().toISOString() });
  });

  // Active SSE transports by session ID
  const transports = new Map<string, SSEServerTransport>();

  // SSE endpoint — client connects here to receive MCP messages
  app.get("/sse", bearerAuth, (req, res) => {
    const transport = new SSEServerTransport("/message", res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    res.on("close", () => {
      transports.delete(sessionId);
    });

    mcpServer.connect(transport).catch((err: unknown) => {
      console.error("[http] SSE connection error:", err);
    });
  });

  // Message endpoint — client POSTs MCP messages here
  app.post("/message", bearerAuth, async (req, res) => {
    const sessionId = req.query["sessionId"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId query parameter" });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: `No SSE session found for sessionId: ${sessionId}` });
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      console.error("[http] Error handling message:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}

export function startHttpServer(mcpServer: McpServer): void {
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const app = createHttpServer(mcpServer);

  app.listen(port, () => {
    console.error(`[http] Obsidian MCP server listening on http://0.0.0.0:${port}`);
    console.error(`[http] SSE endpoint: http://0.0.0.0:${port}/sse`);
    console.error(
      process.env["MCP_AUTH_TOKEN"]
        ? "[http] Bearer-token auth: ENABLED"
        : "[http] Bearer-token auth: DISABLED (set MCP_AUTH_TOKEN to enable)"
    );
  });
}
