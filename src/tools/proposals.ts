import { z } from "zod";
import { tool, type ToolDef } from "../registry.js";
import { clean, jsonResult, pagingParams } from "../util.js";

export const accessProposalsTools: ToolDef[] = [
  tool({
    name: "drive_accessproposals_list",
    title: "List access proposals",
    description: "List the pending access proposals (requests for access) on a file. The caller must be an approver on the item.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      ...pagingParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.accessproposals.list(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_accessproposals_get",
    title: "Get an access proposal",
    description: "Get a single access proposal by ID.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      proposalId: z.string().describe("The ID of the access proposal."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.accessproposals.get(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_accessproposals_resolve",
    title: "Resolve an access proposal",
    description: "Accept or deny a request for access to a file. Accepting grants the requester the given role(s).",
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      proposalId: z.string().describe("The ID of the access proposal."),
      action: z
        .enum(["ACCEPT", "DENY"])
        .describe("Whether to grant the requested access or deny the proposal."),
      role: z
        .array(z.enum(["writer", "commenter", "reader"]))
        .optional()
        .describe("Roles to grant when accepting. Defaults to ['reader'] if omitted on an ACCEPT."),
      view: z.string().optional().describe("Indicates the view for this access proposal; only 'published' is supported."),
      sendNotification: z.boolean().optional().describe("Whether to email the requester about the decision."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, proposalId, fields, ...body } = args;
      const drive = await ctx.drive();
      const res = await drive.accessproposals.resolve(
        clean({ fileId, proposalId, fields, requestBody: clean(body) }),
      );
      return jsonResult(res.data);
    },
  }),
];

export const approvalsTools: ToolDef[] = [
  tool({
    name: "drive_approvals_list",
    title: "List approvals",
    description: "List the approval requests on a file.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      ...pagingParams,
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.approvals.list(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_get",
    title: "Get an approval",
    description: "Get a single approval request on a file, including each reviewer's response.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      approvalId: z.string().describe("The ID of the approval."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.approvals.get(clean(args));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_start",
    title: "Start an approval",
    description: "Start an approval request on a file, sending it to the given reviewers.",
    inputSchema: {
      fileId: z.string().describe("The ID of the file to send for approval."),
      reviewerEmails: z.array(z.string()).describe("Email addresses of the reviewers."),
      message: z.string().optional().describe("Message shown to the reviewers."),
      dueTime: z.string().optional().describe("RFC 3339 timestamp by which the approval is due."),
      lockFile: z.boolean().optional().describe("Whether to lock the file for the duration of the approval."),
      fileContentChangeBehavior: z
        .string()
        .optional()
        .describe("How content changes during the approval are handled, e.g. 'RESET_APPROVAL' or 'KEEP_APPROVAL'."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, fields, ...body } = args;
      const drive = await ctx.drive();
      const res = await drive.approvals.start(clean({ fileId, fields, requestBody: clean(body) }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_approve",
    title: "Approve an approval",
    description: "Record the caller's approval on an approval request.",
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      approvalId: z.string().describe("The ID of the approval."),
      message: z.string().optional().describe("Optional message accompanying the approval."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, approvalId, fields, message } = args;
      const drive = await ctx.drive();
      const res = await drive.approvals.approve(clean({ fileId, approvalId, fields, requestBody: clean({ message }) }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_decline",
    title: "Decline an approval",
    description: "Record the caller's rejection of an approval request.",
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      approvalId: z.string().describe("The ID of the approval."),
      message: z.string().optional().describe("Optional message explaining the decline."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, approvalId, fields, message } = args;
      const drive = await ctx.drive();
      const res = await drive.approvals.decline(clean({ fileId, approvalId, fields, requestBody: clean({ message }) }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_comment",
    title: "Comment on an approval",
    description: "Add a comment to an approval request without approving or declining it.",
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      approvalId: z.string().describe("The ID of the approval."),
      message: z.string().describe("The comment to add."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, approvalId, fields, message } = args;
      const drive = await ctx.drive();
      const res = await drive.approvals.comment(clean({ fileId, approvalId, fields, requestBody: { message } }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_reassign",
    title: "Reassign an approval",
    description: "Add reviewers to an approval request, or replace existing reviewers with others.",
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      approvalId: z.string().describe("The ID of the approval."),
      addReviewers: z
        .array(z.object({ addedReviewerEmail: z.string().describe("Email address of the reviewer to add.") }))
        .optional()
        .describe("Reviewers to add to the approval."),
      replaceReviewers: z
        .array(
          z.object({
            addedReviewerEmail: z.string().describe("Email address of the incoming reviewer."),
            removedReviewerEmail: z.string().describe("Email address of the reviewer being replaced."),
          }),
        )
        .optional()
        .describe("Reviewer swaps to perform."),
      message: z.string().optional().describe("Optional message accompanying the reassignment."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, approvalId, fields, ...body } = args;
      const drive = await ctx.drive();
      const res = await drive.approvals.reassign(clean({ fileId, approvalId, fields, requestBody: clean(body) }));
      return jsonResult(res.data);
    },
  }),
  tool({
    name: "drive_approvals_cancel",
    title: "Cancel an approval",
    description: "Cancel an in-progress approval request. Only the initiator or a file owner may cancel one.",
    destructive: true,
    idempotent: true,
    inputSchema: {
      fileId: z.string().describe("The ID of the file."),
      approvalId: z.string().describe("The ID of the approval to cancel."),
      message: z.string().optional().describe("Optional message explaining the cancellation."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const { fileId, approvalId, fields, message } = args;
      const drive = await ctx.drive();
      const res = await drive.approvals.cancel(clean({ fileId, approvalId, fields, requestBody: clean({ message }) }));
      return jsonResult(res.data);
    },
  }),
];

export const operationsTools: ToolDef[] = [
  tool({
    name: "drive_operations_get",
    title: "Get a long-running operation",
    description:
      "Poll a long-running operation, such as one started by drive_files_download. When `done` is true the response carries either an error or the download metadata.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      name: z.string().describe("The operation's resource name, as returned by the call that started it."),
      fields: z.string().optional().describe("Partial-response selector."),
    },
    async handler(args, ctx) {
      const drive = await ctx.drive();
      const res = await drive.operations.get(clean(args));
      return jsonResult(res.data);
    },
  }),
];
