import { XRPCError } from "@atproto/xrpc";
import { PlatformError, type PlatformErrorCode } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The SDK takes a fetch implementation, which is where a deadline can be imposed. */
export function withTimeout(doFetch: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => doFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Puts the SDK's failures into the port's taxonomy, by the status it reports. */
export function toPlatformError(error: unknown, what: string): PlatformError {
  if (error instanceof PlatformError) {
    return error;
  }
  if (!(error instanceof XRPCError)) {
    return new PlatformError("unavailable", `bluesky ${what} failed`, true, error);
  }

  // The SDK types this as its own enum, and every value below is an HTTP status.
  const status: number = error.status;

  // Status 1 is the SDK's own marker for a request that never got an answer;
  // status 2 means the answer did not match the lexicon.
  if (status === 1) {
    return new PlatformError("unavailable", `bluesky ${what} unreachable`, true, error);
  }
  if (status === 2) {
    return new PlatformError("unknown", `bluesky ${what} answered off-schema`, false, error);
  }

  return new PlatformError(
    codeForStatus(status, error.error),
    `bluesky ${what} failed with ${status}`,
    status === 429 || status >= 500,
    error.message,
  );
}

function codeForStatus(status: number, error: string): PlatformErrorCode {
  // XRPC reports a missing record as 400 with a name in the body, not as 404.
  if (status === 400 && error.includes("NotFound")) {
    return "not_found";
  }
  switch (status) {
    case 400:
      return "constraint_violated";
    case 401:
      return "unauthorized";
    case 403:
      return "permission_denied";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "unavailable" : "unknown";
  }
}
