import { Agent } from "@atproto/api";
import { DEFAULT_TIMEOUT_MS, withTimeout } from "./transport.js";

/** Answers reads without authentication, which is what makes the live tests possible. */
export const PUBLIC_APPVIEW = "https://public.api.bsky.app";

export interface AppViewOptions {
  readonly serviceUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Reads the aggregated network. Carries no session: none of these calls need one. */
export function openAppView(options: AppViewOptions = {}): Agent {
  return new Agent({
    service: options.serviceUrl ?? PUBLIC_APPVIEW,
    fetch: withTimeout(options.fetchImpl ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}
