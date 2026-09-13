import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { keyringNeeded, resolveConfig } from "../dist/config.js";
import {
  credentialsFromKeyring,
  KEYRING_ACCOUNTS,
  KEYRING_SERVICE,
  loadNativeEntry,
  readKeyring,
} from "../dist/keyring.js";
import { configFrom } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const hasNativeKeyring = (() => {
  try {
    // Actually load the package: resolution succeeding does not mean the platform binding loads.
    require("@napi-rs/keyring");
    return true;
  } catch {
    return false;
  }
})();

const CREDENTIAL_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_KEY_JSON",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

/** Runs `fn` with only `overrides` set among the credential variables. */
async function withCredentialEnv(overrides, fn) {
  const saved = new Map(CREDENTIAL_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of CREDENTIAL_ENV) delete process.env[k];
    Object.assign(process.env, overrides);
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A stand-in for @napi-rs/keyring's AsyncEntry that records lookups and can fail or wedge. */
function fakeEntry(passwords, { fail = new Set(), calls = [], wedge = new Set() } = {}) {
  return class {
    constructor(service, account) {
      calls.push({ service, account });
      this.service = service;
      this.account = account;
    }
    getPassword(signal) {
      if (wedge.has(this.account)) {
        // Model the real binding: a started native task is not cancelled by the abort signal.
        return new Promise(() => {});
      }
      if (fail.has(this.account)) return Promise.reject(new Error("credential store is locked"));
      return Promise.resolve(passwords[this.account] ?? null);
    }
  };
}

test("readKeyring reads each documented account under the google-drive-mcp service", async () => {
  const calls = [];
  const Entry = fakeEntry(
    {
      "oauth-client-id": "id-123",
      "oauth-client-secret": "secret-456",
      "oauth-refresh-token": "refresh-789",
      "oauth-access-token": "access-abc",
      "service-account-key": '{"type":"service_account"}',
    },
    { calls },
  );

  const creds = await readKeyring(Entry);

  assert.deepEqual(creds, {
    clientId: "id-123",
    clientSecret: "secret-456",
    refreshToken: "refresh-789",
    accessToken: "access-abc",
    serviceAccountKey: '{"type":"service_account"}',
  });
  assert.deepEqual(
    calls.map((c) => c.account),
    ["oauth-client-id", "oauth-client-secret", "oauth-refresh-token", "oauth-access-token", "service-account-key"],
  );
  assert.ok(calls.every((c) => c.service === KEYRING_SERVICE));
});

test("readKeyring bounds a lookup the native abort cannot cancel", async () => {
  const creds = await readKeyring(
    fakeEntry({ "oauth-refresh-token": "ok" }, { wedge: new Set(["oauth-client-id"]) }),
    undefined,
    20,
  );

  assert.equal(creds.clientId, undefined);
  assert.equal(creds.refreshToken, "ok");
});

test("readKeyring maps an absent entry to undefined instead of a null string", async () => {
  const creds = await readKeyring(fakeEntry({ "oauth-refresh-token": "only-this" }));
  assert.equal(creds.refreshToken, "only-this");
  assert.equal(creds.clientId, undefined);
  assert.equal(creds.serviceAccountKey, undefined);
});

test("readKeyring treats an empty stored secret as absent", async () => {
  const creds = await readKeyring(fakeEntry({ "oauth-client-secret": "" }));
  assert.equal(creds.clientSecret, undefined);
});

test("readKeyring keeps the other credentials when one entry cannot be read", async () => {
  const Entry = fakeEntry(
    { "oauth-client-id": "id-123", "oauth-refresh-token": "refresh-789" },
    { fail: new Set(["oauth-client-secret"]) },
  );

  const creds = await readKeyring(Entry);

  assert.equal(creds.clientId, "id-123");
  assert.equal(creds.refreshToken, "refresh-789");
  assert.equal(creds.clientSecret, undefined);
});

test("credentialsFromKeyring returns nothing when the native module is unavailable", async () => {
  assert.deepEqual(
    await credentialsFromKeyring(() => {
      throw new Error("cannot find native binding");
    }),
    {},
  );
});

test("credentialsFromKeyring returns nothing when the module has no usable Entry", async () => {
  assert.deepEqual(await credentialsFromKeyring(() => undefined), {});
});

test("credentialsFromKeyring reads through an injected native module", async () => {
  const creds = await credentialsFromKeyring(() => fakeEntry({ "oauth-refresh-token": "refresh-789" }));
  assert.deepEqual(creds, {
    clientId: undefined,
    clientSecret: undefined,
    refreshToken: "refresh-789",
    accessToken: undefined,
    serviceAccountKey: undefined,
  });
});

test("the real native loader and reader work end to end", { skip: !hasNativeKeyring }, async () => {
  const creds = await readKeyring(loadNativeEntry(), undefined, 500);
  assert.equal(typeof creds, "object");
});

test("keyringNeeded() reflects whether the environment can satisfy credentials", async () => {
  const cases = [
    [{}, true],
    [{ GOOGLE_ACCESS_TOKEN: "at" }, false],
    [{ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "rt" }, false],
    [{ GOOGLE_REFRESH_TOKEN: "rt" }, true],
    // A refresh token plus an access token is still not usable without the client id and secret.
    [{ GOOGLE_REFRESH_TOKEN: "rt", GOOGLE_ACCESS_TOKEN: "at" }, true],
    [{ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }, true],
    [{ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/tmp/sa.json" }, false],
    [{ GOOGLE_SERVICE_ACCOUNT_KEY_JSON: "{}" }, false],
    [{ GOOGLE_CLIENT_ID: "id", GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/tmp/sa.json" }, true],
  ];
  for (const [env, expected] of cases) {
    assert.equal(await withCredentialEnv(env, () => keyringNeeded()), expected, JSON.stringify(env));
  }
});

test("resolveConfig reads libsecret only when the environment is incomplete", async () => {
  let reads = 0;
  const config = await withCredentialEnv({}, () =>
    resolveConfig({
      needed: () => true,
      read: async () => {
        reads += 1;
        return { clientId: "id", clientSecret: "s", refreshToken: "rt" };
      },
    }),
  );

  assert.equal(reads, 1);
  assert.equal(config.oauth.refreshToken, "rt");
  assert.equal(config.oauth.source, "libsecret");
});

test("resolveConfig skips libsecret when the environment already satisfies credentials", async () => {
  let reads = 0;
  const config = await withCredentialEnv(
    { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "rt" },
    () =>
      resolveConfig({
        needed: () => false,
        read: async () => {
          reads += 1;
          return { clientId: "keyring-id" };
        },
      }),
  );

  assert.equal(reads, 0);
  assert.equal(config.oauth.clientId, "id");
  assert.equal(config.oauth.source, "env");
});

test("config fills credential gaps from libsecret while env still wins", () => {
  const config = configFrom(
    { GOOGLE_CLIENT_ID: "env-id", GOOGLE_REFRESH_TOKEN: "env-refresh" },
    { clientId: "keyring-id", clientSecret: "keyring-secret", refreshToken: "keyring-refresh" },
  );

  assert.equal(config.oauth.clientId, "env-id");
  assert.equal(config.oauth.refreshToken, "env-refresh");
  assert.equal(config.oauth.clientSecret, "keyring-secret");
  assert.equal(config.oauth.source, "env+libsecret");
});

test("config sources a service account from libsecret when no env credential is set", () => {
  const config = configFrom({}, { serviceAccountKey: '{"type":"service_account"}' });

  assert.equal(config.serviceAccount.keyJson, '{"type":"service_account"}');
  assert.equal(config.oauth.source, "none");
  assert.equal(config.serviceAccount.source, "libsecret");
});

test("config reports an env-only credential source when libsecret has nothing", () => {
  const config = configFrom({ GOOGLE_REFRESH_TOKEN: "env-refresh" });
  assert.equal(config.oauth.source, "env");
  assert.equal(config.serviceAccount.source, "none");
});

test("config treats a blank env value as unset and lets libsecret fill it", () => {
  const config = configFrom({ GOOGLE_CLIENT_SECRET: "" }, { clientSecret: "keyring-secret" });
  assert.equal(config.oauth.clientSecret, "keyring-secret");
});

test("an env service-account key file is not overridden by a libsecret key", () => {
  const config = configFrom(
    { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/tmp/sa.json" },
    { serviceAccountKey: '{"type":"service_account"}' },
  );

  assert.equal(config.serviceAccount.keyFile, "/tmp/sa.json");
  assert.equal(config.serviceAccount.keyJson, undefined);
  assert.equal(config.serviceAccount.source, "env");
});

test("the documented account names match the code", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

  assert.ok(readme.includes(KEYRING_SERVICE) && envExample.includes(KEYRING_SERVICE));
  for (const account of KEYRING_ACCOUNTS) {
    assert.ok(readme.includes(`\`${account}\``), `README should document ${account}`);
    assert.ok(envExample.includes(account), `.env.example should document ${account}`);
  }
});
