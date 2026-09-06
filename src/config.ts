/** Runtime configuration, resolved once from the environment. */

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.appdata",
];

export interface Config {
  host: string;
  port: number;
  mcpPath: string;
  /** Static bearer token required on every MCP request, if set. */
  authToken: string | undefined;
  /** Hosts accepted in the Host header (DNS-rebinding protection). Empty disables the check. */
  allowedHosts: string[];
  /** Origins accepted in the Origin header. Empty disables the check. */
  allowedOrigins: string[];
  /** Enable Streamable HTTP session management (Mcp-Session-Id). */
  stateful: boolean;
  /** Accept a caller-supplied Google access token via X-Google-Access-Token. */
  tokenPassthrough: boolean;
  /** Refuse write/destructive tools. */
  readOnly: boolean;
  /** Allow tools that read from / write to the server's local filesystem. */
  allowLocalFiles: boolean;
  scopes: string[];
  oauth: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    refreshToken: string | undefined;
    accessToken: string | undefined;
  };
  serviceAccount: {
    keyFile: string | undefined;
    keyJson: string | undefined;
    subject: string | undefined;
  };
  /** Max bytes returned inline as base64 from download/export tools. */
  maxInlineBytes: number;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: int("PORT", 3000),
    mcpPath: process.env.MCP_PATH ?? "/mcp",
    authToken: process.env.MCP_AUTH_TOKEN || undefined,
    allowedHosts: list("MCP_ALLOWED_HOSTS"),
    allowedOrigins: list("MCP_ALLOWED_ORIGINS"),
    stateful: bool("MCP_STATEFUL", true),
    tokenPassthrough: bool("GOOGLE_TOKEN_PASSTHROUGH", false),
    readOnly: bool("DRIVE_READ_ONLY", false),
    allowLocalFiles: bool("DRIVE_ALLOW_LOCAL_FILES", false),
    scopes: list("GOOGLE_SCOPES").length ? list("GOOGLE_SCOPES") : DEFAULT_SCOPES,
    oauth: {
      clientId: process.env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN || undefined,
      accessToken: process.env.GOOGLE_ACCESS_TOKEN || undefined,
    },
    serviceAccount: {
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
      keyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON || undefined,
      subject: process.env.GOOGLE_IMPERSONATE_SUBJECT || undefined,
    },
    maxInlineBytes: int("DRIVE_MAX_INLINE_BYTES", 8 * 1024 * 1024),
    logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) ?? "info",
  };
}
