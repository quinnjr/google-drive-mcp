import { google, type drive_v3 } from "googleapis";
import type { AuthProvider } from "./auth.js";

export type Drive = drive_v3.Drive;

/** Builds a Drive v3 client bound to whichever credentials apply to the current request. */
export class DriveFactory {
  #auth: AuthProvider;

  constructor(auth: AuthProvider) {
    this.#auth = auth;
  }

  async client(): Promise<Drive> {
    const auth = await this.#auth.client();
    return google.drive({ version: "v3", auth: auth as never });
  }
}
