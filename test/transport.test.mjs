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
    await client.close();
  } finally {
    await ctx.close();
  }
});
