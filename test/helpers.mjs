import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/config.js";
import { createApp } from "../dist/http.js";
import { setLogLevel } from "../dist/log.js";

setLogLevel("silent");

/** Every variable loadConfig reads, so a test's environment is fully isolated. */
const CONFIG_ENV = [
  "HOST", "PORT", "MCP_PATH", "MCP_AUTH_TOKEN", "MCP_ALLOWED_HOSTS", "MCP_ALLOWED_ORIGINS",
  "MCP_STATEFUL", "MCP_SESSION_TTL_SECONDS", "MCP_MAX_SESSIONS", "MCP_MAX_REQUEST_BYTES",
  "GOOGLE_TOKEN_PASSTHROUGH", "DRIVE_READ_ONLY", "DRIVE_ALLOW_LOCAL_FILES", "GOOGLE_SCOPES",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_ACCESS_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_SERVICE_ACCOUNT_KEY_JSON", "GOOGLE_IMPERSONATE_SUBJECT",
  "DRIVE_MAX_INLINE_BYTES", "LOG_LEVEL",
];

/** Loads a Config from `env` alone, leaving process.env exactly as it found it. */
export function configFrom(env = {}) {
  const saved = new Map(CONFIG_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of CONFIG_ENV) delete process.env[k];
    Object.assign(process.env, { LOG_LEVEL: "silent", ...env });
    return loadConfig();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Builds a Drive stub whose calls are recorded, so tests can assert on the params sent to Google. */
export function fakeDrive(responses = {}) {
  const calls = [];
  const handler = (path) =>
    async (params, opts) => {
      calls.push({ path, params, opts });
      const canned = responses[path];
      const data = typeof canned === "function" ? canned(params) : (canned ?? { ok: true, path });
      return { data };
    };

  const resource = (name, methods) => Object.fromEntries(methods.map((m) => [m, handler(`${name}.${m}`)]));

  return {
    calls,
    callsTo(path) {
      return calls.filter((c) => c.path === path);
    },
    client: {
      about: resource("about", ["get"]),
      apps: resource("apps", ["get", "list"]),
      changes: resource("changes", ["getStartPageToken", "list", "watch"]),
      channels: resource("channels", ["stop"]),
      files: resource("files", [
        "copy", "create", "delete", "download", "emptyTrash", "export",
        "generateCseToken", "generateIds", "get", "list", "listLabels",
        "modifyLabels", "update", "watch",
      ]),
      permissions: resource("permissions", ["create", "delete", "get", "list", "update"]),
      comments: resource("comments", ["create", "delete", "get", "list", "update"]),
      replies: resource("replies", ["create", "delete", "get", "list", "update"]),
      revisions: resource("revisions", ["delete", "get", "list", "update"]),
      drives: resource("drives", ["create", "delete", "get", "hide", "list", "unhide", "update"]),
      teamdrives: resource("teamdrives", ["create", "delete", "get", "list", "update"]),
      accessproposals: resource("accessproposals", ["get", "list", "resolve"]),
      approvals: resource("approvals", ["approve", "cancel", "comment", "decline", "get", "list", "reassign", "start"]),
      operations: resource("operations", ["get"]),
    },
  };
}

/** Boots the express app on an ephemeral port with a stubbed Drive client. */
export async function startServer(env = {}, responses = {}) {
  const config = configFrom(env);
  const drive = fakeDrive(responses);
  const { app, shutdown } = createApp(config, { client: async () => drive.client });
  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();

  return {
    drive,
    config,
    url: new URL(`http://127.0.0.1:${port}${config.mcpPath}`),
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await shutdown();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

export async function connectClient(url, requestInit) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  await client.connect(transport);
  return client;
}

export function textOf(result) {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
