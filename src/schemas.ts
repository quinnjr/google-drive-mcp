import { z } from "zod";

/** Writable subset of the Drive File resource, plus an escape hatch for anything not modelled. */
export const fileMetadataSchema = z
  .object({
    name: z.string().optional().describe("The name of the file. Not necessarily unique within a folder."),
    mimeType: z
      .string()
      .optional()
      .describe(
        "MIME type of the file. Use 'application/vnd.google-apps.folder' to create a folder, 'application/vnd.google-apps.shortcut' for a shortcut, or a Google Docs type to convert an upload.",
      ),
    description: z.string().optional().describe("A short description of the file."),
    starred: z.boolean().optional().describe("Whether the user has starred the file."),
    trashed: z.boolean().optional().describe("Whether the file has been trashed. Trashed files are deleted after 30 days."),
    parents: z
      .array(z.string())
      .optional()
      .describe("IDs of the parent folders. On create, defaults to the root folder. On update use addParents/removeParents instead."),
    properties: z.record(z.string(), z.string()).optional().describe("Public key/value metadata, visible to all apps."),
    appProperties: z.record(z.string(), z.string()).optional().describe("Private key/value metadata, visible only to the requesting app."),
    folderColorRgb: z.string().optional().describe("Folder colour as a hex string, e.g. '#8f8f8f'."),
    originalFilename: z.string().optional().describe("Original filename of the uploaded content."),
    writersCanShare: z.boolean().optional().describe("Whether writers can change permissions. Not applicable to shared drive items."),
    viewersCanCopyContent: z.boolean().optional().describe("Deprecated; use copyRequiresWriterPermission instead."),
    copyRequiresWriterPermission: z
      .boolean()
      .optional()
      .describe("Whether copy, print and download options are disabled for readers and commenters."),
    inheritedPermissionsDisabled: z.boolean().optional().describe("Whether permission inheritance from the parent is disabled."),
    createdTime: z.string().optional().describe("RFC 3339 creation time. Settable only on create."),
    modifiedTime: z.string().optional().describe("RFC 3339 last-modification time."),
    viewedByMeTime: z.string().optional().describe("RFC 3339 time the file was last viewed by the user."),
    contentHints: z
      .object({
        indexableText: z.string().optional().describe("Text to be indexed for the file to improve full-text queries."),
        thumbnail: z
          .object({
            image: z.string().optional().describe("The thumbnail data, URL-safe base64 encoded (RFC 4648 section 5)."),
            mimeType: z.string().optional().describe("The MIME type of the thumbnail."),
          })
          .optional(),
      })
      .optional()
      .describe("Additional information about the content, not directly derivable from it."),
    contentRestrictions: z
      .array(
        z.object({
          readOnly: z.boolean().optional().describe("Whether the content is read-only (locked)."),
          reason: z.string().optional().describe("Reason for restricting the content. Only settable together with readOnly=true."),
          ownerRestricted: z.boolean().optional().describe("Whether only the owner may modify the restriction."),
          type: z.string().optional().describe("The type of content restriction, e.g. 'globalContentRestriction'."),
        }),
      )
      .optional()
      .describe("Content restrictions, e.g. locking a file to prevent edits."),
    downloadRestrictions: z
      .object({
        itemDownloadRestriction: z
          .object({
            restrictedForReaders: z.boolean().optional(),
            restrictedForWriters: z.boolean().optional(),
          })
          .optional(),
      })
      .optional()
      .describe("Download / copy / print restrictions applied directly to this item."),
    shortcutDetails: z
      .object({
        targetId: z.string().optional().describe("The ID of the file this shortcut points to."),
        targetMimeType: z.string().optional().describe("The MIME type of the target; only used on create."),
      })
      .optional()
      .describe("Shortcut target. Required when mimeType is 'application/vnd.google-apps.shortcut'."),
    id: z.string().optional().describe("Pre-generated file ID (see drive_files_generate_ids). Only honoured on create."),
    driveId: z.string().optional().describe("ID of the shared drive the file resides in. Only honoured on create in some cases."),
    additionalMetadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Any other File resource fields to send verbatim, for API fields not modelled above."),
  })
  .describe("File resource fields to write.");

export type FileMetadata = z.infer<typeof fileMetadataSchema>;

/** Flattens `additionalMetadata` into the request body. */
export function toFileBody(meta: FileMetadata | undefined): Record<string, unknown> {
  if (!meta) return {};
  const { additionalMetadata, ...rest } = meta;
  const body: Record<string, unknown> = { ...additionalMetadata };
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) body[k] = v;
  }
  return body;
}

export const permissionBodySchema = z.object({
  type: z
    .enum(["user", "group", "domain", "anyone"])
    .optional()
    .describe("The grantee type. Required when creating a permission."),
  role: z
    .enum(["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"])
    .optional()
    .describe("The role granted. Required when creating a permission."),
  emailAddress: z.string().optional().describe("Email address of the user or group. Required for type 'user' and 'group'."),
  domain: z.string().optional().describe("The domain. Required for type 'domain'."),
  allowFileDiscovery: z.boolean().optional().describe("For type 'domain' or 'anyone': whether the file is discoverable by search."),
  expirationTime: z.string().optional().describe("RFC 3339 time at which this permission expires."),
  view: z.string().optional().describe("Indicates the view for this permission; only 'published' is supported."),
  pendingOwner: z.boolean().optional().describe("Whether the account is a pending owner. Not populated for shared drive items."),
  inheritedPermissionsDisabled: z.boolean().optional().describe("Whether inherited permissions are disabled on this item."),
});

export const driveBodySchema = z.object({
  name: z.string().optional().describe("The name of the shared drive."),
  themeId: z.string().optional().describe("The ID of the theme, from drive_about_get's driveThemes."),
  colorRgb: z.string().optional().describe("The colour of this shared drive as a hex string, e.g. '#4285f4'."),
  hidden: z.boolean().optional().describe("Whether the shared drive is hidden from the default view."),
  backgroundImageFile: z
    .object({
      id: z.string().optional().describe("ID of an image file in Drive to use as the background."),
      width: z.number().optional().describe("Width of the cropped image, as a fraction of the full image width."),
      xCoordinate: z.number().optional().describe("X coordinate of the upper-left corner of the crop area."),
      yCoordinate: z.number().optional().describe("Y coordinate of the upper-left corner of the crop area."),
    })
    .optional(),
  restrictions: z
    .object({
      adminManagedRestrictions: z.boolean().optional(),
      copyRequiresWriterPermission: z.boolean().optional(),
      domainUsersOnly: z.boolean().optional(),
      driveMembersOnly: z.boolean().optional(),
      sharingFoldersRequiresOrganizerPermission: z.boolean().optional(),
      downloadRestriction: z
        .object({
          restrictedForReaders: z.boolean().optional(),
          restrictedForWriters: z.boolean().optional(),
        })
        .optional(),
    })
    .optional()
    .describe("Restrictions that apply to the whole shared drive."),
});
