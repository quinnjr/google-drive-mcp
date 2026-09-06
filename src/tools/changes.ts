import { z } from "zod";
import { tool, type ToolDef } from "../registry.js";
import { clean, jsonResult, pagingParams, sharedDriveParams, withDriveDefaults } from "../util.js";

const channelShape = {
  id: z.string().describe("A UUID or similar unique string that identifies this channel."),
  address: z.string().describe("The HTTPS address where notifications are delivered."),
  type: z.string().optional().describe("The notification delivery mechanism. Defaults to 'web_hook'."),
  token: z.string().optional().describe("Arbitrary string delivered to the target address with each notification."),
  expiration: z
    .string()
    .optional()
    .describe("Unix timestamp in milliseconds, as a string, at which the notification channel expires."),
  params: z.record(z.string(), z.string()).optional().describe("Additional parameters controlling delivery behaviour."),
  payload: z.boolean().optional().describe("Whether a payload is wanted in the notification."),
  resourceId: z.string().optional().describe("Opaque ID identifying the watched resource (returned by watch)."),
  resourceUri: z.string().optional().describe("Version-specific identifier for the watched resource."),
};

export const changesTools: ToolDef[] = [
  tool({
    name: "drive_changes_get_start_page_token",
    title: "Get change start page token",
    description:
      "Get the starting pageToken for listing future changes. Call this once, store the token, then feed it to drive_changes_list.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      driveId: z.string().optional().describe("Return the token for this shared drive rather than the user's corpus."),
      ...sharedDriveParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.changes.getStartPageToken(withDriveDefaults(clean(args)));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_changes_list",
    title: "List changes",
    description:
      "List changes for a user or shared drive since a page token. The response's newStartPageToken (present on the last page) is the token to use for the next poll.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      pageToken: z
        .string()
        .describe("Token identifying where to start listing changes, from drive_changes_get_start_page_token or a prior newStartPageToken/nextPageToken."),
      driveId: z.string().optional().describe("List changes for this shared drive only."),
      includeCorpusRemovals: z
        .boolean()
        .optional()
        .describe("Include changes where the file was removed from the corpus (e.g. access lost)."),
      includeItemsFromAllDrives: z
        .boolean()
        .optional()
        .describe("Include both My Drive and shared drive items. Defaults to true."),
      includeRemoved: z.boolean().optional().describe("Include changes indicating items removed or trashed."),
      includeLabels: z.string().optional().describe("Comma-separated label IDs to include in the labelInfo of each file."),
      includePermissionsForView: z.string().optional().describe("Which additional view's permissions to include. Only 'published' is supported."),
      pageSize: pagingParams.pageSize,
      restrictToMyDrive: z.boolean().optional().describe("Restrict results to changes inside the My Drive hierarchy."),
      spaces: z.string().optional().describe("Comma-separated spaces to query: 'drive' and/or 'appDataFolder'."),
      ...sharedDriveParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const params = withDriveDefaults(clean(args));
      if (params.includeItemsFromAllDrives === undefined) params.includeItemsFromAllDrives = true;
      const res = await drive.changes.list(params);
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_changes_watch",
    title: "Watch changes",
    description:
      "Subscribe to change notifications for a user or shared drive; Drive POSTs notifications to the channel address. Returns the channel resource, including the resourceId needed to stop it.",
    inputSchema: {
      pageToken: z.string().describe("Token identifying where to start watching changes."),
      driveId: z.string().optional().describe("Watch changes for this shared drive only."),
      includeCorpusRemovals: z.boolean().optional().describe("Include changes where the file was removed from the corpus."),
      includeItemsFromAllDrives: z.boolean().optional().describe("Include both My Drive and shared drive items."),
      includeRemoved: z.boolean().optional().describe("Include changes indicating items removed or trashed."),
      includeLabels: z.string().optional().describe("Comma-separated label IDs to include in labelInfo."),
      includePermissionsForView: z.string().optional().describe("Which additional view's permissions to include."),
      pageSize: pagingParams.pageSize,
      restrictToMyDrive: z.boolean().optional().describe("Restrict to the My Drive hierarchy."),
      spaces: z.string().optional().describe("Comma-separated spaces: 'drive' and/or 'appDataFolder'."),
      ...sharedDriveParams,
      channel: z.object(channelShape).describe("The notification channel to open."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { channel, ...rest } = args;
      const drive = await ctx.drive();
      const res = await drive.changes.watch({
        ...withDriveDefaults(clean(rest)),
        requestBody: clean({ type: "web_hook", ...channel }),
      });
      return jsonResult(res.data);
    },
  }),
];

export const channelsTools: ToolDef[] = [
  tool({
    name: "drive_channels_stop",
    title: "Stop a notification channel",
    description: "Stop watching a resource through a notification channel opened by drive_changes_watch or drive_files_watch.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      id: z.string().describe("The channel ID supplied when the channel was created."),
      resourceId: z.string().describe("The opaque resource ID returned when the channel was created."),
      token: z.string().optional().describe("The channel token, if one was set."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      await drive.channels.stop({ requestBody: clean(args) });
      return jsonResult({ stopped: true, id: args.id, resourceId: args.resourceId });
    },
  }),
];
