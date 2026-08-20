import { PlatformError, type PlatformErrorCode } from "../types.js";

/** Answers reads without authentication, which is what makes the live tests possible. */
export const PUBLIC_APPVIEW = "https://public.api.bsky.app";

const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of an error body is kept as detail. */
const MAX_DETAIL_CHARS = 500;

export interface AppViewOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class AppViewClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: AppViewOptions = {}) {
    this.baseUrl = options.baseUrl ?? PUBLIC_APPVIEW;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  async query<T>(method: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(`/xrpc/${method}`, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new PlatformError("unavailable", `bluesky ${method} unreachable`, true, cause);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new PlatformError(
        codeForStatus(response.status, body),
        `bluesky ${method} failed with ${response.status}`,
        response.status === 429 || response.status >= 500,
        body.slice(0, MAX_DETAIL_CHARS),
      );
    }

    return (await response.json()) as T;
  }
}

function codeForStatus(status: number, body: string): PlatformErrorCode {
  // XRPC reports a missing record as 400 with a name in the body, not as 404.
  if (status === 400 && body.includes("NotFound")) {
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
