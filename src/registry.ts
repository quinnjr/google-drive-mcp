import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape, z } from "zod";
import type { Config } from "./config.js";
import type { Drive, DriveFactory } from "./drive.js";
import { describeError, errorResult } from "./util.js";

export interface ToolContext {
  config: Config;
  drive: () => Promise<Drive>;
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** Tool does not modify anything. Read-only mode keeps only these. */
  readOnly?: boolean;
  /** Tool may irreversibly remove or overwrite data. */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no additional effect. */
  idempotent?: boolean;
  /** Tool reaches beyond Google Drive (local filesystem, arbitrary URLs). */
  openWorld?: boolean;
  handler: (args: z.core.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Helper that preserves the inferred argument type of each tool's schema. */
export function tool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<ZodRawShape> {
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
          destructiveHint: def.destructive === true,
          idempotentHint: def.idempotent === true,
          openWorldHint: def.openWorld === true,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          return await def.handler(args as never, ctx);
        } catch (err) {
          return errorResult(describeError(err));
        }
      },
    );
    registered.push(def.name);
  }

  return registered;
}
