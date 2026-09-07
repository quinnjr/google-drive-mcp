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
  lastSeen: number;
}

export interface McpApp {
  app: express.Express;
  /** Stops the idle sweep and closes every live session. */
  shutdown: () => Promise<void>;
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
  return rest.join(" ").trim() || undefined;
}

function googleTokenFrom(req: Request): string | undefined {
  const header = req.headers["x-google-access-token"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || undefined;
}

export function createApp(config: Config, factory: DriveFactory): McpApp {
  const app = express();
  app.disable("x-powered-by");

  const sessions = new Map<string, Session>();

  const dropSession = (id: string, why: string): void => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    log("info", `session ${id} closed (${why})`);
    void session.transport.close().catch(() => undefined);
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - config.sessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) dropSession(id, "idle");
    }
  }, Math.min(config.sessionTtlMs, 60_000));
  sweep.unref();

  const authorized = (req: Request): boolean =>
    !config.authToken || (() => {
      const supplied = bearerFrom(req);
      return supplied !== undefined && safeEqual(supplied, config.authToken as string);
    })();

  // Unauthenticated probes learn only that the process is up; details need the bearer token.
  app.get("/healthz", (req, res) => {
    if (!authorized(req)) {
      res.json({ status: "ok" });
      return;
    }
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      mode: config.stateful ? "stateful" : "stateless",
      sessions: sessions.size,
      maxSessions: config.maxSessions,
    });
  });

  /** Host / Origin validation and bearer auth, applied before any request body is read. */
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (config.allowedHosts.length) {
      const host = req.headers.host ?? "";
      if (!config.allowedHosts.includes(host)) {
        jsonRpcError(res, 403, -32000, `Host header '${host}' is not allowed.`);
        return;
      }
    }
    if (config.allowedOrigins.length) {
      // A missing Origin is rejected too: once an allowlist is configured, every client must
      // identify itself, so a browser cannot slip through by omitting the header.
      const origin = req.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) {
        jsonRpcError(res, 403, -32000, `Origin '${origin ?? "(absent)"}' is not allowed.`);
        return;
      }
    }
    if (config.authToken && !authorized(req)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="google-drive-mcp"');
      jsonRpcError(res, 401, -32001, "Missing or invalid bearer token.");
      return;
    }
    next();
  };

  const jsonParser = express.json({ limit: config.maxRequestBytes });

  /**
   * Runs the JSON body parser and converts its failures into JSON-RPC errors. Express's own
   * error path would answer a malformed body with an HTML stack trace.
   */
  const parseBody = (req: Request, res: Response, next: NextFunction): void => {
    jsonParser(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const e = err as { type?: string; message?: string };
      if (e.type === "entity.too.large") {
        jsonRpcError(res, 413, -32600, `Request body exceeds the ${config.maxRequestBytes}-byte limit.`);
        return;
      }
      jsonRpcError(res, 400, -32700, `Parse error: ${e.message ?? "malformed JSON request body"}`);
    });
  };

  const withGoogleToken = (req: Request, fn: () => Promise<void>): Promise<void> =>
    runWithContext({ googleAccessToken: config.tokenPassthrough ? googleTokenFrom(req) : undefined }, fn);

  async function newSession(): Promise<Session> {
    const server = createServer(config, factory);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: config.stateful ? () => randomUUID() : undefined,
      ...(config.stateful
        ? {
            onsessioninitialized: (sessionId: string) => {
              sessions.set(sessionId, { server, transport, lastSeen: Date.now() });
              log("info", `session ${sessionId} initialized (${sessions.size} live)`);
            },
            onsessionclosed: (sessionId: string) => {
              sessions.delete(sessionId);
              log("info", `session ${sessionId} closed (client DELETE)`);
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
    return { server, transport, lastSeen: Date.now() };
  }

  /** Tears down a transport whose initialize never established a session. */
  async function discardIfUnestablished(session: Session): Promise<void> {
    if (session.transport.sessionId && sessions.has(session.transport.sessionId)) return;
    await session.transport.close().catch(() => undefined);
  }

  app.post(config.mcpPath, guard, parseBody, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (!config.stateful) {
        const session = await newSession();
        try {
          await withGoogleToken(req, () => session.transport.handleRequest(req, res, req.body));
        } finally {
          await session.transport.close().catch(() => undefined);
        }
        return;
      }

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          jsonRpcError(res, 404, -32001, "Unknown or expired session. Re-initialize to obtain a new Mcp-Session-Id.");
          return;
        }
        existing.lastSeen = Date.now();
        await withGoogleToken(req, () => existing.transport.handleRequest(req, res, req.body));
        existing.lastSeen = Date.now();
        return;
      }

      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, "Missing Mcp-Session-Id header; only an initialize request may omit it.");
        return;
      }

      if (sessions.size >= config.maxSessions) {
        jsonRpcError(res, 503, -32000, `Session limit reached (${config.maxSessions}). Try again shortly.`);
        return;
      }

      const session = await newSession();
      try {
        await withGoogleToken(req, () => session.transport.handleRequest(req, res, req.body));
      } finally {
        // A rejected or failed initialize would otherwise strand an McpServer for the process's life.
        await discardIfUnestablished(session);
      }
    } catch (err) {
      log("error", `POST ${config.mcpPath} failed: ${(err as Error).message}`);
      jsonRpcError(res, 500, -32603, "Internal server error.");
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
      session.lastSeen = Date.now();
      await withGoogleToken(req, () => session.transport.handleRequest(req, res));
      session.lastSeen = Date.now();
    } catch (err) {
      log("error", `${req.method} ${config.mcpPath} failed: ${(err as Error).message}`);
      jsonRpcError(res, 500, -32603, "Internal server error.");
    }
  };

  app.get(config.mcpPath, guard, streamOrDelete);
  app.delete(config.mcpPath, guard, streamOrDelete);

  app.use((_req, res) => {
    jsonRpcError(res, 404, -32000, `Not found. The MCP endpoint is ${config.mcpPath}.`);
  });

  return {
    app,
    async shutdown() {
      clearInterval(sweep);
      const live = [...sessions.values()];
      sessions.clear();
      await Promise.all(live.map((s) => s.transport.close().catch(() => undefined)));
    },
  };
}
