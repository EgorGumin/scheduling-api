import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { logLevel } from "../config.js";
import {
  capabilityDeclarationSchema,
  declareCapabilities,
  type Action,
  type PlatformManifest,
} from "../platform/capabilities.js";
import { enqueueReply, type RejectionReason } from "../domain/replies/enqueue.js";
import { setHandling, triageStateSchema } from "../domain/triage.js";
import { ApiError, sendProblem } from "./errors.js";
import { channelPlatform, decodeCursor, getComment, listComments } from "./comments-query.js";
import { openapiDocument } from "./openapi.js";
import { replyStatus } from "./replies-query.js";
import { commentPageSchema, commentViewSchema, replyStatusSchema } from "./schemas.js";
import {
  actorOf,
  channelQuery,
  idempotencyKeyOf,
  listQuery,
  replyBody,
  requireId,
  stateBody,
  trustBearerAsTenantId,
  type Authenticate,
} from "./requests.js";

export interface ServerDeps {
  readonly db: Database;
  readonly manifests: Readonly<Record<string, PlatformManifest>>;
  readonly authenticate?: Authenticate;
  readonly logger?: FastifyServerOptions["logger"];
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? { level: logLevel } });
  const tenantOf = deps.authenticate ?? trustBearerAsTenantId;

  /**
   * A timestamp that a raw SQL projection returned as something else fails here,
   * before a client gets a field that matches nothing. Missing the schema is our
   * bug, so it answers 500.
   */
  function respond<T>(schema: z.ZodType<T>, value: NoInfer<T>): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    app.log.error({ issues: z.treeifyError(parsed.error) }, "response did not match its schema");
    throw new ApiError("internal", "the response did not match its schema");
  }

  async function statusOf(tenantId: string, replyId: string) {
    const status = await replyStatus(deps.db, tenantId, replyId);
    if (status === null) {
      throw new ApiError("internal", "the reply was written and then could not be read back");
    }
    return respond(replyStatusSchema, status);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return sendProblem(reply, error);
    }
    if (error instanceof z.ZodError) {
      return sendProblem(
        reply,
        new ApiError("invalid_request", "the request could not be understood", {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }
    request.log.error({ err: error }, "unhandled failure");
    return sendProblem(reply, new ApiError("internal", "unexpected failure"));
  });

  // Generated from the same schemas every response below is parsed against, and
  // the only route that takes no key.
  app.get("/v1/openapi.json", () => openapiDocument());

  app.get("/v1/comments", async (request) => {
    const tenantId = tenantOf(request);
    const query = listQuery.parse(request.query);

    if (query.cursor !== undefined && decodeCursor(query.cursor) === null) {
      throw new ApiError("invalid_request", "cursor is not one this API issued");
    }

    const page = await listComments(deps.db, deps.manifests, {
      tenantId,
      limit: query.limit,
      ...(query.channelId && { channelId: requireId("channel", query.channelId) }),
      ...(query.postId && { postIds: query.postId.map((id) => requireId("post", id)) }),
      ...(query.publisherPostId && { publisherPostIds: query.publisherPostId }),
      ...(query.handling && { handling: query.handling }),
      ...(query.lifecycle && { lifecycle: query.lifecycle }),
      ...(query.direction && { direction: query.direction }),
      ...(query.cursor && { cursor: query.cursor }),
    });

    return respond(commentPageSchema, {
      data: page.items,
      included: { posts: page.posts },
      page: { nextCursor: page.nextCursor },
    });
  });

  app.get("/v1/comments/capabilities", async (request) => {
    const tenantId = tenantOf(request);
    const query = channelQuery.parse(request.query);
    const channelId = requireId("channel", query.channelId);

    const platform = await channelPlatform(deps.db, tenantId, channelId);
    const manifest = platform === null ? undefined : deps.manifests[platform];
    if (manifest === undefined) {
      throw new ApiError("not_found", "no such channel");
    }
    return respond(capabilityDeclarationSchema, declareCapabilities(manifest));
  });

  app.get("/v1/comments/:commentId", async (request) => {
    const tenantId = tenantOf(request);
    const { commentId } = request.params as { commentId: string };
    const id = requireId("comment", commentId);
    const view = await getComment(deps.db, deps.manifests, tenantId, id);
    if (view === null) {
      throw new ApiError("not_found", "no such comment");
    }
    return respond(commentViewSchema, view);
  });

  app.post("/v1/comments/:commentId/replies", async (request, reply) => {
    const tenantId = tenantOf(request);
    const { commentId } = request.params as { commentId: string };
    const idempotencyKey = idempotencyKeyOf(request);
    const { body } = replyBody.parse(request.body);
    const result = await enqueueReply(deps.db, deps.manifests, {
      tenantId,
      commentId: requireId("comment", commentId),
      idempotencyKey,
      body,
      requestedBy: actorOf(request),
    });

    switch (result.outcome) {
      case "unknown_comment":
        throw new ApiError("not_found", "no such comment");
      case "rejected":
        throw rejectionToError(result);
      case "duplicate":
        return reply.status(200).send(await statusOf(tenantId, result.replyId));
      case "queued":
        return reply.status(202).send(await statusOf(tenantId, result.replyId));
    }
  });

  app.get("/v1/replies/:replyId", async (request) => {
    const tenantId = tenantOf(request);
    const { replyId } = request.params as { replyId: string };
    const status = await replyStatus(deps.db, tenantId, requireId("reply", replyId));
    if (status === null) {
      throw new ApiError("not_found", "no such reply");
    }
    return respond(replyStatusSchema, status);
  });

  app.patch("/v1/comments/:commentId/state", async (request) => {
    const tenantId = tenantOf(request);
    const { commentId } = request.params as { commentId: string };
    const id = requireId("comment", commentId);
    const patch = stateBody.parse(request.body);
    const actor = actorOf(request);

    const state = await setHandling(deps.db, tenantId, id, patch, actor);
    if (state === null) {
      throw new ApiError("not_found", "no such comment");
    }
    return respond(triageStateSchema, state);
  });

  return app;
}

function rejectionToError(result: { reason: RejectionReason; action?: Action }): ApiError {
  switch (result.reason) {
    case "idempotency_conflict":
      return new ApiError("idempotency_conflict", "this key was used for a different reply");
    case "body_too_long":
      return new ApiError("constraint_violated", "the reply is longer than the platform allows");
    case "body_empty":
      return new ApiError("constraint_violated", "the reply is empty");
    case "depth_exceeded":
      return new ApiError("constraint_violated", "the platform does not allow nesting this deep");
    case "action_unavailable":
      return unavailableToError(result.action);
  }
}

function unavailableToError(action: Action | undefined): ApiError {
  switch (action?.status) {
    case "unauthorized":
      return new ApiError("channel_unauthorized", "this channel has no connected account");
    case "insufficient_scope":
      return new ApiError("channel_insufficient_scope", "the connected account lacks a permission");
    case "expired":
      return new ApiError("window_expired", "the platform's reply window has closed");
    default:
      return new ApiError("action_unavailable", "replying is not possible for this comment", {
        action,
      });
  }
}
