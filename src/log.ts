type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = ORDER.info;

export function setLogLevel(level: Level | "silent"): void {
  threshold = ORDER[level] ?? ORDER.info;
}

export function log(level: Level, message: string): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
