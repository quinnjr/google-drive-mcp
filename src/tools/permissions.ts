import { z } from "zod";
import { tool, type ToolDef } from "../registry.js";
import { permissionBodySchema } from "../schemas.js";
import { clean, jsonResult, pagingParams, permissionWriteParams, sharedDriveParams, withDriveDefaults } from "../util.js";

export const permissionsTools: ToolDef[] = [
  tool({
    name: "drive_permissions_list",
    title: "List permissions",
    description: "List the permissions on a file or shared drive.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file or shared drive."),
      includePermissionsForView: z.string().optional().describe("Which additional view's permissions to include. Only 'published' is supported."),
      ...pagingParams,
      ...permissionWriteParams,
      ...sharedDriveParams,
      fields: z.string().optional().describe("Partial-response selector, e.g. 'permissions(id,type,role,emailAddress),nextPageToken'."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.permissions.list(withDriveDefaults(clean(args)));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_permissions_get",
    title: "Get a permission",
    description: "Get a single permission by ID from a file or shared drive.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file or shared drive."),
      permissionId: z.string().describe("The ID of the permission."),
      ...permissionWriteParams,
      ...sharedDriveParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.permissions.get(withDriveDefaults(clean(args)));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_permissions_create",
    title: "Share a file",
    description:
      "Grant access to a file or shared drive. Set permission.type ('user', 'group', 'domain' or 'anyone') and permission.role. Use type 'anyone' with role 'reader' to create a public link.",
    destructive: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file or shared drive."),
      permission: permissionBodySchema.describe("The permission to create; type and role are required."),
      emailMessage: z.string().optional().describe("Custom message included in the notification email."),
      sendNotificationEmail: z
        .boolean()
        .optional()
        .describe("Whether to send a notification email. Defaults to true for user/group grants; must be true when granting ownership."),
      transferOwnership: z
        .boolean()
        .optional()
        .describe("Whether to transfer ownership to the grantee. Required (true) when role is 'owner'."),
      moveToNewOwnersRoot: z
        .boolean()
        .optional()
        .describe("On an ownership transfer, move the item to the new owner's My Drive root."),
      enforceExpansiveAccess: z.boolean().optional().describe("Whether the request should enforce expansive access rules."),
      ...permissionWriteParams,
      ...sharedDriveParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { permission, ...rest } = args;
      const drive = await ctx.drive();
      const res = await drive.permissions.create({
        ...withDriveDefaults(clean(rest)),
        requestBody: clean(permission),
      });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_permissions_update",
    title: "Update a permission",
    description: "Change an existing permission's role, expiration or ownership status.",
    destructive: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file or shared drive."),
      permissionId: z.string().describe("The ID of the permission to update."),
      permission: permissionBodySchema.describe("The fields to change, typically role and/or expirationTime."),
      removeExpiration: z.boolean().optional().describe("Whether to remove the expiration date."),
      transferOwnership: z.boolean().optional().describe("Whether to transfer ownership to the grantee."),
      enforceExpansiveAccess: z.boolean().optional().describe("Whether the request should enforce expansive access rules."),
      ...permissionWriteParams,
      ...sharedDriveParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { permission, ...rest } = args;
      const drive = await ctx.drive();
      const res = await drive.permissions.update({
        ...withDriveDefaults(clean(rest)),
        requestBody: clean(permission),
      });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_permissions_delete",
    title: "Revoke a permission",
    description: "Revoke access by deleting a permission from a file or shared drive.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file or shared drive."),
      permissionId: z.string().describe("The ID of the permission to delete."),
      enforceExpansiveAccess: z.boolean().optional().describe("Whether the request should enforce expansive access rules."),
      ...permissionWriteParams,
      ...sharedDriveParams,
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      await drive.permissions.delete(withDriveDefaults(clean(args)));
      return jsonResult({ deleted: true, fileId: args.fileId, permissionId: args.permissionId });
    },
  }),
];
