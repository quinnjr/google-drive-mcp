import { z } from "zod";
import type { Config } from "../config.js";
import { tool, type ToolDef } from "../registry.js";
import { assertInlineSize, deliverBinary, toBuffer } from "../media.js";
import { clean, jsonResult, pagingParams, parseSize } from "../util.js";
import { destinationParams, localFileFlags } from "./files.js";

export function revisionsTools(config: Config): ToolDef[] {
  return [
    tool({
      name: "drive_revisions_list",
      title: "List revisions",
      description: "List a file's revision history.",
      readOnly: true,
      idempotent: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        ...pagingParams,
        fields: z.string().optional().describe("Partial-response selector, e.g. 'revisions(id,modifiedTime,size,keepForever)'."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.revisions.list(clean(args));
        return jsonResult(res.data);
      },
    }),
    tool({
      name: "drive_revisions_get",
      title: "Get a revision",
      description: "Get a revision's metadata by ID.",
      readOnly: true,
      idempotent: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        revisionId: z.string().describe("The ID of the revision, or 'head' for the current one."),
        acknowledgeAbuse: z.boolean().optional().describe("Acknowledge the risk of downloading known malware."),
        fields: z.string().optional().describe("Partial-response selector. Use '*' for every field."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.revisions.get(clean(args));
        return jsonResult(res.data);
      },
    }),
    tool({
      name: "drive_revisions_get_content",
      title: "Download revision content",
      description:
        "Download the bytes of a specific revision of a binary file (alt=media). Google Workspace files do not support this; use their revision exportLinks instead.",
      idempotent: true,
      ...localFileFlags(config),
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        revisionId: z.string().describe("The ID of the revision."),
        acknowledgeAbuse: z.boolean().optional().describe("Acknowledge the risk of downloading known malware."),
        ...destinationParams(config),
      },
      async handler(args, ctx) {
        const { destinationPath, ...rest } = args as typeof args & { destinationPath?: string };
        const drive = await ctx.drive();
        const meta = await drive.revisions.get({
          fileId: args.fileId,
          revisionId: args.revisionId,
          fields: "mimeType,size",
        });
        const declared = parseSize(meta.data.size);
        if (!destinationPath && declared !== undefined) assertInlineSize(declared, ctx.config);

        const res = await drive.revisions.get({ ...clean(rest), alt: "media" }, { responseType: "arraybuffer" });
        const bytes = toBuffer(res.data);
        return deliverBinary(
          bytes,
          meta.data.mimeType ?? "application/octet-stream",
          `googledrive:///${args.fileId}/revisions/${args.revisionId}`,
          ctx.config,
          destinationPath,
        );
      },
    }),
    tool({
      name: "drive_revisions_update",
      title: "Update a revision",
      description: "Update a revision's keepForever pin or its publishing settings (Google Workspace files only, for the publish fields).",
      destructive: false,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        revisionId: z.string().describe("The ID of the revision."),
        keepForever: z
          .boolean()
          .optional()
          .describe("Pin the revision so it is never auto-purged. At most 200 revisions per file may be pinned."),
        published: z.boolean().optional().describe("Whether this revision is published (Google Workspace files only)."),
        publishAuto: z.boolean().optional().describe("Whether subsequent revisions are automatically republished."),
        publishedOutsideDomain: z.boolean().optional().describe("Whether the published revision is visible outside the domain."),
        fields: z.string().optional().describe("Partial-response selector."),
      },
      async handler(args, ctx) {
        const { fileId, revisionId, fields, ...body } = args;
        const drive = await ctx.drive();
        const res = await drive.revisions.update(clean({ fileId, revisionId, fields, requestBody: clean(body) }));
        return jsonResult(res.data);
      },
    }),
    tool({
      name: "drive_revisions_delete",
      title: "Delete a revision",
      description:
        "Permanently delete a file version. Only files with binary content stored in Drive support this, and the head revision cannot be deleted.",
      destructive: true,
      idempotent: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        revisionId: z.string().describe("The ID of the revision to delete."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        await drive.revisions.delete(clean(args));
        return jsonResult({ deleted: true, ...args });
      },
    }),
  ];
}
