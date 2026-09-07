import { z } from "zod";
import type { Config } from "../config.js";
import { tool, type ToolDef } from "../registry.js";
import { assertInlineSize, deliverBinary, mediaInputSchema, resolveMedia, toBuffer } from "../media.js";
import { fileMetadataSchema, toFileBody } from "../schemas.js";
import { clean, jsonResult, pagingParams, parseSize, sharedDriveParams, withCorpusDefaults, withDriveDefaults } from "../util.js";

const labelParams = {
  includeLabels: z.string().optional().describe("Comma-separated label IDs to include in the file's labelInfo."),
  includePermissionsForView: z
    .string()
    .optional()
    .describe("Which additional view's permissions to include. Only 'published' is supported."),
};

const conversionParams = {
  ignoreDefaultVisibility: z
    .boolean()
    .optional()
    .describe("Whether to ignore the domain's default visibility settings for the created file."),
  keepRevisionForever: z
    .boolean()
    .optional()
    .describe("Whether to pin the head revision. Only 200 revisions may be pinned per file."),
  ocrLanguage: z.string().optional().describe("ISO 639-1 language hint for OCR processing during image import."),
};

const channelShape = {
  id: z.string().describe("A UUID or similar unique string identifying this channel."),
  address: z.string().describe("The HTTPS address where notifications are delivered."),
  type: z.string().optional().describe("The delivery mechanism. Defaults to 'web_hook'."),
  token: z.string().optional().describe("Arbitrary string delivered with each notification."),
  expiration: z.string().optional().describe("Unix timestamp in milliseconds, as a string, when the channel expires."),
  params: z.record(z.string(), z.string()).optional().describe("Additional parameters controlling delivery."),
  payload: z.boolean().optional().describe("Whether a payload is wanted in the notification."),
};

/**
 * Writing to the server's filesystem is not a read-only act, so `destinationPath` only exists —
 * and the download tools only lose their readOnlyHint — when DRIVE_ALLOW_LOCAL_FILES is set.
 */
export function destinationParams(config: Config): { destinationPath: z.ZodOptional<z.ZodString> } | Record<string, never> {
  if (!config.allowLocalFiles) return {};
  return {
    destinationPath: z
      .string()
      .optional()
      .describe("Absolute path to write the bytes to on the server host, overwriting any existing file."),
  };
}

export function localFileFlags(config: Config): { readOnly?: true; destructive?: boolean } {
  return config.allowLocalFiles ? { destructive: true } : { readOnly: true };
}

export function filesTools(config: Config): ToolDef[] {
  const dest = destinationParams(config);
  const downloadFlags = localFileFlags(config);

  return [
    tool({
      name: "drive_files_list",
      title: "List / search files",
      description:
        "List or search files and folders. Use `q` for the Drive query language, e.g. \"name contains 'report' and mimeType='application/pdf' and trashed=false\", \"'FOLDER_ID' in parents\", or \"sharedWithMe\". Paginate with pageToken.",
      readOnly: true,
      idempotent: true,
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe(
            "Drive query string. Supported fields include name, fullText, mimeType, modifiedTime, createdTime, parents, owners, writers, readers, starred, trashed, sharedWithMe, properties, appProperties, visibility and shortcutDetails.targetId.",
          ),
        corpora: z
          .enum(["user", "drive", "domain", "allDrives"])
          .optional()
          .describe("Bodies of items to query. 'drive' requires driveId. Prefer 'user' or 'drive' over 'allDrives' for efficiency."),
        driveId: z.string().optional().describe("ID of the shared drive to search when corpora is 'drive'."),
        includeItemsFromAllDrives: z
          .boolean()
          .optional()
          .describe("Whether both My Drive and shared drive items should appear. Defaults to true."),
        orderBy: z
          .string()
          .optional()
          .describe(
            "Comma-separated sort keys: createdTime, folder, modifiedByMeTime, modifiedTime, name, name_natural, quotaBytesUsed, recency, sharedWithMeTime, starred, viewedByMeTime. Append ' desc' to reverse.",
          ),
        spaces: z.string().optional().describe("Comma-separated spaces to query: 'drive' and/or 'appDataFolder'."),
        ...pagingParams,
        ...labelParams,
        ...sharedDriveParams,
        fields: z
          .string()
          .optional()
          .describe("Partial-response selector, e.g. 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)'."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.list(withCorpusDefaults(clean(args)));
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_get",
      title: "Get file metadata",
      description: "Get a file or folder's metadata by ID. Use drive_files_get_content to fetch the bytes instead.",
      readOnly: true,
      idempotent: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        acknowledgeAbuse: z
          .boolean()
          .optional()
          .describe("Acknowledge the risk of downloading known malware or other abusive files."),
        ...labelParams,
        ...sharedDriveParams,
        fields: z.string().optional().describe("Partial-response selector. Use '*' for every field."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.get(withDriveDefaults(clean(args)));
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_get_content",
      title: "Download file content",
      description:
        "Download the binary content of a non-Google-Docs file (alt=media). For Google Docs/Sheets/Slides use drive_files_export instead. Text content is returned as text, images as an image, and anything else as base64.",
      idempotent: true,
      ...downloadFlags,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        acknowledgeAbuse: z.boolean().optional().describe("Acknowledge the risk of downloading known malware."),
        ...dest,
        ...sharedDriveParams,
      },
      async handler(args, ctx) {
        const { destinationPath, ...rest } = args as typeof args & { destinationPath?: string };
        const drive = await ctx.drive();
        const meta = await drive.files.get(
          withDriveDefaults({
            fileId: args.fileId,
            fields: "name,mimeType,size",
            supportsAllDrives: args.supportsAllDrives,
          }),
        );
        // Refuse oversized content before transferring it, when the size is known up front.
        const declared = parseSize(meta.data.size);
        if (!destinationPath && declared !== undefined) assertInlineSize(declared, ctx.config);

        const res = await drive.files.get(withDriveDefaults({ ...clean(rest), alt: "media" }), {
          responseType: "arraybuffer",
        });
        const bytes = toBuffer(res.data);
        const mimeType = meta.data.mimeType ?? "application/octet-stream";
        return deliverBinary(bytes, mimeType, `googledrive:///${args.fileId}`, ctx.config, destinationPath);
      },
    }),

    tool({
      name: "drive_files_export",
      title: "Export a Google Workspace file",
      description:
        "Export a Google Docs, Sheets, Slides or Drawings file to another format, e.g. 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'. Exports are limited to 10 MB; use drive_files_download for larger ones.",
      idempotent: true,
      ...downloadFlags,
      inputSchema: {
        fileId: z.string().describe("The ID of the Google Workspace file."),
        mimeType: z.string().describe("The target MIME type. See drive_about_get's exportFormats for what each type supports."),
        ...dest,
      },
      async handler(args, ctx) {
        const { destinationPath } = args as typeof args & { destinationPath?: string };
        const drive = await ctx.drive();
        const res = await drive.files.export(
          { fileId: args.fileId, mimeType: args.mimeType },
          { responseType: "arraybuffer" },
        );
        const bytes = toBuffer(res.data);
        return deliverBinary(bytes, args.mimeType, `googledrive:///${args.fileId}`, ctx.config, destinationPath);
      },
    }),

    tool({
      name: "drive_files_download",
      title: "Start a long-running download",
      description:
        "Start a long-running download of a file or its exported form, returning an Operation. Poll it with drive_operations_get; the finished operation carries a downloadUri. This is the route for exports over 10 MB.",
      readOnly: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file to download."),
        mimeType: z
          .string()
          .optional()
          .describe("Export MIME type for Google Workspace files. Omit for binary files, which download as-is."),
        revisionId: z.string().optional().describe("The revision to download. Not supported for Google Workspace files."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.download(clean(args));
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_create",
      title: "Create a file or folder",
      description:
        "Create a new file, folder or shortcut. Set metadata.mimeType to 'application/vnd.google-apps.folder' for a folder. To convert an upload, put the Google type in metadata.mimeType and the source type in media.mimeType (e.g. metadata 'application/vnd.google-apps.spreadsheet' with media 'text/csv').",
      destructive: false,
      inputSchema: {
        metadata: fileMetadataSchema.optional().describe("File metadata: name, parents, mimeType, description, properties, ..."),
        media: mediaInputSchema.optional(),
        useContentAsIndexableText: z.boolean().optional().describe("Whether to use the uploaded content as indexable text."),
        ...conversionParams,
        ...labelParams,
        ...sharedDriveParams,
        fields: z.string().optional().describe("Partial-response selector for the created file."),
      },
      async handler(args, ctx) {
        const { metadata, media, ...rest } = args;
        const body = toFileBody(metadata);
        const resolved = await resolveMedia(media, ctx.config, body.mimeType as string | undefined);
        try {
          if (resolved && !body.name && resolved.suggestedName) body.name = resolved.suggestedName;
          const drive = await ctx.drive();
          const res = await drive.files.create({
            ...withDriveDefaults(clean(rest)),
            requestBody: body,
            ...(resolved ? { media: { mimeType: resolved.mimeType, body: resolved.body } } : {}),
          });
          return jsonResult(res.data);
        } finally {
          resolved?.dispose();
        }
      },
    }),

    tool({
      name: "drive_files_update",
      title: "Update a file",
      description:
        "Update a file's metadata and/or content. Only the fields present in `metadata` are changed. Move a file by setting addParents/removeParents; trash it by setting metadata.trashed=true.",
      destructive: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file to update."),
        metadata: fileMetadataSchema.optional().describe("Fields to change. Omitted fields are left alone."),
        media: mediaInputSchema.optional().describe("New content, replacing the current content. Omit to change metadata only."),
        addParents: z.string().optional().describe("Comma-separated parent folder IDs to add."),
        removeParents: z.string().optional().describe("Comma-separated parent folder IDs to remove."),
        useContentAsIndexableText: z.boolean().optional().describe("Whether to use the uploaded content as indexable text."),
        ...conversionParams,
        ...labelParams,
        ...sharedDriveParams,
        fields: z.string().optional().describe("Partial-response selector for the updated file."),
      },
      async handler(args, ctx) {
        const { metadata, media, ...rest } = args;
        const body = toFileBody(metadata);
        const resolved = await resolveMedia(media, ctx.config, body.mimeType as string | undefined);
        try {
          const drive = await ctx.drive();
          const res = await drive.files.update({
            ...withDriveDefaults(clean(rest)),
            requestBody: body,
            ...(resolved ? { media: { mimeType: resolved.mimeType, body: resolved.body } } : {}),
          });
          return jsonResult(res.data);
        } finally {
          resolved?.dispose();
        }
      },
    }),

    tool({
      name: "drive_files_copy",
      title: "Copy a file",
      description: "Create a copy of a file. Folders cannot be copied. Supply metadata to rename the copy or place it in a different parent.",
      destructive: false,
      inputSchema: {
        fileId: z.string().describe("The ID of the file to copy."),
        metadata: fileMetadataSchema.optional().describe("Metadata for the copy, e.g. name and parents."),
        ...conversionParams,
        ...labelParams,
        ...sharedDriveParams,
        fields: z.string().optional().describe("Partial-response selector for the new file."),
      },
      async handler(args, ctx) {
        const { metadata, ...rest } = args;
        const drive = await ctx.drive();
        const res = await drive.files.copy({
          ...withDriveDefaults(clean(rest)),
          requestBody: toFileBody(metadata),
        });
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_delete",
      title: "Permanently delete a file",
      description:
        "Permanently delete a file without moving it to the trash; if it is a folder, all descendants are deleted too. This cannot be undone. To trash instead, call drive_files_update with metadata.trashed=true.",
      destructive: true,
      idempotent: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file to delete permanently."),
        ...sharedDriveParams,
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        await drive.files.delete(withDriveDefaults(clean(args)));
        return jsonResult({ deleted: true, fileId: args.fileId });
      },
    }),

    tool({
      name: "drive_files_empty_trash",
      title: "Empty the trash",
      description: "Permanently delete every trashed file owned by the user, or every trashed item in a shared drive. This cannot be undone.",
      destructive: true,
      idempotent: true,
      inputSchema: {
        driveId: z.string().optional().describe("Empty the trash of this shared drive instead of the user's own trash."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        await drive.files.emptyTrash(clean(args));
        return jsonResult({ emptied: true, ...(args.driveId ? { driveId: args.driveId } : {}) });
      },
    }),

    tool({
      name: "drive_files_generate_ids",
      title: "Generate file IDs",
      description: "Generate a set of file IDs that can be supplied as metadata.id on create or copy requests, making uploads safely retryable.",
      readOnly: true,
      inputSchema: {
        count: z.number().int().min(1).max(1000).optional().describe("How many IDs to return. Defaults to 10."),
        space: z.enum(["drive", "appDataFolder"]).optional().describe("The space the IDs are for. Defaults to 'drive'."),
        type: z.enum(["files", "shortcuts"]).optional().describe("The type of item the IDs are for. Defaults to 'files'."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.generateIds(clean(args));
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_list_labels",
      title: "List labels on a file",
      description: "List the Drive labels applied to a file.",
      readOnly: true,
      idempotent: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        maxResults: z.number().int().min(1).max(100).optional().describe("Maximum labels to return per page. Defaults to 100."),
        pageToken: z.string().optional().describe("Token for the next page of labels."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.listLabels(clean(args));
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_modify_labels",
      title: "Modify labels on a file",
      description: "Add, update or remove Drive labels and their field values on a file, in a single atomic request.",
      destructive: true,
      inputSchema: {
        fileId: z.string().describe("The ID of the file."),
        labelModifications: z
          .array(
            z.object({
              labelId: z.string().describe("The ID of the label to add, update or remove."),
              removeLabel: z.boolean().optional().describe("Remove the label entirely from the file."),
              fieldModifications: z
                .array(
                  z.object({
                    fieldId: z.string().describe("The ID of the field to change."),
                    setTextValues: z.array(z.string()).optional().describe("Replacement values for a text field."),
                    setSelectionValues: z.array(z.string()).optional().describe("Replacement choice IDs for a selection field."),
                    setIntegerValues: z.array(z.string()).optional().describe("Replacement values for an integer field, as strings."),
                    setDateValues: z.array(z.string()).optional().describe("Replacement values for a date field, as yyyy-mm-dd."),
                    setUserValues: z.array(z.string()).optional().describe("Replacement user email addresses for a user field."),
                    unsetValues: z.boolean().optional().describe("Clear the field's values."),
                  }),
                )
                .optional()
                .describe("Field-level changes within the label."),
            }),
          )
          .describe("The label modifications to apply."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.modifyLabels({
          fileId: args.fileId,
          requestBody: { labelModifications: args.labelModifications },
        });
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_watch",
      title: "Watch a file",
      description: "Subscribe to change notifications for a single file. Stop the channel with drive_channels_stop.",
      destructive: false,
      inputSchema: {
        fileId: z.string().describe("The ID of the file to watch."),
        acknowledgeAbuse: z.boolean().optional().describe("Acknowledge the risk of downloading known malware."),
        ...labelParams,
        ...sharedDriveParams,
        channel: z.object(channelShape).describe("The notification channel to open."),
      },
      async handler(args, ctx) {
        const { channel, ...rest } = args;
        const drive = await ctx.drive();
        const res = await drive.files.watch({
          ...withDriveDefaults(clean(rest)),
          requestBody: clean({ type: "web_hook", ...channel }),
        });
        return jsonResult(res.data);
      },
    }),

    tool({
      name: "drive_files_generate_cse_token",
      title: "Generate a CSE token",
      description:
        "Generate a short-lived token for a client-side-encrypted (CSE) file, used by the Drive CSE wrapping/unwrapping flow. Only meaningful for Workspace domains with client-side encryption configured.",
      readOnly: true,
      inputSchema: {
        fileId: z.string().optional().describe("The ID of an existing CSE file the token is scoped to."),
        parent: z.string().optional().describe("The ID of the parent folder, when generating a token for a not-yet-created file."),
      },
      async handler(args, ctx) {
        const drive = await ctx.drive();
        const res = await drive.files.generateCseToken(clean(args));
        return jsonResult(res.data);
      },
    }),
  ];
}
