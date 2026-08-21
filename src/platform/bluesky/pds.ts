import { Agent, CredentialSession } from "@atproto/api";
import { DEFAULT_TIMEOUT_MS, toPlatformError, withTimeout } from "./transport.js";

/**
 * Where an app password is exchanged for a session. Repositories live elsewhere:
 * the login answers with the account's DID document and the client moves to the
 * host it names. Accounts on a self-hosted server cannot log in here.
 */
export const ENTRYWAY = "https://bsky.social";

export interface SessionOptions {
  /** Overrides the entryway, which is how tests keep the login local. */
  readonly serviceUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Safe to keep and to use concurrently: the refresh token rotates, so refreshes
 * are single-flight.
 */
export async function openSession(
  did: string,
  password: string,
  options: SessionOptions = {},
): Promise<Agent> {
  const session = new CredentialSession(
    new URL(options.serviceUrl ?? ENTRYWAY),
    withTimeout(options.fetchImpl ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );

  try {
    await session.login({ identifier: did, password });
  } catch (error) {
    throw toPlatformError(error, "login");
  }

  // A plain request handler, because the session as a whole does not satisfy the
  // agent's interface under `exactOptionalPropertyTypes`. It still signs each call
  // and addresses it to the host the account lives on.
  return new Agent((url, init) => session.fetchHandler(url, init));
}
