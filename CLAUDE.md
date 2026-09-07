# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

`devEngines.packageManager` pins pnpm, so **npm commands fail** with `EBADDEVENGINES` — use pnpm for everything, including `pnpm pack`.

```bash
pnpm install --frozen-lockfile
pnpm build          # tsc -> dist/
pnpm typecheck      # tsc --noEmit
pnpm test           # builds first, then runs every test/*.test.mjs
pnpm start          # runs dist/index.js
```

Tests import from `dist/`, not `src/`, so **build before running `node --test` directly**:

```bash
pnpm build && node --test test/server.test.mjs   # one file
pnpm build && node --test --test-name-pattern="pageSize ceilings" test/server.test.mjs
```

Pass files or a glob (`test/*.test.mjs`) — `node --test test/` reads the bare directory as a module
path and fails.

To run the server against real Drive credentials: `cp .env.example .env`, fill it in, then
`node --env-file=.env dist/index.js`. `GET /healthz` is a liveness probe.

## Architecture

A Model Context Protocol server exposing all 64 methods of the Google Drive v3 API as 66 tools,
over **Streamable HTTP only** (no stdio, no legacy SSE).

### The tool pipeline

A tool flows through four seams; changing one usually means touching the others.

1. `src/tools/*.ts` — one module per Drive resource, each exporting `ToolDef[]` built with the
   `tool()` helper.
2. `tool()` in `src/registry.ts` — enforces at construction time that any tool which is not
   `readOnly: true` declares `destructive: true | false`. This throws at import, so a missing flag
   fails the build rather than shipping a wrong MCP annotation.
3. `buildTools(config)` in `src/server.ts` — composes every module. **A new tool module must be
   added here or it is silently unreachable.**
4. `registerTools()` in `src/registry.ts` — drops non-read-only tools when `DRIVE_READ_ONLY=1`,
   maps the flags to MCP annotations, and wraps every handler in the error funnel.

`buildTools` is a *function of `Config`*, not a constant, because two tool families vary with
configuration: `filesTools(config)` and `revisionsTools(config)` only expose `destinationPath` when
`DRIVE_ALLOW_LOCAL_FILES=1`, and flip from `readOnly: true` to `destructive: true` when they do —
writing to the server's filesystem is not a read-only act, so those tools must also leave read-only
mode. Any new tool that touches the local filesystem follows the same pattern
(`destinationParams()` / `localFileFlags()` in `src/tools/files.ts`).

### Credentials and per-request identity

`AuthProvider` (`src/auth.ts`) resolves credentials in priority order: a per-request token, then
env OAuth2, then a service-account key, then ADC. The per-request path is the subtle one:

- `src/http.ts` wraps each `transport.handleRequest` in `runWithContext({ googleAccessToken })`.
- `src/context.ts` holds that in an `AsyncLocalStorage`.
- `AuthProvider.client()` reads `currentContext()` on every call, so a passthrough token is never
  cached, while the server's own credentials are cached in `#shared`.

Impersonation (`GOOGLE_IMPERSONATE_SUBJECT`) requires building a `JWT` from the key directly —
`GoogleAuth` has no way to pass a subject — so the key file is read whenever a subject is set,
regardless of the filename.

### Error taxonomy

Two kinds of failure, deliberately distinguished in `src/util.ts`:

- `ToolInputError` — caller mistakes and policy refusals. Reported verbatim, never logged as a
  server fault, never prefixed with "Google Drive API error".
- Everything else — `describeError()` only formats it as a Google API error when it actually carries
  an HTTP response shape; otherwise it reports the local error plainly.

`registerTools` catches both and returns an `isError` tool result, so a Drive 404 never surfaces as
a transport failure.

### HTTP transport

`createApp()` in `src/http.ts` returns `{ app, shutdown }`. Ordering matters and is load-bearing:

- The `guard` middleware (Host/Origin allowlists, constant-time bearer check) runs **before**
  `express.json`, so an unauthenticated caller cannot make the server buffer a large body.
- Body-parser failures are converted to JSON-RPC errors rather than reaching Express's HTML error page.
- Sessions live in a `Map` with an idle TTL sweep and a hard cap; an `initialize` that never
  establishes a session is torn down rather than stranded.
- `src/index.ts` must register `'listening'` and `'error'` separately: Express 5 passes a
  `listen(port, host, cb)` callback to `server.once('error', cb)` too, so a single callback turns a
  failed bind into a false success banner and exit code 0.

### Drive request conventions

Helpers in `src/util.ts`, applied consistently across tool modules:

- `clean()` — strip `undefined`/`null` so googleapis does not send empty query params.
- `withDriveDefaults()` — default `supportsAllDrives: true`.
- `withCorpusDefaults()` — additionally default `includeItemsFromAllDrives: true`; use it for
  `files.list`, `changes.list` **and** `changes.watch`, which must agree on the corpus they cover.
- `pagingParams` (max 1000) vs `pagingParams100` — each endpoint's documented ceiling. Advertising a
  larger one invites a caller to request it, get silently coerced down, and mistake a truncated page
  for a complete list.
- `fields` is exposed on nearly every tool. `about.get`, `comments.*` and `replies.*` require an
  explicit value, so those default to `"*"`.

## Testing

Tests boot the real Express app on an ephemeral port and drive it with a real MCP SDK client over
Streamable HTTP; only googleapis is stubbed, by injecting a `{ client: async () => fake }` factory
in place of `DriveFactory`. Helpers live in `test/helpers.mjs`:

- `startServer(env, responses)` — `responses` is keyed by `"resource.method"` (e.g. `"files.list"`),
  a value or a function of the params. Returns `drive.calls` / `drive.callsTo(path)` for asserting
  on what was sent to Google, and `tokensSeen` for the credential the factory observed.
- `configFrom(env)` — builds a `Config` from `env` alone and fully restores `process.env`.

`test/server.test.mjs` contains a coverage test that calls every registered tool with placeholder
arguments and asserts all 64 Drive v3 methods were reached, so a tool that is missing, misrouted, or
absent from `buildTools` fails the build. When adding a tool, extend `EXPECTED_METHODS` there.

When asserting a tool's behaviour, assert on the params the stub received — a test that only checks
`isError === undefined` passes even with the feature deleted.
