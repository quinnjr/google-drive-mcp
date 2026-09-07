import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthProvider } from "../dist/auth.js";
import { configFrom } from "./helpers.mjs";

// Generated per run rather than checked in, so no key-shaped literal lives in the repository.
// It is never used against Google; it only has to be well-formed enough to build a JWT client.
const KEY = {
  type: "service_account",
  project_id: "test",
  client_email: "robot@test.iam.gserviceaccount.com",
  private_key: generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
};

function keyFileNamed(basename) {
  const dir = mkdtempSync(join(tmpdir(), "gdrive-mcp-"));
  const path = join(dir, basename);
  writeFileSync(path, JSON.stringify(KEY));
  return path;
}

test("impersonation applies regardless of the key file's name", async () => {
  for (const basename of ["key.json", "key"]) {
    const path = keyFileNamed(basename);
    const provider = new AuthProvider(
      configFrom({
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path,
        GOOGLE_IMPERSONATE_SUBJECT: "boss@corp.com",
      }),
    );
    const client = await provider.client();
    // Mounted secrets are routinely extensionless; both spellings must impersonate.
    assert.equal(client.subject, "boss@corp.com", basename);
    assert.equal(client.email, KEY.client_email, basename);
  }
});

test("describe() states who is being impersonated", () => {
  const path = keyFileNamed("key");
  const provider = new AuthProvider(
    configFrom({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: path, GOOGLE_IMPERSONATE_SUBJECT: "boss@corp.com" }),
  );
  assert.match(provider.describe(), /impersonating boss@corp\.com/);
});

test("an unreadable or malformed key file fails loudly", async () => {
  const missing = new AuthProvider(
    configFrom({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/nonexistent/key", GOOGLE_IMPERSONATE_SUBJECT: "a@b.com" }),
  );
  await assert.rejects(() => missing.client(), /Cannot read service account key/);

  const dir = mkdtempSync(join(tmpdir(), "gdrive-mcp-"));
  const bad = join(dir, "key");
  writeFileSync(bad, "not json");
  const malformed = new AuthProvider(
    configFrom({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: bad, GOOGLE_IMPERSONATE_SUBJECT: "a@b.com" }),
  );
  await assert.rejects(() => malformed.client(), /not valid JSON/);
});

test("a failed credential build is not cached", async () => {
  const provider = new AuthProvider(
    configFrom({ GOOGLE_REFRESH_TOKEN: "rt" }), // missing client id/secret
  );
  await assert.rejects(() => provider.client(), /GOOGLE_CLIENT_ID/);
  await assert.rejects(() => provider.client(), /GOOGLE_CLIENT_ID/);
});
