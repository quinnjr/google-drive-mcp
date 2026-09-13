/** Runtime configuration, resolved from the environment and, optionally, libsecret. */

import { credentialsFromKeyring, type KeyringCredentials } from "./keyring.js";
import { log } from "./log.js";

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

/** Reads and validates LOG_LEVEL alone, so callers can configure logging before any other work. */
export function logLevelFromEnv(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return "info";
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`);
}

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.appdata",
];

/** Where a group of credentials was resolved from, for the startup banner. */
export type CredentialSource = "none" | "env" | "libsecret" | "env+libsecret";

interface ResolvedField {
  value: string | undefined;
  fromEnv: boolean;
  fromKeyring: boolean;
}

/** The environment wins; libsecret only contributes a field the environment left blank. */
function resolveField(envValue: string | undefined, keyringValue: string | undefined): ResolvedField {
  return {
    value: envValue || keyringValue || undefined,
    fromEnv: Boolean(envValue),
    fromKeyring: Boolean(keyringValue) && !envValue,
  };
}

function sourceOf(fields: ResolvedField[]): CredentialSource {
  const fromEnv = fields.some((field) => field.fromEnv);
  const fromKeyring = fields.some((field) => field.fromKeyring);
  if (fromEnv && fromKeyring) return "env+libsecret";
  if (fromKeyring) return "libsecret";
  if (fromEnv) return "env";
  return "none";
}

function oauthEnvFromProcess(): Record<string, string | undefined> {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || undefined,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || undefined,
    accessToken: process.env.GOOGLE_ACCESS_TOKEN || undefined,
  };
}

function serviceAccountEnvFromProcess(): Record<string, string | undefined> {
  return {
    keyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON || undefined,
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
  };
}

/**
 * Whether libsecret could still change the resolved credentials. A usable env credential wins
 * anyway, and an env service account beats a libsecret key when no oauth credential is present.
 * An access token stands alone; a refresh token needs its client id and secret to be usable.
 */
function needsKeyring(
  oauthEnv: Record<string, string | undefined>,
  serviceAccountEnv: Record<string, string | undefined>,
): boolean {
  const oauthFromEnv = Object.values(oauthEnv).some(Boolean);
  const oauthComplete = oauthEnv.refreshToken
    ? Boolean(oauthEnv.clientId && oauthEnv.clientSecret)
    : Boolean(oauthEnv.accessToken);
  const serviceAccountFromEnv = Boolean(serviceAccountEnv.keyJson || serviceAccountEnv.keyFile);
  return !oauthComplete && !(serviceAccountFromEnv && !oauthFromEnv);
}

/** True when the environment alone cannot satisfy the credentials. */
export function keyringNeeded(): boolean {
  return needsKeyring(oauthEnvFromProcess(), serviceAccountEnvFromProcess());
}

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
    source: CredentialSource;
  };
  serviceAccount: {
    keyFile: string | undefined;
    keyJson: string | undefined;
    subject: string | undefined;
    source: CredentialSource;
  };
  /** Max bytes returned inline as base64/text from download, export and resource reads. */
  maxInlineBytes: number;
  logLevel: LogLevel;
}

/**
 * Builds a Config from the environment plus the supplied libsecret credentials. Pure with respect
 * to its arguments; resolveConfig wires in the actual keyring read.
 */
export function loadConfig(keyring: KeyringCredentials = {}): Config {
  // Validate the plain environment first, so a misconfigured value aborts before any keyring work.
  const host = process.env.HOST ?? "127.0.0.1";
  const port = int("PORT", 3000, 0, 65535);
  const mcpPath = process.env.MCP_PATH ?? "/mcp";
  const authToken = process.env.MCP_AUTH_TOKEN || undefined;
  const allowedHosts = list("MCP_ALLOWED_HOSTS");
  const allowedOrigins = list("MCP_ALLOWED_ORIGINS");
  const stateful = bool("MCP_STATEFUL", true);
  const sessionTtlMs = int("MCP_SESSION_TTL_SECONDS", 1800, 30, 86400) * 1000;
  const maxSessions = int("MCP_MAX_SESSIONS", 256, 1, 100000);
  const maxRequestBytes = int("MCP_MAX_REQUEST_BYTES", 4 * 1024 * 1024, 1024, 512 * 1024 * 1024);
  const tokenPassthrough = bool("GOOGLE_TOKEN_PASSTHROUGH", false);
  const readOnly = bool("DRIVE_READ_ONLY", false);
  const allowLocalFiles = bool("DRIVE_ALLOW_LOCAL_FILES", false);
  const maxInlineBytes = int("DRIVE_MAX_INLINE_BYTES", 8 * 1024 * 1024, 1, 1024 * 1024 * 1024);
  const level = logLevelFromEnv();
  const scopesFromEnv = list("GOOGLE_SCOPES");

  const oauthEnv = oauthEnvFromProcess();
  const serviceAccountEnv = serviceAccountEnvFromProcess();

  const clientId = resolveField(oauthEnv.clientId, keyring.clientId);
  const clientSecret = resolveField(oauthEnv.clientSecret, keyring.clientSecret);
  const refreshToken = resolveField(oauthEnv.refreshToken, keyring.refreshToken);
  const accessToken = resolveField(oauthEnv.accessToken, keyring.accessToken);
  const oauthSource = sourceOf([clientId, clientSecret, refreshToken, accessToken]);
  if (oauthSource === "env+libsecret") {
    log(
      "warn",
      "oauth credentials are split between the environment and libsecret; verify the client id, secret and token belong to the same OAuth client",
    );
  }

  // An env key file must not be shadowed by a libsecret JSON key: AuthProvider prefers keyJson over
  // keyFile, so only fall back to a libsecret key when the environment supplied neither.
  const envHasServiceAccountKey = Boolean(serviceAccountEnv.keyJson || serviceAccountEnv.keyFile);
  const keyJson = resolveField(
    serviceAccountEnv.keyJson,
    envHasServiceAccountKey ? undefined : keyring.serviceAccountKey,
  );
  const keyFile = resolveField(serviceAccountEnv.keyFile, undefined);

  return {
    host,
    port,
    mcpPath,
    authToken,
    allowedHosts,
    allowedOrigins,
    stateful,
    sessionTtlMs,
    maxSessions,
    maxRequestBytes,
    tokenPassthrough,
    readOnly,
    allowLocalFiles,
    scopes: scopesFromEnv.length ? scopesFromEnv : DEFAULT_SCOPES,
    oauth: {
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      refreshToken: refreshToken.value,
      accessToken: accessToken.value,
      source: oauthSource,
    },
    serviceAccount: {
      keyFile: keyFile.value,
      keyJson: keyJson.value,
      subject: process.env.GOOGLE_IMPERSONATE_SUBJECT || undefined,
      source: sourceOf([keyJson, keyFile]),
    },
    maxInlineBytes,
    logLevel: level,
  };
}

export interface CredentialDeps {
  needed: () => boolean;
  read: () => Promise<KeyringCredentials>;
}

const DEFAULT_CREDENTIAL_DEPS: CredentialDeps = { needed: keyringNeeded, read: credentialsFromKeyring };

/**
 * Resolves the full config, reading libsecret only when the environment cannot satisfy the
 * credentials itself. Kept separate from loadConfig so the keyring I/O and the env-only merge can
 * each be tested in isolation.
 */
export async function resolveConfig(deps: Partial<CredentialDeps> = {}): Promise<Config> {
  const { needed, read } = { ...DEFAULT_CREDENTIAL_DEPS, ...deps };
  const keyring = needed() ? await read() : {};
  return loadConfig(keyring);
}
