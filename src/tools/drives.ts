import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool, type ToolDef } from "../registry.js";
import { driveBodySchema } from "../schemas.js";
import { clean, jsonResult, pagingParams100, permissionWriteParams } from "../util.js";

export const drivesTools: ToolDef[] = [
  tool({
    name: "drive_drives_list",
    title: "List shared drives",
    description: "List the shared drives the user is a member of, or all shared drives in the domain with useDomainAdminAccess.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      q: z
        .string()
        .optional()
        .describe("Query string for searching shared drives, e.g. \"name contains 'Marketing'\" or 'hidden = false'."),
      ...pagingParams100,
      ...permissionWriteParams,
      fields: z.string().optional().describe("Partial-response selector, e.g. 'drives(id,name),nextPageToken'."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.drives.list(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_drives_get",
    title: "Get a shared drive",
    description: "Get a shared drive's metadata, including its capabilities and restrictions.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      driveId: z.string().describe("The ID of the shared drive."),
      ...permissionWriteParams,
      fields: z.string().optional().describe("Partial-response selector. Use '*' for every field."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.drives.get(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_drives_create",
    title: "Create a shared drive",
    description:
      "Create a new shared drive. Pass your own requestId to make retries idempotent — repeating a call with the same ID returns the drive created the first time. When omitted a fresh ID is generated per call, so a retried call creates a second drive.",
    destructive: false,
    inputSchema: {
      drive: driveBodySchema.describe("The shared drive to create; name is required."),
      requestId: z
        .string()
        .optional()
        .describe("Idempotency key for this creation. Reuse it across retries; a fresh UUID is generated when omitted, which does NOT deduplicate retries."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const client = await ctx.drive();
      const res = await client.drives.create({
        requestId: args.requestId ?? randomUUID(),
        ...(args.fields ? { fields: args.fields } : {}),
        requestBody: clean(args.drive),
      });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_drives_update",
    title: "Update a shared drive",
    description: "Update a shared drive's name, theme, background or restrictions.",
    destructive: true,
    inputSchema: {
      driveId: z.string().describe("The ID of the shared drive."),
      drive: driveBodySchema.describe("The fields to change."),
      ...permissionWriteParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { drive: body, ...rest } = args;
      const client = await ctx.drive();
      const res = await client.drives.update({ ...clean(rest), requestBody: clean(body) });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_drives_delete",
    title: "Delete a shared drive",
    description:
      "Permanently delete a shared drive. It must be empty unless allowItemDeletion is true, which requires domain administrator access and deletes all of its contents.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      driveId: z.string().describe("The ID of the shared drive to delete."),
      allowItemDeletion: z
        .boolean()
        .optional()
        .describe("Delete any items still inside the drive. Requires useDomainAdminAccess=true."),
      ...permissionWriteParams,
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      await drive.drives.delete(clean(args));
      return jsonResult({ deleted: true, driveId: args.driveId });
    },
  }),
  tool({
    name: "drive_drives_hide",
    title: "Hide a shared drive",
    description: "Hide a shared drive from the user's default view.",
    idempotent: true,
    destructive: false,
    inputSchema: {
      driveId: z.string().describe("The ID of the shared drive to hide."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.drives.hide(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_drives_unhide",
    title: "Unhide a shared drive",
    description: "Restore a hidden shared drive to the user's default view.",
    idempotent: true,
    destructive: false,
    inputSchema: {
      driveId: z.string().describe("The ID of the shared drive to unhide."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.drives.unhide(clean(args));
      return jsonResult(res.data);
    },
  }),
];

/** Deprecated Team Drive endpoints, kept for completeness. Prefer the drives.* tools. */
export const teamdrivesTools: ToolDef[] = [
  tool({
    name: "drive_teamdrives_list",
    title: "List team drives (deprecated)",
    description: "Deprecated Team Drives endpoint. Use drive_drives_list instead.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      q: z.string().optional().describe("Query string for searching team drives."),
      ...pagingParams100,
      ...permissionWriteParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.teamdrives.list(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_teamdrives_get",
    title: "Get a team drive (deprecated)",
    description: "Deprecated Team Drives endpoint. Use drive_drives_get instead.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      teamDriveId: z.string().describe("The ID of the team drive."),
      ...permissionWriteParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.teamdrives.get(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_teamdrives_create",
    title: "Create a team drive (deprecated)",
    description: "Deprecated Team Drives endpoint. Use drive_drives_create instead.",
    destructive: false,
    inputSchema: {
      teamDrive: driveBodySchema.describe("The team drive to create; name is required."),
      requestId: z.string().optional().describe("Idempotency key. Reuse it across retries; a fresh UUID is generated when omitted."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.teamdrives.create({
        requestId: args.requestId ?? randomUUID(),
        ...(args.fields ? { fields: args.fields } : {}),
        requestBody: clean(args.teamDrive),
      });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_teamdrives_update",
    title: "Update a team drive (deprecated)",
    description: "Deprecated Team Drives endpoint. Use drive_drives_update instead.",
    destructive: true,
    inputSchema: {
      teamDriveId: z.string().describe("The ID of the team drive."),
      teamDrive: driveBodySchema.describe("The fields to change."),
      ...permissionWriteParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { teamDrive, ...rest } = args;
      const drive = await ctx.drive();
      const res = await drive.teamdrives.update({ ...clean(rest), requestBody: clean(teamDrive) });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_teamdrives_delete",
    title: "Delete a team drive (deprecated)",
    description: "Deprecated Team Drives endpoint. Use drive_drives_delete instead.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      teamDriveId: z.string().describe("The ID of the team drive to delete."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      await drive.teamdrives.delete(clean(args));
      return jsonResult({ deleted: true, teamDriveId: args.teamDriveId });
    },
  }),
];
