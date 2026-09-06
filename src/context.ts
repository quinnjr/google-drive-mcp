import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Caller-supplied Google OAuth access token (token-passthrough mode). */
  googleAccessToken?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? {};
}
