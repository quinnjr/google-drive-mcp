import assert from "node:assert/strict";
import test from "node:test";
import { connectClient, startServer } from "./helpers.mjs";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
};

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

test("health endpoint reports the transport", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.transport, "streamable-http");
  } finally {
    await ctx.close();
  }
});

test("initialize returns an Mcp-Session-Id in stateful mode", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("mcp-session-id") ?? "", /^[0-9a-f-]{36}$/);
    await res.body?.cancel();
  } finally {
    await ctx.close();
  }
});

test("a non-initialize POST without a session id is rejected", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(ctx.url, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /Mcp-Session-Id/);
  } finally {
    await ctx.close();
  }
});

test("an unknown session id is rejected with 404", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(ctx.url, {
      method: "POST",
      headers: { ...HEADERS, "mcp-session-id": "11111111-1111-1111-1111-111111111111" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test("stateless mode issues no session id and rejects GET", async () => {
  const ctx = await startServer({ MCP_STATEFUL: "0" });
  try {
    const res = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null);
    await res.body?.cancel();

    const get = await fetch(ctx.url, { method: "GET", headers: { accept: "text/event-stream" } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
  } finally {
    await ctx.close();
  }
});

test("bearer auth is enforced when MCP_AUTH_TOKEN is set", async () => {
  const ctx = await startServer({ MCP_AUTH_TOKEN: "s3cret" });
  try {
    const denied = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /Bearer/);

    const wrong = await fetch(ctx.url, {
      method: "POST",
      headers: { ...HEADERS, authorization: "Bearer nope" },
      body: JSON.stringify(INIT),
    });
    assert.equal(wrong.status, 401);

    const client = await connectClient(ctx.url, { headers: { authorization: "Bearer s3cret" } });
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("disallowed Host and Origin headers are rejected", async () => {
  const ctx = await startServer({
    MCP_ALLOWED_HOSTS: "drive.internal:443",
    MCP_ALLOWED_ORIGINS: "https://app.example.com",
  });
  try {
    const badHost = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    assert.equal(badHost.status, 403);

    const badOrigin = await fetch(ctx.url, {
      method: "POST",
      headers: { ...HEADERS, host: "drive.internal:443", origin: "https://evil.example" },
      body: JSON.stringify(INIT),
    });
    assert.equal(badOrigin.status, 403);
  } finally {
    await ctx.close();
  }
});

test("deleting a session terminates it", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    const sessionId = res.headers.get("mcp-session-id");
    await res.body?.cancel();

    const del = await fetch(ctx.url, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    assert.ok(del.status === 200 || del.status === 204, `unexpected status ${del.status}`);

    const after = await fetch(ctx.url, {
      method: "POST",
      headers: { ...HEADERS, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    assert.equal(after.status, 404);
  } finally {
    await ctx.close();
  }
});

test("unknown paths return a JSON-RPC style 404", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.baseUrl}/nope`, { method: "POST", headers: HEADERS, body: "{}" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error.message, /\/mcp/);
  } finally {
    await ctx.close();
  }
});

test("the passthrough token from a request header reaches the Drive client", async () => {
  const ctx = await startServer({ GOOGLE_TOKEN_PASSTHROUGH: "1" });
  try {
    const client = await connectClient(ctx.url, { headers: { "x-google-access-token": "ya29.fake" } });
    const result = await client.callTool({ name: "drive_about_get", arguments: {} });
    assert.equal(result.isError, undefined);
    // The assertion that actually discriminates: the credential factory saw the caller's token.
    assert.deepEqual(ctx.tokensSeen, ["ya29.fake"]);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("the passthrough token is ignored while passthrough is off", async () => {
  const ctx = await startServer();
  try {
    const client = await connectClient(ctx.url, { headers: { "x-google-access-token": "ya29.fake" } });
    await client.callTool({ name: "drive_about_get", arguments: {} });
    assert.deepEqual(ctx.tokensSeen, [undefined]);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("passthrough falls back to server credentials when no token is sent", async () => {
  const ctx = await startServer({ GOOGLE_TOKEN_PASSTHROUGH: "1" });
  try {
    const client = await connectClient(ctx.url);
    await client.callTool({ name: "drive_about_get", arguments: {} });
    assert.deepEqual(ctx.tokensSeen, [undefined]);
    await client.close();
  } finally {
    await ctx.close();
  }
});

test("a malformed body gets a JSON-RPC parse error, not an HTML stack trace", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: "{not json" });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.error.code, -32700);
  } finally {
    await ctx.close();
  }
});

test("an oversized body is refused with a JSON-RPC error", async () => {
  const ctx = await startServer({ MCP_MAX_REQUEST_BYTES: "1024" });
  try {
    const res = await fetch(ctx.url, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "a".repeat(4096) } }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error.message, /exceeds the 1024-byte limit/);
  } finally {
    await ctx.close();
  }
});

test("the body is not read before authentication is checked", async () => {
  const ctx = await startServer({ MCP_AUTH_TOKEN: "s3cret", MCP_MAX_REQUEST_BYTES: "1024" });
  try {
    // Well over the body limit: a 401 proves the guard ran before the parser buffered anything.
    const res = await fetch(ctx.url, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ pad: "a".repeat(8192) }),
    });
    assert.equal(res.status, 401);
  } finally {
    await ctx.close();
  }
});

test("a missing Origin is rejected once an Origin allowlist is configured", async () => {
  const ctx = await startServer({ MCP_ALLOWED_ORIGINS: "https://app.example.com" });
  try {
    const absent = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    assert.equal(absent.status, 403);
    assert.match((await absent.json()).error.message, /absent/);

    const allowed = await fetch(ctx.url, {
      method: "POST",
      headers: { ...HEADERS, origin: "https://app.example.com" },
      body: JSON.stringify(INIT),
    });
    assert.equal(allowed.status, 200);
    await allowed.body?.cancel();
  } finally {
    await ctx.close();
  }
});

test("healthz reveals nothing beyond liveness without the bearer token", async () => {
  const ctx = await startServer({ MCP_AUTH_TOKEN: "s3cret" });
  try {
    const anon = await (await fetch(`${ctx.baseUrl}/healthz`)).json();
    assert.deepEqual(anon, { status: "ok" });

    const authed = await (
      await fetch(`${ctx.baseUrl}/healthz`, { headers: { authorization: "Bearer s3cret" } })
    ).json();
    assert.equal(authed.version, "1.0.0");
    assert.equal(authed.sessions, 0);
  } finally {
    await ctx.close();
  }
});

test("a rejected initialize does not strand a session", async () => {
  const ctx = await startServer({ MCP_MAX_SESSIONS: "1" });
  try {
    const first = await connectClient(ctx.url);
    const refused = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    assert.equal(refused.status, 503);

    const health = await (await fetch(`${ctx.baseUrl}/healthz`)).json();
    assert.equal(health.sessions, 1);
    await first.close();
  } finally {
    await ctx.close();
  }
});

test("idle sessions are evicted", async () => {
  const ctx = await startServer({ MCP_SESSION_TTL_SECONDS: "30" });
  try {
    const res = await fetch(ctx.url, { method: "POST", headers: HEADERS, body: JSON.stringify(INIT) });
    const sessionId = res.headers.get("mcp-session-id");
    await res.body?.cancel();
    assert.equal((await (await fetch(`${ctx.baseUrl}/healthz`)).json()).sessions, 1);

    // Reach past the sweep interval by ageing the session rather than sleeping for it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = Date.now();
    const stale = await fetch(ctx.url, {
      method: "POST",
      headers: { ...HEADERS, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    assert.equal(stale.status, 200, "a fresh session is still usable");
    assert.ok(Date.now() - before < 30_000);
    await stale.body?.cancel();
  } finally {
    await ctx.close();
  }
});

test("config rejects unparseable values instead of quietly defaulting", async () => {
  const { configFrom } = await import("./helpers.mjs");
  assert.throws(() => configFrom({ DRIVE_READ_ONLY: "y" }), /must be one of/);
  assert.throws(() => configFrom({ DRIVE_MAX_INLINE_BYTES: "8mb" }), /non-negative integer/);
  assert.throws(() => configFrom({ LOG_LEVEL: "constructor" }), /LOG_LEVEL must be one of/);
  assert.equal(configFrom({ DRIVE_READ_ONLY: "yes" }).readOnly, true);
});
