import { createReadStream, promises as fs } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";

export const mediaInputSchema = z
  .object({
    text: z.string().optional().describe("File content as UTF-8 text."),
    base64: z.string().optional().describe("File content as a base64-encoded string (use for binary content)."),
    localPath: z
      .string()
      .optional()
      .describe(
        "Absolute path to a file on the machine running this server. Only permitted when the server is started with DRIVE_ALLOW_LOCAL_FILES=1.",
      ),
    mimeType: z
      .string()
      .optional()
      .describe("MIME type of the uploaded bytes. Defaults to the file metadata's mimeType, then to application/octet-stream."),
  })
  .describe("The bytes to upload. Provide exactly one of text, base64 or localPath.");

export type MediaInput = z.infer<typeof mediaInputSchema>;

export interface ResolvedMedia {
  mimeType: string;
  body: Readable;
  /** Suggested name when the caller did not provide one. */
  suggestedName?: string;
}

export async function resolveMedia(
  media: MediaInput | undefined,
  config: Config,
  fallbackMimeType?: string,
): Promise<ResolvedMedia | undefined> {
  if (!media) return undefined;
  const provided = [media.text !== undefined, media.base64 !== undefined, media.localPath !== undefined].filter(Boolean);
  if (provided.length === 0) return undefined;
  if (provided.length > 1) {
    throw new Error("Provide exactly one of media.text, media.base64 or media.localPath.");
  }

  const mimeType = media.mimeType ?? fallbackMimeType ?? "application/octet-stream";

  if (media.localPath !== undefined) {
    if (!config.allowLocalFiles) {
      throw new Error("Local file access is disabled. Restart the server with DRIVE_ALLOW_LOCAL_FILES=1 to use media.localPath.");
    }
    if (!isAbsolute(media.localPath)) throw new Error("media.localPath must be an absolute path.");
    await fs.access(media.localPath);
    return { mimeType, body: createReadStream(media.localPath), suggestedName: basename(media.localPath) };
  }

  const buf =
    media.base64 !== undefined ? Buffer.from(media.base64, "base64") : Buffer.from(media.text as string, "utf8");
  return { mimeType, body: Readable.from(buf) };
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
      throw new Error("Local file access is disabled. Restart the server with DRIVE_ALLOW_LOCAL_FILES=1 to use destinationPath.");
    }
    if (!isAbsolute(destinationPath)) throw new Error("destinationPath must be an absolute path.");
    await fs.writeFile(destinationPath, bytes);
    return {
      content: [{ type: "text", text: `Wrote ${bytes.byteLength} bytes (${mimeType}) to ${destinationPath}` }],
      structuredContent: { path: destinationPath, bytes: bytes.byteLength, mimeType },
    };
  }

  if (bytes.byteLength > config.maxInlineBytes) {
    throw new Error(
      `Content is ${bytes.byteLength} bytes, over the ${config.maxInlineBytes}-byte inline limit. ` +
        "Pass destinationPath to write it to disk, or raise DRIVE_MAX_INLINE_BYTES.",
    );
  }

  if (isTextual(mimeType)) {
    return {
      content: [{ type: "text", text: bytes.toString("utf8") }],
      structuredContent: { bytes: bytes.byteLength, mimeType },
    };
  }

  const blob = bytes.toString("base64");
  if (mimeType.startsWith("image/")) {
    return { content: [{ type: "image", data: blob, mimeType }] };
  }
  return {
    content: [{ type: "resource", resource: { uri, mimeType, blob } }],
  };
}

function isTextual(mimeType: string): boolean {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("text/")) return true;
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
  if (typeof data === "string") return Buffer.from(data, "binary");
  return Buffer.from(JSON.stringify(data ?? null), "utf8");
}
