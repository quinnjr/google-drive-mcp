import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape, z } from "zod";
import type { Config } from "./config.js";
import type { Drive, DriveFactory } from "./drive.js";
import { log } from "./log.js";
import { describeError, errorResult, ToolInputError } from "./util.js";

export interface ToolContext {
  config: Config;
  drive: () => Promise<Drive>;
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /**
   * The tool changes nothing - neither in Drive nor on the server host. Read-only mode keeps only
   * these, and they are the only tools advertised with readOnlyHint: true.
   */
  readOnly?: boolean;
  /**
   * The tool may irreversibly remove, overwrite or widen access to data. Required on every tool
   * that is not read-only, so the MCP destructiveHint is never left to a guess.
   */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no additional effect. */
  idempotent?: boolean;
  handler: (args: z.core.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Helper that preserves the inferred argument type of each tool's schema. */
export function tool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<ZodRawShape> {
  if (def.readOnly !== true && def.destructive === undefined) {
    throw new Error(`Tool ${def.name} must declare destructive: true or false.`);
  }
  return def as unknown as ToolDef<ZodRawShape>;
}

export function registerTools(server: McpServer, factory: DriveFactory, config: Config, defs: ToolDef[]): string[] {
  const ctx: ToolContext = { config, drive: () => factory.client() };
  const registered: string[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    if (seen.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    seen.add(def.name);
    if (config.readOnly && !def.readOnly) continue;

    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: {
          title: def.title,
          readOnlyHint: def.readOnly === true,
          // Every tool here calls the Google Drive API, so the world it touches is always open.
          // destructiveHint is only meaningful for tools that write.
          openWorldHint: true,
          ...(def.readOnly === true ? {} : { destructiveHint: def.destructive === true }),
          idempotentHint: def.idempotent === true,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          return await def.handler(args as never, ctx);
        } catch (err) {
          const message = describeError(err);
          if (!(err instanceof ToolInputError)) {
            log("warn", `${def.name} failed: ${message}`);
            if (!isApiFailure(err)) log("debug", (err as Error)?.stack ?? String(err));
          }
          return errorResult(message);
        }
      },
    );
    registered.push(def.name);
  }

  return registered;
}

function isApiFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { response?: unknown; status?: unknown };
  return e.response !== undefined || typeof e.status === "number";
}
