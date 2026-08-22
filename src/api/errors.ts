import type { FastifyReply } from "fastify";
import { z } from "zod";

export const ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "not_found",
  "idempotency_conflict",
  "window_expired",
  "channel_unauthorized",
  "channel_insufficient_scope",
  "action_unavailable",
  "constraint_violated",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Five refusals share 409: the request is well formed, the state refuses it,
// and that state can change. 403 would mean the caller may never do this.
const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  // A resource belonging to another tenant is reported as missing rather than
  // forbidden, so the API never confirms that it exists.
  not_found: 404,
  idempotency_conflict: 409,
  window_expired: 409,
  channel_unauthorized: 409,
  channel_insufficient_scope: 409,
  action_unavailable: 409,
  constraint_violated: 422,
  internal: 500,
};

/**
 * RFC 9457. Extra keys pass through: a refusal may carry fields the caller can
 * act on — the query parameters that failed, the action that was unavailable.
 */
export const problemSchema = z.looseObject({
  type: z.string(),
  title: z.enum(ERROR_CODES),
  status: z.int(),
  detail: z.string(),
});

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export function sendProblem(reply: FastifyReply, error: ApiError): FastifyReply {
  const status = STATUS[error.code];
  return reply
    .status(status)
    .type("application/problem+json")
    .send(
      problemSchema.parse({
        ...error.extra,
        type: `about:blank#${error.code}`,
        title: error.code,
        status,
        detail: error.detail,
      }),
    );
}
