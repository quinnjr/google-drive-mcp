import { z } from "zod";
import { tool, type ToolDef } from "../registry.js";
import { clean, jsonResult, pagingParams } from "../util.js";

/** Fields Drive accepts when a comment is created. `resolved` is output-only; resolve a thread
 *  by posting a reply with action 'resolve'. */
const commentCreateBody = {
  content: z.string().describe("The plain-text content of the comment."),
  anchor: z
    .string()
    .optional()
    .describe("A region of the document the comment refers to, as a JSON string in the Drive anchor format."),
  quotedFileContent: z
    .object({
      mimeType: z.string().optional().describe("MIME type of the quoted content."),
      value: z.string().optional().describe("The quoted content itself, plain text."),
    })
    .optional()
    .describe("The file content the comment quotes."),
};

export const commentsTools: ToolDef[] = [
  tool({
    name: "drive_comments_list",
    title: "List comments",
    description: "List the comments on a file. Comments are supported on Google Workspace files and on many binary types.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      includeDeleted: z.boolean().optional().describe("Include deleted comments (their content will be stripped)."),
      startModifiedTime: z.string().optional().describe("RFC 3339 lower bound on the comment's modifiedTime."),
      ...pagingParams,
      fields: z
        .string()
        .optional()
        .describe("Partial-response selector. Defaults to '*', since comments.list requires an explicit fields value."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.comments.list(clean({ ...args, fields: args.fields ?? "*" }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_comments_get",
    title: "Get a comment",
    description: "Get a single comment on a file, including its replies.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment."),
      includeDeleted: z.boolean().optional().describe("Whether to return a deleted comment."),
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.comments.get(clean({ ...args, fields: args.fields ?? "*" }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_comments_create",
    title: "Create a comment",
    description: "Add a comment to a file.",
    destructive: false,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      ...commentCreateBody,
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const { fileId, fields, ...body } = args;
      const drive = await ctx.drive();
      const res = await drive.comments.create({ fileId, fields: fields ?? "*", requestBody: clean(body) });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_comments_update",
    title: "Update a comment",
    description:
      "Update a comment's content. Content is the only writable field; to resolve or reopen a thread, post a reply with action 'resolve' or 'reopen'.",
    destructive: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment."),
      content: z.string().describe("The new plain-text content of the comment, replacing the current content."),
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const { fileId, commentId, fields, content } = args;
      const drive = await ctx.drive();
      const res = await drive.comments.update({ fileId, commentId, fields: fields ?? "*", requestBody: { content } });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_comments_delete",
    title: "Delete a comment",
    description: "Delete a comment. Its replies are deleted with it.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment to delete."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      await drive.comments.delete(clean(args));
      return jsonResult({ deleted: true, ...args });
    },
  }),
];

const replyBody = {
  content: z.string().optional().describe("The plain-text content of the reply. Required unless action is set."),
  action: z
    .enum(["resolve", "reopen"])
    .optional()
    .describe("An action taken on the parent comment along with the reply."),
};

export const repliesTools: ToolDef[] = [
  tool({
    name: "drive_replies_list",
    title: "List replies",
    description: "List the replies to a comment.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment."),
      includeDeleted: z.boolean().optional().describe("Include deleted replies (their content will be stripped)."),
      ...pagingParams,
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.replies.list(clean({ ...args, fields: args.fields ?? "*" }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_replies_get",
    title: "Get a reply",
    description: "Get a single reply to a comment.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment."),
      replyId: z.string().describe("The ID of the reply."),
      includeDeleted: z.boolean().optional().describe("Whether to return a deleted reply."),
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.replies.get(clean({ ...args, fields: args.fields ?? "*" }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_replies_create",
    title: "Reply to a comment",
    description: "Add a reply to a comment, optionally resolving or reopening the thread.",
    destructive: false,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment being replied to."),
      ...replyBody,
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const { fileId, commentId, fields, ...body } = args;
      const drive = await ctx.drive();
      const res = await drive.replies.create({ fileId, commentId, fields: fields ?? "*", requestBody: clean(body) });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_replies_update",
    title: "Update a reply",
    description: "Update the content of a reply.",
    destructive: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment."),
      replyId: z.string().describe("The ID of the reply."),
      content: z.string().describe("The new plain-text content of the reply."),
      fields: z.string().optional().describe("Partial-response selector. Defaults to '*'."),
    },
    async handler(args, ctx) {
      const { fileId, commentId, replyId, fields, content } = args;
      const drive = await ctx.drive();
      const res = await drive.replies.update({
        fileId,
        commentId,
        replyId,
        fields: fields ?? "*",
        requestBody: { content },
      });
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_replies_delete",
    title: "Delete a reply",
    description: "Delete a reply to a comment.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      commentId: z.string().describe("The ID of the comment."),
      replyId: z.string().describe("The ID of the reply to delete."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      await drive.replies.delete(clean(args));
      return jsonResult({ deleted: true, ...args });
    },
  }),
];
