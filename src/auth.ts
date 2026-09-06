import { readFileSync } from "node:fs";
import { GoogleAuth, JWT, OAuth2Client } from "google-auth-library";
import type { AuthClient } from "google-auth-library";
import type { Config } from "./config.js";
import { currentContext } from "./context.js";

/**
 * Resolves the Google credentials used for an API call, in priority order:
 *   1. a per-request access token (token-passthrough mode),
 *   2. an explicit OAuth2 refresh token / access token,
 *   3. an explicit service-account key (file or inline JSON),
 *   4. Application Default Credentials.
 */
export class AuthProvider {
  #config: Config;
  #shared: Promise<AuthClient> | undefined;

  constructor(config: Config) {
    this.#config = config;
  }

  /** Describes, without secrets, how the server will authenticate. */
  describe(): string {
    const c = this.#config;
    if (c.tokenPassthrough) return "per-request token (X-Google-Access-Token), falling back to server credentials";
    if (c.oauth.refreshToken || c.oauth.accessToken) return "oauth2 (env credentials)";
    if (c.serviceAccount.keyJson) return "service account (inline JSON)";
    if (c.serviceAccount.keyFile) return `service account (${c.serviceAccount.keyFile})`;
    return "application default credentials";
  }

  async client(): Promise<AuthClient> {
    const token = this.#config.tokenPassthrough ? currentContext().googleAccessToken : undefined;
    if (token) {
      const oauth = new OAuth2Client();
      oauth.setCredentials({ access_token: token });
      return oauth;
    }
    this.#shared ??= this.#build().catch((err) => {
      // Never cache a failed build; the next call retries.
      this.#shared = undefined;
      throw err;
    });
    return this.#shared;
  }

  async #build(): Promise<AuthClient> {
    const c = this.#config;

    if (c.oauth.refreshToken || c.oauth.accessToken) {
      if (c.oauth.refreshToken && !(c.oauth.clientId && c.oauth.clientSecret)) {
        throw new Error(
          "GOOGLE_REFRESH_TOKEN requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to be set as well.",
        );
      }
      const oauth = new OAuth2Client({
        clientId: c.oauth.clientId,
        clientSecret: c.oauth.clientSecret,
      });
      oauth.setCredentials({
        refresh_token: c.oauth.refreshToken,
        access_token: c.oauth.accessToken,
      });
      return oauth;
    }

    const rawKey = c.serviceAccount.keyJson
      ? c.serviceAccount.keyJson
      : c.serviceAccount.keyFile && c.serviceAccount.keyFile.endsWith(".json") && c.serviceAccount.subject
        ? readFileSync(c.serviceAccount.keyFile, "utf8")
        : undefined;

    if (rawKey) {
      let key: { client_email?: string; private_key?: string; type?: string };
      try {
        key = JSON.parse(rawKey);
      } catch {
        throw new Error("Service account key is not valid JSON.");
      }
      if (!key.client_email || !key.private_key) {
        throw new Error("Service account key is missing client_email or private_key.");
      }
      return new JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: c.scopes,
        subject: c.serviceAccount.subject,
      });
    }

    const auth = new GoogleAuth({
      scopes: c.scopes,
      ...(c.serviceAccount.keyFile ? { keyFile: c.serviceAccount.keyFile } : {}),
    });
    return auth.getClient();
  }
}
