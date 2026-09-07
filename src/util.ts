import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Serialise a Google API response as a JSON tool result. */
export function jsonResult(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Raised for caller mistakes and policy refusals; reported verbatim, without a Google API prefix. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

interface GaxiosLike {
  message?: string;
  code?: number | string;
  status?: number;
  response?: { status?: number; data?: unknown };
}

/** True when the failure carries a Google API HTTP response, rather than being a local error. */
function isApiError(err: unknown): err is GaxiosLike {
  if (!err || typeof err !== "object") return false;
  const e = err as GaxiosLike;
  if (e.response && typeof e.response === "object") return true;
  return typeof e.status === "number" || typeof e.code === "number";
}

/** Turn a googleapis / gaxios failure into a readable, non-leaking message. */
export function describeError(err: unknown): string {
  if (err instanceof ToolInputError) return err.message;
  if (!isApiError(err)) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const e = err;
  const status = e.response?.status ?? e.status ?? e.code;
  const data = e.response?.data;
  let detail = "";
  if (data !== undefined) {
    const asObj = data as { error?: { message?: string; status?: string } | string };
    if (typeof asObj?.error === "object" && asObj.error?.message) {
      detail = asObj.error.message;
      if (asObj.error.status) detail += ` (${asObj.error.status})`;
    } else if (typeof data === "string") {
      detail = data.slice(0, 2000);
    } else {
      detail = JSON.stringify(data).slice(0, 2000);
    }
  }
  const base = e.message ?? String(err);
  const head = status !== undefined ? `Google Drive API error ${status}` : "Google Drive API error";
  return [head, detail || base].filter(Boolean).join(": ");
}

/** Drop undefined/null keys so googleapis does not send empty query parameters. */
export function clean<T extends Record<string, unknown>>(params: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reusable parameter fragments                                        */
/* ------------------------------------------------------------------ */

export const sharedDriveParams = {
  supportsAllDrives: z
    .boolean()
    .optional()
    .describe("Whether the request applies to both My Drive and shared drive items. Defaults to true."),
};

export const pagingParams = {
  pageSize: z.number().int().min(1).max(1000).optional().describe("Maximum number of items to return."),
  pageToken: z.string().optional().describe("Token for the next page, from a previous response's nextPageToken."),
};

export const permissionWriteParams = {
  useDomainAdminAccess: z
    .boolean()
    .optional()
    .describe("Issue the request as a domain administrator; the requester must be an administrator of the item's domain."),
};

/** Applied to every shared-drive-aware call unless the caller says otherwise. */
export function withDriveDefaults(params: Record<string, unknown>): Record<string, unknown> {
  const out = { ...params };
  if (out.supportsAllDrives === undefined) out.supportsAllDrives = true;
  return out;
}

/** Applied to the corpus-spanning list/watch calls, which need both flags to agree. */
export function withCorpusDefaults(params: Record<string, unknown>): Record<string, unknown> {
  const out = withDriveDefaults(params);
  if (out.includeItemsFromAllDrives === undefined) out.includeItemsFromAllDrives = true;
  return out;
}

/** Parses a Drive `size` field, which the API returns as a decimal string. */
export function parseSize(size: string | null | undefined): number | undefined {
  if (!size) return undefined;
  const n = Number(size);
  return Number.isFinite(n) ? n : undefined;
}
