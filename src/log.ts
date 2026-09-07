import type { LogLevel } from "./config.js";

const ORDER = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
  }),
);

const DEFAULT = ORDER.info as number;
let threshold = DEFAULT;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level] ?? DEFAULT;
}

export function log(level: Exclude<LogLevel, "silent">, message: string): void {
  const weight = ORDER[level];
  if (weight === undefined || weight < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
