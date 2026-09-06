import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { DriveFactory } from "./drive.js";
import { runWithContext } from "./context.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { log } from "./log.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearerFrom(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const value = rest.join(" ").trim();
  return value || undefined;
}

function googleTokenFrom(req: Request): string | undefined {
  const header = req.headers["x-google-access-token"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}

export function createApp(config: Config, factory: DriveFactory): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64mb" }));

  const sessions = new Map<string, Session>();

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      sessions: sessions.size,
    });
  });

  // DNS-rebinding protection: reject unexpected Host / Origin headers.
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (config.allowedHosts.length) {
      const host = req.headers.host ?? "";
      if (!config.allowedHosts.includes(host)) {
        jsonRpcError(res, 403, -32000, `Host header '${host}' is not allowed.`);
        return;
      }
    }
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) {
      jsonRpcError(res, 403, -32000, `Origin '${origin}' is not allowed.`);
      return;
    }
    if (config.authToken) {
      const supplied = bearerFrom(req);
      if (!supplied || !safeEqual(supplied, config.authToken)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="google-drive-mcp"');
        jsonRpcError(res, 401, -32001, "Missing or invalid bearer token.");
        return;
      }
    }
    if (config.tokenPassthrough && !googleTokenFrom(req)) {
      log("debug", "request without X-Google-Access-Token; falling back to server credentials");
    }
    next();
  };

  const withGoogleToken = (req: Request, fn: () => Promise<void>): Promise<void> =>
    runWithContext({ googleAccessToken: config.tokenPassthrough ? googleTokenFrom(req) : undefined }, fn);

  async function newSession(): Promise<Session> {
    const { server } = createServer(config, factory);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: config.stateful ? () => randomUUID() : undefined,
      ...(config.stateful
        ? {
            onsessioninitialized: (sessionId: string) => {
              sessions.set(sessionId, { server, transport });
              log("info", `session initialized: ${sessionId}`);
            },
            onsessionclosed: (sessionId: string) => {
              sessions.delete(sessionId);
              log("info", `session closed: ${sessionId}`);
            },
          }
        : {}),
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      void server.close().catch(() => undefined);
    };

    await server.connect(transport);
    return { server, transport };
  }

  app.post(config.mcpPath, guard, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (!config.stateful) {
        const session = await newSession();
        res.on("close", () => {
          void session.transport.close().catch(() => undefined);
        });
        await withGoogleToken(req, () => session.transport.handleRequest(req, res, req.body));
        return;
      }

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          jsonRpcError(res, 404, -32001, "Unknown or expired session. Re-initialize to obtain a new Mcp-Session-Id.");
          return;
        }
        await withGoogleToken(req, () => existing.transport.handleRequest(req, res, req.body));
        return;
      }

      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, "Missing Mcp-Session-Id header; only an initialize request may omit it.");
        return;
      }

      const session = await newSession();
      await withGoogleToken(req, () => session.transport.handleRequest(req, res, req.body));
    } catch (err) {
      log("error", `POST ${config.mcpPath} failed: ${(err as Error).message}`);
      jsonRpcError(res, 500, -32603, `Internal server error: ${(err as Error).message}`);
    }
  });

  const streamOrDelete = async (req: Request, res: Response): Promise<void> => {
    if (!config.stateful) {
      res.setHeader("Allow", "POST");
      jsonRpcError(res, 405, -32000, "This server runs in stateless mode; only POST is supported.");
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      jsonRpcError(res, 404, -32001, "Unknown or expired session.");
      return;
    }
    try {
      await withGoogleToken(req, () => session.transport.handleRequest(req, res));
    } catch (err) {
      log("error", `${req.method} ${config.mcpPath} failed: ${(err as Error).message}`);
      jsonRpcError(res, 500, -32603, `Internal server error: ${(err as Error).message}`);
    }
  };

  app.get(config.mcpPath, guard, streamOrDelete);
  app.delete(config.mcpPath, guard, streamOrDelete);

  app.use((_req, res) => {
    jsonRpcError(res, 404, -32000, `Not found. The MCP endpoint is ${config.mcpPath}.`);
  });

  return app;
}
