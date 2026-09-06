#!/usr/bin/env node
import { AuthProvider } from "./auth.js";
import { loadConfig } from "./config.js";
import { DriveFactory } from "./drive.js";
import { createApp } from "./http.js";
import { log, setLogLevel } from "./log.js";
import { allTools, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const auth = new AuthProvider(config);
  const factory = new DriveFactory(auth);
  const app = createApp(config, factory);

  const toolCount = config.readOnly ? allTools.filter((t) => t.readOnly).length : allTools.length;

  const server = app.listen(config.port, config.host, () => {
    log("info", `${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.host}:${config.port}${config.mcpPath}`);
    log("info", `transport: streamable-http (${config.stateful ? "stateful" : "stateless"})`);
    log("info", `credentials: ${auth.describe()}`);
    log("info", `tools: ${toolCount}${config.readOnly ? " (read-only mode)" : ""}`);
    if (!config.authToken) log("warn", "MCP_AUTH_TOKEN is not set; the endpoint accepts unauthenticated requests.");
  });

  const shutdown = (signal: string): void => {
    log("info", `${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log("error", `fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
