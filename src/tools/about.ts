import { z } from "zod";
import { tool, type ToolDef } from "../registry.js";
import { clean, jsonResult } from "../util.js";

export const aboutTools: ToolDef[] = [
  tool({
    name: "drive_about_get",
    title: "Get Drive account info",
    description:
      "Get information about the authenticated user, their storage quota, and Drive capabilities (import/export MIME type maps, max upload size, folder colours).",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fields: z
        .string()
        .optional()
        .describe("Partial-response selector. Defaults to '*' (everything), since about.get requires an explicit fields value."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.about.get(clean({ fields: args.fields ?? "*" }));
      return jsonResult(res.data);
    },
  }),
];

export const appsTools: ToolDef[] = [
  tool({
    name: "drive_apps_get",
    title: "Get an installed app",
    description: "Get a specific Drive app installed by the authenticated user, by app ID.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      appId: z.string().describe("The ID of the app."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.apps.get(clean({ appId: args.appId, fields: args.fields }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_apps_list",
    title: "List installed apps",
    description: "List the Drive apps installed by the authenticated user. Requires the drive.apps.readonly scope.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      appFilterExtensions: z
        .string()
        .optional()
        .describe("Comma-separated file extensions; limits results to apps that can open those extensions."),
      appFilterMimeTypes: z
        .string()
        .optional()
        .describe("Comma-separated MIME types; limits results to apps that can open those MIME types."),
      languageCode: z.string().optional().describe("BCP 47 language code, e.g. 'en-US'."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.apps.list(clean(args));
      return jsonResult(res.data);
    },
  }),
];
