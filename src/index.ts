#!/usr/bin/env node
import { AuthProvider } from "./auth.js";
import { loadConfig } from "./config.js";
import { DriveFactory } from "./drive.js";
import { createApp } from "./http.js";
import { log, setLogLevel } from "./log.js";
import { buildTools, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const auth = new AuthProvider(config);
  const factory = new DriveFactory(auth);
  const { app, shutdown } = createApp(config, factory);

  const tools = buildTools(config);
  const toolCount = config.readOnly ? tools.filter((t) => t.readOnly).length : tools.length;

  const server = app.listen(config.port, config.host, () => {
    log("info", `${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.host}:${config.port}${config.mcpPath}`);
    log("info", `transport: streamable-http (${config.stateful ? "stateful" : "stateless"})`);
    log("info", `credentials: ${auth.describe()}`);
    log("info", `tools: ${toolCount}${config.readOnly ? " (read-only mode)" : ""}`);
    if (!config.authToken) log("warn", "MCP_AUTH_TOKEN is not set; the endpoint accepts unauthenticated requests.");
    if (config.allowLocalFiles) log("warn", "DRIVE_ALLOW_LOCAL_FILES is on; clients can read and overwrite files on this host.");
  });

  let shuttingDown = false;
  const stop = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `${signal} received, shutting down`);
    const forced = setTimeout(() => process.exit(1), 5000);
    forced.unref();
    server.close(() => {
      void shutdown().finally(() => {
        clearTimeout(forced);
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  log("error", `fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
