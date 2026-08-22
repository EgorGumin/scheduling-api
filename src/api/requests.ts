import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HANDLING } from "../domain/triage.js";
import { LIFECYCLE } from "../platform/types.js";
import { ApiError } from "./errors.js";
import { decodeId, type IdKind } from "./ids.js";

/** Identifies the tenant a request may act for, or throws `ApiError`. */
export type Authenticate = (request: FastifyRequest) => string;

/**
 * Not authentication: this takes the bearer token to be the tenant id without
 * checking it, so holding an id is enough to act as that tenant. Identity is out
 * of scope here; a deployment passes its own check in as `authenticate`.
 */
export const trustBearerAsTenantId: Authenticate = (request) => {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") === true ? header.slice(7).trim() : "";
  if (!isUuid(token)) {
    throw new ApiError("unauthenticated", "a bearer API key is required");
  }
  return token;
};

/** Asking for a value twice changes nothing, so the vocabulary is also the limit. */
const commaSeparated = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.enum(values)).min(1).max(values.length))
    .meta({ description: `Comma-separated, any of: ${values.join(", ")}.` });

const MAX_IDS = 50;

const commaSeparatedIds = z
  .string()
  .transform((value) => value.split(","))
  .pipe(z.array(z.string()).min(1).max(MAX_IDS))
  .meta({ description: `Comma-separated, at most ${MAX_IDS}.` });

export const listQuery = z
  .object({
    channelId: z.string().optional(),
    postId: commaSeparatedIds.optional(),
    /** The publishing module's own identifier, for a caller that never saw ours. */
    publisherPostId: commaSeparatedIds.optional(),
    handling: commaSeparated(HANDLING).optional(),
    lifecycle: commaSeparated(LIFECYCLE).optional(),
    direction: z.enum(["inbound", "outbound"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z
      .string()
      .meta({ description: "The `page.nextCursor` of a previous response." })
      .optional(),
  })
  // A misspelled filter would otherwise be ignored, and the caller would read an
  // unfiltered page as a filtered one.
  .strict();

export const channelQuery = z.object({ channelId: z.string() }).strict();

export const replyBody = z.object({ body: z.string().min(1).max(10_000) }).strict();

export const stateBody = z
  .object({
    handling: z.enum(HANDLING).optional(),
    note: z.string().max(2_000).nullish(),
  })
  .strict()
  .refine((value) => value.handling !== undefined || value.note !== undefined, {
    message: "nothing to change",
  });

/** The identifier as this API issues it, decoded, or a refusal naming the kind. */
export function requireId(kind: IdKind, value: string): string {
  const decoded = decodeId(kind, value);
  if (decoded === null) {
    throw new ApiError("invalid_request", `${value} is not a valid ${kind} identifier`);
  }
  return decoded;
}

/** Who is acting, as the caller says. Opaque to us and stored unread. */
export function actorOf(request: FastifyRequest): string | null {
  const actor = request.headers["x-actor-id"];
  if (typeof actor !== "string") {
    return null;
  }
  if (actor.length > 128) {
    throw new ApiError("invalid_request", "X-Actor-Id must be at most 128 characters");
  }
  return actor;
}

export function idempotencyKeyOf(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length === 0) {
    throw new ApiError("invalid_request", "Idempotency-Key is required");
  }
  // The key is stored in a unique index, and past the btree entry limit
  // Postgres refuses the row: a failure from the database instead of this one.
  if (key.length > 255) {
    throw new ApiError("invalid_request", "Idempotency-Key must be at most 255 characters");
  }
  return key;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
