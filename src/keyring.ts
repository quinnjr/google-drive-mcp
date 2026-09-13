import { createRequire } from "node:module";
import { log } from "./log.js";

/** The async Secret Service entry type from @napi-rs/keyring, referenced without importing it. */
export type EntryCtor = typeof import("@napi-rs/keyring").AsyncEntry;

/** Service name every credential entry is stored under. */
export const KEYRING_SERVICE = "google-drive-mcp";

/** Upper bound on a single Secret Service lookup, so a wedged D-Bus call cannot hang startup. */
export const KEYRING_TIMEOUT_MS = 5000;

const ACCOUNTS = {
  clientId: "oauth-client-id",
  clientSecret: "oauth-client-secret",
  refreshToken: "oauth-refresh-token",
  accessToken: "oauth-access-token",
  serviceAccountKey: "service-account-key",
} as const;

/** The account names, in the order the README and .env.example document them. */
export const KEYRING_ACCOUNTS: readonly string[] = Object.freeze(Object.values(ACCOUNTS));

export interface KeyringCredentials {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  serviceAccountKey?: string;
}

/**
 * Reads every credential entry from libsecret. A missing entry is skipped, and a locked, unreadable
 * or timed-out entry is logged and skipped without discarding the others. The lookups run in
 * parallel and are collectively bounded by `timeoutMs`.
 *
 * The native abort signal only rejects a lookup that has not started; a race against a timer is what
 * actually bounds an already-wedged call. The `Entry` constructor itself is synchronous and runs
 * before the race — a bus that blocks during store setup still blocks the event loop and is not
 * covered by this timeout.
 */
export async function readKeyring(
  Entry: EntryCtor,
  service = KEYRING_SERVICE,
  timeoutMs = KEYRING_TIMEOUT_MS,
): Promise<KeyringCredentials> {
  const read = async (account: string): Promise<string | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const entry = new Entry(service, account);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      const value = await Promise.race([entry.getPassword(AbortSignal.timeout(timeoutMs)), deadline]);
      if (value === "") {
        log("warn", `libsecret entry ${service}/${account} is empty`);
        return undefined;
      }
      return value || undefined;
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError" || /timed out/.test(error.message)) {
        log("warn", `libsecret read timed out after ${timeoutMs}ms for ${service}/${account}`);
      } else {
        log("warn", `libsecret read failed for ${service}/${account}: ${error.message}`);
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const entries = Object.entries(ACCOUNTS) as [keyof KeyringCredentials, string][];
  const values = await Promise.all(entries.map(([, account]) => read(account)));
  return Object.fromEntries(entries.map(([field], index) => [field, values[index]])) as KeyringCredentials;
}

// A static ESM import throws at load time when no prebuilt binding exists for the platform, which
// would take the whole server down. Require lazily so a missing keyring just means "no credentials".
const require = createRequire(import.meta.url);

export function loadNativeEntry(): EntryCtor {
  return (require("@napi-rs/keyring") as typeof import("@napi-rs/keyring")).AsyncEntry;
}

/**
 * Credentials found in libsecret, or {} when the native module or the keyring is unavailable. A
 * missing binding and a module without a usable `AsyncEntry` are both skipped; a store that is
 * present but broken surfaces as a per-entry warning from readKeyring instead of disappearing.
 */
export async function credentialsFromKeyring(
  load: () => EntryCtor = loadNativeEntry,
): Promise<KeyringCredentials> {
  let Entry: EntryCtor;
  try {
    Entry = load();
  } catch (err) {
    log("debug", `libsecret unavailable, skipping keyring: ${(err as Error).message}`);
    return {};
  }
  if (typeof Entry !== "function") {
    log("debug", "libsecret module has no usable AsyncEntry, skipping keyring");
    return {};
  }
  return readKeyring(Entry);
}
