# google-drive-mcp

A Model Context Protocol server for Google Drive with **complete Drive v3 API coverage**, served over **Streamable HTTP only**.

66 tools cover all 63 methods of the Drive v3 REST API — files, permissions, comments, replies, revisions, shared drives, changes, watch channels, labels, access proposals, approvals, apps, operations and the deprecated Team Drive endpoints — plus dedicated tools for downloading file bytes and revision bytes, which the raw API folds into `files.get`/`revisions.get` with `alt=media`.

## Install and run

```bash
pnpm install
pnpm build
cp .env.example .env      # fill in credentials
node --env-file=.env dist/index.js
```

The MCP endpoint is `POST/GET/DELETE http://127.0.0.1:3000/mcp`; `GET /healthz` is an unauthenticated liveness probe.

### Connect a client

```bash
claude mcp add --transport http drive http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

```json
{
  "mcpServers": {
    "drive": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Authentication

Credentials are resolved in this order; configure exactly one.

| Mode | Environment | Notes |
| --- | --- | --- |
| Per-request token | `GOOGLE_TOKEN_PASSTHROUGH=1` | Each client sends `X-Google-Access-Token: ya29...`; every call runs as that user. Falls back to the server's own credentials when the header is absent. |
| OAuth2 user | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Refreshes access tokens automatically. |
| Service account | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`, optionally `GOOGLE_IMPERSONATE_SUBJECT` | Set the subject to impersonate a Workspace user via domain-wide delegation. |
| ADC | none | Uses `gcloud auth application-default login` or the metadata server. |

Default scopes are `drive` and `drive.appdata`. Narrow them with `GOOGLE_SCOPES` (comma-separated); note that `drive.file` restricts the server to files this app created.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` / `MCP_PATH` | `127.0.0.1` / `3000` / `/mcp` | Listen address and endpoint path. |
| `MCP_AUTH_TOKEN` | unset | Required bearer token, compared in constant time. The server warns loudly when unset. |
| `MCP_ALLOWED_HOSTS` | unset | Comma-separated `Host` allowlist. Set this whenever the server is not bound to loopback. |
| `MCP_ALLOWED_ORIGINS` | unset | Comma-separated `Origin` allowlist for browser clients. |
| `MCP_STATEFUL` | `1` | `1` issues an `Mcp-Session-Id` per client and supports the SSE `GET` stream and `DELETE` termination. `0` serves each POST from a fresh server instance. |
| `DRIVE_READ_ONLY` | `0` | `1` registers only the 31 read-only tools; nothing that writes is even advertised. |
| `DRIVE_ALLOW_LOCAL_FILES` | `0` | Gates `media.localPath` uploads and `destinationPath` downloads, which touch the server's filesystem. |
| `DRIVE_MAX_INLINE_BYTES` | `8388608` | Cap on bytes returned inline from download/export tools. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

## Tools

Every list tool paginates through `pageToken`, and nearly every tool accepts a `fields` partial-response selector — pass one to keep responses small (`fields: "files(id,name,modifiedTime),nextPageToken"`). Shared-drive support (`supportsAllDrives`, `includeItemsFromAllDrives`) defaults to on.

**Files** — `drive_files_list` (Drive query language), `drive_files_get`, `drive_files_get_content`, `drive_files_export`, `drive_files_download` (long-running, for exports over 10 MB), `drive_files_create`, `drive_files_update`, `drive_files_copy`, `drive_files_delete`, `drive_files_empty_trash`, `drive_files_generate_ids`, `drive_files_list_labels`, `drive_files_modify_labels`, `drive_files_watch`, `drive_files_generate_cse_token`

**Permissions** — `drive_permissions_list`, `_get`, `_create`, `_update`, `_delete`

**Comments & replies** — `drive_comments_{list,get,create,update,delete}`, `drive_replies_{list,get,create,update,delete}`

**Revisions** — `drive_revisions_{list,get,get_content,update,delete}`

**Shared drives** — `drive_drives_{list,get,create,update,delete,hide,unhide}`

**Change tracking** — `drive_changes_get_start_page_token`, `drive_changes_list`, `drive_changes_watch`, `drive_channels_stop`

**Access & approvals** — `drive_accessproposals_{list,get,resolve}`, `drive_approvals_{list,get,start,approve,decline,comment,reassign,cancel}`

**Other** — `drive_about_get`, `drive_apps_{get,list}`, `drive_operations_get`, `drive_teamdrives_*` (deprecated; prefer `drive_drives_*`)

### Content handling

`drive_files_create` and `drive_files_update` take a `media` object with exactly one of `text`, `base64` or `localPath`. Downloads come back as text when the MIME type is textual, as an `image` part for images, and as a base64 resource otherwise — or are written straight to `destinationPath` when local file access is enabled.

Google Workspace documents have no downloadable bytes: use `drive_files_export` with a target MIME type (`text/markdown`, `text/csv`, `application/pdf`, …). `drive_about_get` lists every supported import and export conversion.

### Recipes

```jsonc
// Create a folder
{"name": "drive_files_create", "arguments": {"metadata": {"name": "Reports", "mimeType": "application/vnd.google-apps.folder"}}}

// Upload a CSV and convert it to a Google Sheet
{"name": "drive_files_create", "arguments": {
  "metadata": {"name": "Q3", "mimeType": "application/vnd.google-apps.spreadsheet", "parents": ["FOLDER_ID"]},
  "media": {"text": "a,b\n1,2\n", "mimeType": "text/csv"}}}

// Move a file between folders
{"name": "drive_files_update", "arguments": {"fileId": "ID", "addParents": "NEW", "removeParents": "OLD"}}

// Share with a link
{"name": "drive_permissions_create", "arguments": {"fileId": "ID", "permission": {"type": "anyone", "role": "reader"}}}

// Poll for changes
{"name": "drive_changes_get_start_page_token", "arguments": {}}
{"name": "drive_changes_list", "arguments": {"pageToken": "TOKEN", "includeRemoved": true}}
```

## Resources

Files are also exposed as MCP resources at `googledrive:///FILE_ID`. Reading one returns the file's text where possible; Google Docs are exported to Markdown, Sheets to CSV, Slides to plain text and Drawings to PNG.

## Security notes

- Bind to loopback, or set `MCP_AUTH_TOKEN` **and** `MCP_ALLOWED_HOSTS` before exposing the port.
- Local filesystem access is off by default; a compromised client cannot read server-side paths or write to them unless you opt in.
- `DRIVE_READ_ONLY=1` is the safest posture for exploratory use — deletions in Drive are effectively irreversible once the trash is emptied.
- Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so hosts can prompt appropriately before writes.

## Development

```bash
pnpm typecheck
pnpm test          # builds, then runs 22 integration tests over the real HTTP transport
```

The test suite drives every registered tool through a stubbed googleapis client and asserts that all 63 Drive v3 methods are reached, so a missing or misrouted tool fails the build.
