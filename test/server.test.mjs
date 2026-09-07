import assert from "node:assert/strict";
import test from "node:test";
import { buildTools } from "../dist/server.js";
import { configFrom } from "./helpers.mjs";
import { connectClient, startServer, textOf } from "./helpers.mjs";

const allTools = buildTools(configFrom());

const EXPECTED_METHODS = {
  about: ["get"],
  accessproposals: ["get", "list", "resolve"],
  approvals: ["approve", "cancel", "comment", "decline", "get", "list", "reassign", "start"],
  apps: ["get", "list"],
  changes: ["getStartPageToken", "list", "watch"],
  channels: ["stop"],
  comments: ["create", "delete", "get", "list", "update"],
  drives: ["create", "delete", "get", "hide", "list", "unhide", "update"],
  files: [
    "copy", "create", "delete", "download", "emptyTrash", "export", "generateCseToken",
    "generateIds", "get", "list", "listLabels", "modifyLabels", "update", "watch",
  ],
  operations: ["get"],
  permissions: ["create", "delete", "get", "list", "update"],
  replies: ["create", "delete", "get", "list", "update"],
  revisions: ["delete", "get", "list", "update"],
  teamdrives: ["create", "delete", "get", "list", "update"],
};

test("tool names are unique", () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("every Drive v3 method is reachable through at least one tool", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    assert.equal(tools.length, allTools.length);

    // Drive a call through every tool with placeholder arguments, then check which
    // googleapis methods were exercised.
    const placeholder = (schema) => {
      const props = schema.properties ?? {};
      const required = schema.required ?? [];
      const args = {};
      for (const key of required) args[key] = sample(props[key]);
      return args;
    };

    for (const t of tools) {
      await client.callTool({ name: t.name, arguments: placeholder(t.inputSchema) });
    }
    await client.close();

    const seen = new Set(ctx.drive.calls.map((c) => c.path));
    const missing = [];
    for (const [resource, methods] of Object.entries(EXPECTED_METHODS)) {
      for (const m of methods) if (!seen.has(`${resource}.${m}`)) missing.push(`${resource}.${m}`);
    }
    assert.deepEqual(missing, [], `uncovered Drive methods: ${missing.join(", ")}`);
  } finally {
    await ctx.close();
  }
});

function sample(prop) {
  if (!prop) return "x";
  if (prop.enum) return prop.enum[0];
  switch (prop.type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [sample(prop.items)];
    case "object": {
      const out = {};
      for (const key of prop.required ?? []) out[key] = sample(prop.properties?.[key]);
      return out;
    }
    default:
      return "x";
  }
}

test("changes list and watch agree on the corpus they cover", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    await client.callTool({ name: "drive_changes_list", arguments: { pageToken: "t" } });
    await client.callTool({
      name: "drive_changes_watch",
      arguments: { pageToken: "t", channel: { id: "c1", address: "https://example.com/hook" } },
    });
    for (const path of ["changes.list", "changes.watch"]) {
      const call = ctx.drive.callsTo(path)[0];
      assert.equal(call.params.includeItemsFromAllDrives, true, path);
      assert.equal(call.params.supportsAllDrives, true, path);
    }
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("resolving an access proposal applies the documented reader default", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    await client.callTool({
      name: "drive_accessproposals_resolve",
      arguments: { fileId: "f1", proposalId: "p1", action: "ACCEPT" },
    });
    assert.deepEqual(ctx.drive.callsTo("accessproposals.resolve")[0].params.requestBody.role, ["reader"]);

    await client.callTool({
      name: "drive_accessproposals_resolve",
      arguments: { fileId: "f1", proposalId: "p2", action: "DENY" },
    });
    assert.equal(ctx.drive.callsTo("accessproposals.resolve")[1].params.requestBody.role, undefined);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("comment update sends only the writable content field", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    const update = tools.find((t) => t.name === "drive_comments_update");
    assert.equal(update.inputSchema.properties.resolved, undefined);

    await client.callTool({
      name: "drive_comments_update",
      arguments: { fileId: "f1", commentId: "c1", content: "edited" },
    });
    assert.deepEqual(ctx.drive.callsTo("comments.update")[0].params.requestBody, { content: "edited" });
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("files.list forwards the query and shared-drive defaults", async () => {
  const ctx = await startServer({}, {
    "files.list": { files: [{ id: "abc", name: "Report.pdf" }], nextPageToken: "next" },
  });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({
      name: "drive_files_list",
      arguments: { q: "name contains 'Report'", pageSize: 5, fields: "files(id,name)" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent, undefined);
    assert.match(textOf(result), /Report\.pdf/);

    const call = ctx.drive.calls.find((c) => c.path === "files.list");
    assert.equal(call.params.q, "name contains 'Report'");
    assert.equal(call.params.pageSize, 5);
    assert.equal(call.params.supportsAllDrives, true);
    assert.equal(call.params.includeItemsFromAllDrives, true);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("files.create uploads text content and infers the body", async () => {
  const ctx = await startServer({}, { "files.create": { id: "new-id", name: "notes.txt" } });
  try {
    const client = await connectClient(ctx.url);
    await client.callTool({
      name: "drive_files_create",
      arguments: {
        metadata: { name: "notes.txt", parents: ["root"], mimeType: "text/plain" },
        media: { text: "hello world" },
      },
    });
    const call = ctx.drive.calls.find((c) => c.path === "files.create");
    assert.deepEqual(call.params.requestBody, { name: "notes.txt", mimeType: "text/plain", parents: ["root"] });
    assert.equal(call.params.media.mimeType, "text/plain");
    const chunks = [];
    for await (const chunk of call.params.media.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "hello world");
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("additionalMetadata is merged into the file body", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    await client.callTool({
      name: "drive_files_update",
      arguments: { fileId: "f1", metadata: { name: "a", additionalMetadata: { labelInfo: { labels: [] } } } },
    });
    const call = ctx.drive.calls.find((c) => c.path === "files.update");
    assert.deepEqual(call.params.requestBody, { labelInfo: { labels: [] }, name: "a" });
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("export returns text content for textual MIME types", async () => {
  const ctx = await startServer({}, { "files.export": Buffer.from("col1,col2\n1,2\n") });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({
      name: "drive_files_export",
      arguments: { fileId: "doc1", mimeType: "text/csv" },
    });
    assert.equal(textOf(result), "col1,col2\n1,2\n");
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("binary downloads come back as a base64 resource", async () => {
  const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  const ctx = await startServer({}, {
    "files.get": (params) => (params.alt === "media" ? bytes : { name: "blob.bin", mimeType: "application/octet-stream" }),
  });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({ name: "drive_files_get_content", arguments: { fileId: "f1" } });
    const part = result.content[0];
    assert.equal(part.type, "resource");
    assert.equal(part.resource.mimeType, "application/octet-stream");
    assert.equal(Buffer.from(part.resource.blob, "base64").toString("hex"), bytes.toString("hex"));
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("an oversized download is refused from its declared size, before any transfer", async () => {
  const ctx = await startServer({ DRIVE_MAX_INLINE_BYTES: "8" }, {
    "files.get": (params) =>
      params.alt === "media" ? Buffer.alloc(64) : { mimeType: "application/octet-stream", size: "64" },
  });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({ name: "drive_files_get_content", arguments: { fileId: "f1" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /over the 8-byte inline limit/);
    // The metadata probe happened; the media fetch did not.
    assert.equal(ctx.drive.callsTo("files.get").length, 1);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("an oversized download with no declared size is still refused after the fetch", async () => {
  const ctx = await startServer({ DRIVE_MAX_INLINE_BYTES: "8" }, {
    "files.get": (params) => (params.alt === "media" ? Buffer.alloc(64) : { mimeType: "application/octet-stream" }),
  });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({ name: "drive_files_get_content", arguments: { fileId: "f1" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /inline limit/);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("local file access is absent from the schema unless it is enabled", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    const download = tools.find((t) => t.name === "drive_files_get_content");
    assert.equal(download.inputSchema.properties.destinationPath, undefined);
    assert.equal(download.annotations.readOnlyHint, true);

    const result = await client.callTool({
      name: "drive_files_create",
      arguments: { metadata: { name: "x" }, media: { localPath: "/etc/hostname" } },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /DRIVE_ALLOW_LOCAL_FILES/);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("enabling local files adds destinationPath and drops the read-only hint", async () => {
  const ctx = await startServer({ DRIVE_ALLOW_LOCAL_FILES: "1" });
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    const download = tools.find((t) => t.name === "drive_files_get_content");
    assert.ok(download.inputSchema.properties.destinationPath);
    assert.equal(download.annotations.readOnlyHint, false);
    assert.equal(download.annotations.destructiveHint, true);

    // Read-only mode must not smuggle in a tool that can write to the host filesystem.
    const names = buildTools(configFrom({ DRIVE_ALLOW_LOCAL_FILES: "1", DRIVE_READ_ONLY: "1" }))
      .filter((t) => t.readOnly)
      .map((t) => t.name);
    assert.ok(!names.includes("drive_files_get_content"));
    assert.ok(!names.includes("drive_revisions_get_content"));
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("relative and traversing destination paths are rejected", async () => {
  const ctx = await startServer({ DRIVE_ALLOW_LOCAL_FILES: "1" }, {
    "files.export": Buffer.from("x"),
  });
  try {
    const client = await connectClient(ctx.url);
    for (const destinationPath of ["relative/out.txt", "/tmp/../etc/out.txt"]) {
      const result = await client.callTool({
        name: "drive_files_export",
        arguments: { fileId: "f1", mimeType: "text/plain", destinationPath },
      });
      assert.equal(result.isError, true, destinationPath);
      assert.match(textOf(result), /absolute path|'\.\.' segments/);
    }
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("invalid base64 is rejected instead of silently truncated", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({
      name: "drive_files_create",
      arguments: { metadata: { name: "x" }, media: { base64: "not valid base64!!" } },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not valid standard base64/);
    assert.equal(ctx.drive.callsTo("files.create").length, 0);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("a Workspace target type is not used as the upload Content-Type", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    await client.callTool({
      name: "drive_files_create",
      arguments: {
        metadata: { name: "Q3", mimeType: "application/vnd.google-apps.spreadsheet" },
        media: { text: "a,b\n1,2\n" },
      },
    });
    const call = ctx.drive.callsTo("files.create")[0];
    assert.equal(call.params.requestBody.mimeType, "application/vnd.google-apps.spreadsheet");
    assert.equal(call.params.media.mimeType, "text/plain");
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("a local input error is not reported as a Google API error", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({
      name: "drive_files_create",
      arguments: { metadata: { name: "x" }, media: { text: "a", base64: "YQ==" } },
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(textOf(result), /Google Drive API error/);
    assert.match(textOf(result), /exactly one of/);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("read-only mode exposes exactly the read-only tools", async () => {
  const expected = buildTools(configFrom({ DRIVE_READ_ONLY: "1" }))
    .filter((t) => t.readOnly)
    .map((t) => t.name)
    .sort();

  const ctx = await startServer({ DRIVE_READ_ONLY: "1" });
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    // Compare against the full catalogue, so a write tool that loses its flag fails here.
    assert.deepEqual(tools.map((t) => t.name).sort(), expected);
    assert.ok(expected.includes("drive_files_list"));
    assert.ok(!expected.includes("drive_files_delete"));
    assert.ok(!expected.includes("drive_permissions_create"));
    assert.ok(allTools.length > expected.length);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
    assert.ok(tools.every((t) => t.annotations.destructiveHint === undefined));
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("every writing tool declares a destructive hint, and none claims to be read-only", () => {
  for (const t of allTools) {
    if (t.readOnly) {
      assert.equal(t.destructive, undefined, `${t.name} is read-only but flags destructive`);
    } else {
      assert.equal(typeof t.destructive, "boolean", `${t.name} does not declare destructive`);
    }
  }
});

test("annotations follow the MCP defaults rather than silently overriding them", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    assert.equal(byName.get("drive_files_delete").destructiveHint, true);
    assert.equal(byName.get("drive_permissions_create").destructiveHint, true);
    assert.equal(byName.get("drive_files_create").destructiveHint, false);
    assert.equal(byName.get("drive_files_list").readOnlyHint, true);
    assert.ok(tools.every((t) => t.annotations.openWorldHint === true));
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("Google API errors are surfaced as tool errors, not transport failures", async () => {
  const ctx = await startServer({}, {
    "files.get": () => {
      const err = new Error("Request failed with status code 404");
      err.response = { status: 404, data: { error: { message: "File not found: nope.", status: "NOT_FOUND" } } };
      throw err;
    },
  });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({ name: "drive_files_get", arguments: { fileId: "nope" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /404: File not found: nope\. \(NOT_FOUND\)/);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("resources expose Drive files and export Google Docs as markdown", async () => {
  const ctx = await startServer({}, {
    "files.list": { files: [{ id: "f1", name: "Doc", mimeType: "application/vnd.google-apps.document" }] },
    "files.get": { name: "Doc", mimeType: "application/vnd.google-apps.document" },
    "files.export": Buffer.from("# Heading\n"),
  });
  try {
    const client = await connectClient(ctx.url);
    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map((r) => r.uri), ["googledrive:///f1"]);

    const read = await client.readResource({ uri: "googledrive:///f1" });
    assert.equal(read.contents[0].text, "# Heading\n");
    assert.equal(read.contents[0].mimeType, "text/markdown");
    const call = ctx.drive.calls.find((c) => c.path === "files.export");
    assert.equal(call.params.mimeType, "text/markdown");
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("an Apps Script project resource comes back as text, not base64", async () => {
  const ctx = await startServer({}, {
    "files.get": { name: "Macro", mimeType: "application/vnd.google-apps.script" },
    "files.export": Buffer.from('{"files":[]}'),
  });
  try {
    const client = await connectClient(ctx.url);
    const read = await client.readResource({ uri: "googledrive:///s1" });
    assert.equal(read.contents[0].mimeType, "application/vnd.google-apps.script+json");
    assert.equal(read.contents[0].text, '{"files":[]}');
    assert.equal(read.contents[0].blob, undefined);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("a resource read over the inline cap is refused", async () => {
  const ctx = await startServer({ DRIVE_MAX_INLINE_BYTES: "8" }, {
    "files.get": (params) =>
      params.alt === "media" ? Buffer.alloc(64) : { mimeType: "application/octet-stream", size: "64" },
  });
  try {
    const client = await connectClient(ctx.url);
    await assert.rejects(
      () => client.readResource({ uri: "googledrive:///f1" }),
      /inline limit/,
    );
    assert.equal(ctx.drive.callsTo("files.get").length, 1);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("a text response that gaxios already decoded is not latin1-mangled", async () => {
  const ctx = await startServer({}, { "files.export": "héllo — ünicode" });
  try {
    const client = await connectClient(ctx.url);
    const result = await client.callTool({
      name: "drive_files_export",
      arguments: { fileId: "d1", mimeType: "text/plain" },
    });
    assert.equal(textOf(result), "héllo — ünicode");
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("pageSize ceilings match each endpoint's documented maximum", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url);
    const { tools } = await client.listTools();
    const maxOf = (name) =>
      tools.find((t) => t.name === name).inputSchema.properties.pageSize?.maximum;

    for (const name of ["drive_files_list", "drive_changes_list", "drive_revisions_list"]) {
      assert.equal(maxOf(name), 1000, name);
    }
    for (const name of [
      "drive_comments_list",
      "drive_replies_list",
      "drive_permissions_list",
      "drive_drives_list",
      "drive_teamdrives_list",
      "drive_approvals_list",
      "drive_accessproposals_list",
    ]) {
      assert.equal(maxOf(name), 100, name);
    }

    // A value the API would coerce down is rejected up front rather than silently truncated.
    const refused = await client.callTool({
      name: "drive_permissions_list",
      arguments: { fileId: "f1", pageSize: 1000 },
    });
    assert.equal(refused.isError, true);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("resources/list pages through Drive instead of stopping at the first page", async () => {
  let page = 0;
  const ctx = await startServer({}, {
    "files.list": () => {
      page += 1;
      return {
        files: [{ id: `f${page}`, name: `File ${page}`, mimeType: "text/plain" }],
        nextPageToken: page < 3 ? `p${page}` : undefined,
      };
    },
  });
  try {
    const client = await connectClient(ctx.url);
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ["googledrive:///f1", "googledrive:///f2", "googledrive:///f3"]);
    assert.equal(ctx.drive.callsTo("files.list").length, 3);
    assert.equal(ctx.drive.callsTo("files.list")[1].params.pageToken, "p1");
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("a failing resources/list surfaces the error instead of reporting an empty Drive", async () => {
  const ctx = await startServer({}, {
    "files.list": () => {
      const err = new Error("Request failed with status code 401");
      err.response = { status: 401, data: { error: { message: "Invalid Credentials", status: "UNAUTHENTICATED" } } };
      throw err;
    },
  });
  try {
    const client = await connectClient(ctx.url);
    await assert.rejects(() => client.listResources(), /401|Invalid Credentials/);
    await client.close();
  } finally {
    await ctx.close();
  }
});
