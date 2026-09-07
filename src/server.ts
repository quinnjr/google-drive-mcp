import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { DriveFactory } from "./drive.js";
import { registerTools, type ToolDef } from "./registry.js";
import { assertInlineSize, isTextual, toBuffer } from "./media.js";
import { log } from "./log.js";
import { describeError, parseSize } from "./util.js";
import { aboutTools, appsTools } from "./tools/about.js";
import { changesTools, channelsTools } from "./tools/changes.js";
import { commentsTools, repliesTools } from "./tools/comments.js";
import { drivesTools, teamdrivesTools } from "./tools/drives.js";
import { filesTools } from "./tools/files.js";
import { permissionsTools } from "./tools/permissions.js";
import { accessProposalsTools, approvalsTools, operationsTools } from "./tools/proposals.js";
import { revisionsTools } from "./tools/revisions.js";

export const SERVER_NAME = "google-drive-mcp";
export const SERVER_VERSION = "1.0.0";

/**
 * The full tool set. Two families vary with configuration — the download tools only offer a
 * server-side destinationPath when local file access is enabled — so this is a function, not a
 * constant.
 */
export function buildTools(config: Config): ToolDef[] {
  return [
    ...aboutTools,
    ...appsTools,
    ...changesTools,
    ...channelsTools,
    ...filesTools(config),
    ...permissionsTools,
    ...commentsTools,
    ...repliesTools,
    ...revisionsTools(config),
    ...drivesTools,
    ...accessProposalsTools,
    ...approvalsTools,
    ...operationsTools,
    ...teamdrivesTools,
  ];
}

/** Upper bound on files enumerated by resources/list, so an enormous Drive cannot stall a client. */
const RESOURCE_LIST_LIMIT = 1000;

/** Google Workspace types have no downloadable bytes; these are the export targets used for resource reads. */
const EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

export function createServer(config: Config, factory: DriveFactory): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Full Google Drive v3 access. Search with drive_files_list using the Drive query language; read metadata with " +
        "drive_files_get, bytes with drive_files_get_content, and Google Docs/Sheets/Slides with drive_files_export. " +
        "Create and modify with drive_files_create / drive_files_update, share with drive_permissions_create. " +
        "Every list tool paginates via pageToken, and most accept a `fields` partial-response selector — use it to keep " +
        "responses small. File and folder IDs are the 33-character strings in Drive URLs.",
      capabilities: { logging: {} },
    },
  );

  registerTools(server, factory, config, buildTools(config));

  server.registerResource(
    "drive-file",
    new ResourceTemplate("googledrive:///{fileId}", {
      list: async () => {
        const drive = await factory.client();
        const resources: { uri: string; name: string; mimeType?: string; description?: string }[] = [];
        let pageToken: string | undefined;

        // Page through, so a large Drive is not silently truncated to the first 100 entries.
        do {
          const res = await drive.files.list({
            pageSize: 100,
            orderBy: "recency desc",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            fields: "nextPageToken,files(id,name,mimeType,description)",
            q: "trashed = false",
            ...(pageToken ? { pageToken } : {}),
          });
          for (const f of res.data.files ?? []) {
            resources.push({
              uri: `googledrive:///${f.id}`,
              name: f.name ?? f.id ?? "untitled",
              mimeType: f.mimeType ?? undefined,
              description: f.description ?? undefined,
            });
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken && resources.length < RESOURCE_LIST_LIMIT);

        if (pageToken) {
          log("info", `resources/list truncated at ${resources.length} files; more remain in Drive`);
        }
        return { resources };
      },
    }),
    {
      title: "Google Drive file",
      description:
        "Read a Drive file by ID as googledrive:///FILE_ID. Google Workspace documents are exported to text; binary files are returned as base64.",
    },
    async (uri, variables) => {
      const fileId = String(Array.isArray(variables.fileId) ? variables.fileId[0] : variables.fileId);
      try {
        const drive = await factory.client();
        const meta = await drive.files.get({ fileId, fields: "name,mimeType,size", supportsAllDrives: true });
        const mimeType = meta.data.mimeType ?? "application/octet-stream";
        const exportType = EXPORT_AS[mimeType];

        // Binary files declare their size up front; refuse oversized reads before transferring.
        const declared = parseSize(meta.data.size);
        if (!exportType && declared !== undefined) assertInlineSize(declared, config, true);

        const res = exportType
          ? await drive.files.export({ fileId, mimeType: exportType }, { responseType: "arraybuffer" })
          : await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });

        const bytes = toBuffer(res.data);
        assertInlineSize(bytes.byteLength, config, true);

        const effectiveType = exportType ?? mimeType;
        if (isTextual(effectiveType)) {
          return { contents: [{ uri: uri.href, mimeType: effectiveType, text: bytes.toString("utf8") }] };
        }
        return { contents: [{ uri: uri.href, mimeType: effectiveType, blob: bytes.toString("base64") }] };
      } catch (err) {
        // Surface the reason: a revoked token must not look like an empty file.
        const message = describeError(err);
        log("warn", `resource read failed for ${fileId}: ${message}`);
        throw new Error(message);
      }
    },
  );

  return server;
}
