import { createReadStream, promises as fs } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { ToolInputError } from "./util.js";

/** Google Workspace types name a conversion target; they are never a valid upload Content-Type. */
const WORKSPACE_PREFIX = "application/vnd.google-apps.";

export const mediaInputSchema = z
  .object({
    text: z.string().optional().describe("File content as UTF-8 text. Defaults the upload type to text/plain."),
    base64: z.string().optional().describe("File content as a standard base64-encoded string (use for binary content)."),
    localPath: z
      .string()
      .optional()
      .describe(
        "Absolute path to a file on the machine running this server. Only permitted when the server is started with DRIVE_ALLOW_LOCAL_FILES=1.",
      ),
    mimeType: z
      .string()
      .optional()
      .describe(
        "Content-Type of the uploaded bytes - the *source* format, not the conversion target. To convert on upload, put the Google type in metadata.mimeType and the source type here (e.g. metadata 'application/vnd.google-apps.spreadsheet' with media 'text/csv').",
      ),
  })
  .describe("The bytes to upload. Provide exactly one of text, base64 or localPath.");

export type MediaInput = z.infer<typeof mediaInputSchema>;

export interface ResolvedMedia {
  mimeType: string;
  body: Readable;
  /** Suggested name when the caller did not provide one. */
  suggestedName?: string;
  /** Releases the file descriptor if the request never consumed the stream. */
  dispose: () => void;
}

const BASE64 = /^[A-Za-z0-9+/\r\n\t ]*={0,2}$/;

function decodeBase64(input: string): Buffer {
  const compact = input.replace(/[\r\n\t ]/g, "");
  if (!BASE64.test(input) || compact.length % 4 !== 0) {
    throw new ToolInputError("media.base64 is not valid standard base64.");
  }
  const buf = Buffer.from(compact, "base64");
  // Node silently drops invalid characters, so round-trip to confirm nothing was discarded.
  if (buf.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new ToolInputError("media.base64 is not valid standard base64.");
  }
  return buf;
}

/**
 * Rejects paths that are relative or that traverse. The '..' check runs on the raw input:
 * normalize() resolves traversal away, so checking afterwards would never fire.
 */
export function assertSafePath(label: string, path: string): string {
  if (!isAbsolute(path)) throw new ToolInputError(`${label} must be an absolute path.`);
  if (path.split(/[\\/]/).includes("..")) {
    throw new ToolInputError(`${label} must not contain '..' segments.`);
  }
  return normalize(path);
}

export async function resolveMedia(
  media: MediaInput | undefined,
  config: Config,
  targetMimeType?: string,
): Promise<ResolvedMedia | undefined> {
  if (!media) return undefined;
  const provided = [media.text !== undefined, media.base64 !== undefined, media.localPath !== undefined].filter(Boolean);
  if (provided.length === 0) return undefined;
  if (provided.length > 1) {
    throw new ToolInputError("Provide exactly one of media.text, media.base64 or media.localPath.");
  }

  // metadata.mimeType is the conversion target, so it is only a usable Content-Type fallback
  // when it is an ordinary type rather than a Google Workspace one.
  const fallback =
    targetMimeType && !targetMimeType.startsWith(WORKSPACE_PREFIX)
      ? targetMimeType
      : media.text !== undefined
        ? "text/plain"
        : "application/octet-stream";
  const mimeType = media.mimeType ?? fallback;

  if (media.localPath !== undefined) {
    if (!config.allowLocalFiles) {
      throw new ToolInputError(
        "Local file access is disabled. Restart the server with DRIVE_ALLOW_LOCAL_FILES=1 to use media.localPath.",
      );
    }
    const path = assertSafePath("media.localPath", media.localPath);
    const stat = await fs.stat(path).catch(() => {
      throw new ToolInputError(`media.localPath is not readable: ${path}`);
    });
    if (!stat.isFile()) throw new ToolInputError(`media.localPath is not a regular file: ${path}`);

    const stream = createReadStream(path);
    // googleapis surfaces stream failures through the request promise, but an 'error' event with
    // no listener at all would take down the process, so always keep one attached.
    stream.on("error", () => undefined);
    return { mimeType, body: stream, suggestedName: basename(path), dispose: () => stream.destroy() };
  }

  const buf = media.base64 !== undefined ? decodeBase64(media.base64) : Buffer.from(media.text as string, "utf8");
  return { mimeType, body: Readable.from(buf), dispose: () => undefined };
}

/** Returns downloaded bytes to the caller, either inline or written to disk. */
export async function deliverBinary(
  bytes: Buffer,
  mimeType: string,
  uri: string,
  config: Config,
  destinationPath?: string,
): Promise<CallToolResult> {
  if (destinationPath) {
    if (!config.allowLocalFiles) {
      throw new ToolInputError(
        "Local file access is disabled. Restart the server with DRIVE_ALLOW_LOCAL_FILES=1 to use destinationPath.",
      );
    }
    const path = assertSafePath("destinationPath", destinationPath);
    await fs.writeFile(path, bytes);
    return { content: [{ type: "text", text: `Wrote ${bytes.byteLength} bytes (${mimeType}) to ${path}` }] };
  }

  assertInlineSize(bytes.byteLength, config);

  if (isTextual(mimeType)) {
    return { content: [{ type: "text", text: bytes.toString("utf8") }] };
  }

  const blob = bytes.toString("base64");
  if (mimeType.startsWith("image/")) {
    return { content: [{ type: "image", data: blob, mimeType }] };
  }
  return { content: [{ type: "resource", resource: { uri, mimeType, blob } }] };
}

/** Refuses payloads over the inline cap, whether the size is known before or after the fetch. */
export function assertInlineSize(byteLength: number, config: Config, forResource = false): void {
  if (byteLength <= config.maxInlineBytes) return;
  const remedy = forResource
    ? "Read it with drive_files_get_content or drive_files_export instead, or raise DRIVE_MAX_INLINE_BYTES."
    : "Pass destinationPath to write it to disk, or raise DRIVE_MAX_INLINE_BYTES.";
  throw new ToolInputError(
    `Content is ${byteLength} bytes, over the ${config.maxInlineBytes}-byte inline limit. ${remedy}`,
  );
}

export function isTextual(mimeType: string): boolean {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("text/")) return true;
  if (base.endsWith("+json") || base.endsWith("+xml")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/rtf",
    "application/x-sh",
    "application/sql",
    "application/yaml",
    "application/x-yaml",
    "application/csv",
  ].includes(base);
}

/** Normalises whatever googleapis hands back for a media response into a Buffer. */
export function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // Requests ask for an arraybuffer; a string here means gaxios already decoded the body as text.
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data ?? null), "utf8");
}
