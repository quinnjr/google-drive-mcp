/** Runtime configuration, resolved once from the environment. */

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off", ""]);

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new Error(`${name} must be one of 1/0/true/false/yes/no/on/off, got ${JSON.stringify(raw)}`);
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const n = Number(value);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function logLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return "info";
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`);
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
  /**
   * Origins accepted in the Origin header. Empty disables the check; when non-empty a request
   * with no Origin header is rejected too, so a browser cannot bypass it by omitting the header.
   */
  allowedOrigins: string[];
  /** Enable Streamable HTTP session management (Mcp-Session-Id). */
  stateful: boolean;
  /** Idle milliseconds after which a session is evicted. */
  sessionTtlMs: number;
  /** Hard cap on concurrent sessions. */
  maxSessions: number;
  /** Maximum accepted JSON request body size, in bytes. */
  maxRequestBytes: number;
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
  /** Max bytes returned inline as base64/text from download, export and resource reads. */
  maxInlineBytes: number;
  logLevel: LogLevel;
}

export function loadConfig(): Config {
  const scopes = list("GOOGLE_SCOPES");
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: int("PORT", 3000, 0, 65535),
    mcpPath: process.env.MCP_PATH ?? "/mcp",
    authToken: process.env.MCP_AUTH_TOKEN || undefined,
    allowedHosts: list("MCP_ALLOWED_HOSTS"),
    allowedOrigins: list("MCP_ALLOWED_ORIGINS"),
    stateful: bool("MCP_STATEFUL", true),
    sessionTtlMs: int("MCP_SESSION_TTL_SECONDS", 1800, 30, 86400) * 1000,
    maxSessions: int("MCP_MAX_SESSIONS", 256, 1, 100000),
    maxRequestBytes: int("MCP_MAX_REQUEST_BYTES", 4 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    tokenPassthrough: bool("GOOGLE_TOKEN_PASSTHROUGH", false),
    readOnly: bool("DRIVE_READ_ONLY", false),
    allowLocalFiles: bool("DRIVE_ALLOW_LOCAL_FILES", false),
    scopes: scopes.length ? scopes : DEFAULT_SCOPES,
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
    maxInlineBytes: int("DRIVE_MAX_INLINE_BYTES", 8 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    logLevel: logLevel(),
  };
}
