import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Serialise a Google API response as a JSON tool result. */
export function jsonResult(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null, null, 2);
  return { content: [{ type: "text", text }], structuredContent: asStructured(data) };
}

function asStructured(data: unknown): Record<string, unknown> | undefined {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (data === undefined || data === null) return undefined;
  return { result: data };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turn a googleapis / gaxios failure into a readable, non-leaking message. */
export function describeError(err: unknown): string {
  const e = err as {
    message?: string;
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: unknown };
    errors?: unknown;
  };
  const status = e?.response?.status ?? e?.status ?? e?.code;
  const data = e?.response?.data;
  let detail = "";
  if (data !== undefined) {
    const asObj = data as { error?: { message?: string; errors?: unknown; status?: string } };
    if (asObj?.error?.message) {
      detail = asObj.error.message;
      if (asObj.error.status) detail += ` (${asObj.error.status})`;
    } else if (typeof data === "string") {
      detail = data.slice(0, 2000);
    } else {
      detail = JSON.stringify(data).slice(0, 2000);
    }
  }
  const base = e?.message ?? String(err);
  const parts = [status !== undefined ? `Google Drive API error ${status}` : "Google Drive API error", detail || base];
  return parts.filter(Boolean).join(": ");
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

export const fieldsParam = {
  fields: z
    .string()
    .optional()
    .describe(
      "Partial-response selector, e.g. 'id,name,mimeType' or 'files(id,name),nextPageToken'. Use '*' for every field. Defaults to the API default set.",
    ),
};

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
