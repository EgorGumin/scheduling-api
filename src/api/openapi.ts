import { z } from "zod";
import { channelQuery, listQuery, replyBody, stateBody } from "./requests.js";
import { wire } from "./schemas.js";

type Json = Record<string, unknown>;

const COMPONENTS = "#/components/schemas";

/** Components are generated from the registry; the paths below are written by hand. */
export function openapiDocument(): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "Comments API",
      version: "0.1.0",
      description:
        "Reads comments across social platforms into one inbox, and sends replies back out.",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    paths: paths(),
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "In this build the token is the tenant id; a deployment substitutes its own check.",
        },
      },
    },
  };
}

function componentSchemas(): Json {
  const generated = z.toJSONSchema(wire, {
    uri: (id) => `${COMPONENTS}/${id}`,
    io: "output",
    target: "draft-2020-12",
  }).schemas;

  // Emitted for a standalone document; inside `components` the location is the identity.
  return Object.fromEntries(
    Object.entries(generated).map(([id, schema]) => {
      const { $schema, $id, ...rest } = schema as Json;
      return [id, rest];
    }),
  );
}

function queryParameters(schema: z.ZodType): Json[] {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, spec]) => ({
    name,
    in: "query",
    required: (json.required ?? []).includes(name),
    schema: spec,
  }));
}

function requestBody(schema: z.ZodType): Json {
  return {
    required: true,
    content: {
      "application/json": {
        schema: z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }),
      },
    },
  };
}

const pathId = (kind: string, name: string): Json => ({
  name,
  in: "path",
  required: true,
  schema: { $ref: `${COMPONENTS}/${kind}` },
});

const ok = (id: string, description: string): Json => ({
  description,
  content: { "application/json": { schema: { $ref: `${COMPONENTS}/${id}` } } },
});

function problems(...statuses: readonly [number, string][]): Json {
  return Object.fromEntries(
    statuses.map(([status, description]) => [
      String(status),
      {
        description,
        content: { "application/problem+json": { schema: { $ref: `${COMPONENTS}/Problem` } } },
      },
    ]),
  );
}

const UNAUTHENTICATED: [number, string] = [401, "No bearer token."];
const NOT_FOUND: [number, string] = [404, "No such object for this tenant."];
const MALFORMED: [number, string] = [
  400,
  "An unknown filter, a bad identifier, or a cursor this API did not issue.",
];

function paths(): Json {
  return {
    "/v1/comments": {
      get: {
        summary: "One page of the inbox, newest first",
        description:
          "Ordered by the ingest counter rather than by the platform's creation time: a comment the platform indexed late would otherwise be filed below a cursor the client has already passed.",
        parameters: queryParameters(listQuery),
        responses: {
          "200": ok("CommentPage", "Comments, with their posts side-loaded."),
          ...problems(MALFORMED, UNAUTHENTICATED),
        },
      },
    },
    "/v1/comments/capabilities": {
      get: {
        summary: "What the channel's platform allows",
        parameters: queryParameters(channelQuery),
        responses: {
          "200": ok("Capabilities", "The platform's published limits."),
          ...problems(MALFORMED, UNAUTHENTICATED, NOT_FOUND),
        },
      },
    },
    "/v1/comments/{commentId}": {
      get: {
        summary: "One comment",
        parameters: [pathId("CommentId", "commentId")],
        responses: {
          "200": ok("Comment", "The comment."),
          ...problems(MALFORMED, UNAUTHENTICATED, NOT_FOUND),
        },
      },
    },
    "/v1/comments/{commentId}/replies": {
      post: {
        summary: "Queue a reply",
        description:
          "The reply row and its delivery job are written in one transaction, so a reply that is acknowledged is a reply that will be attempted. Retrying with the same Idempotency-Key returns the first reply rather than posting a second.",
        parameters: [
          pathId("CommentId", "commentId"),
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", maxLength: 255 },
          },
          {
            name: "X-Actor-Id",
            in: "header",
            required: false,
            description: "Who is acting, as the caller says. Stored unread.",
            schema: { type: "string", maxLength: 128 },
          },
        ],
        requestBody: requestBody(replyBody),
        responses: {
          "200": ok("Reply", "This key was already used for this reply; its current status."),
          "202": ok("Reply", "Queued for delivery."),
          ...problems(
            MALFORMED,
            UNAUTHENTICATED,
            NOT_FOUND,
            [
              409,
              "The state refuses the reply: the key was used for a different body, the account is not connected or lacks a permission, or the platform's window has closed.",
            ],
            [
              422,
              "The body is empty, too long for the platform, or nested deeper than it allows.",
            ],
          ),
        },
      },
    },
    "/v1/replies/{replyId}": {
      get: {
        summary: "How far a queued reply got",
        parameters: [pathId("ReplyId", "replyId")],
        responses: {
          "200": ok("Reply", "The reply's current status."),
          ...problems(MALFORMED, UNAUTHENTICATED, NOT_FOUND),
        },
      },
    },
    "/v1/comments/{commentId}/state": {
      patch: {
        summary: "Record a decision about a comment",
        description:
          "Ours, not the platform's. A reply we sent has no state and is reported as missing.",
        parameters: [
          pathId("CommentId", "commentId"),
          {
            name: "X-Actor-Id",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 128 },
          },
        ],
        requestBody: requestBody(stateBody),
        responses: {
          "200": ok("TriageState", "The state as it now stands."),
          ...problems(MALFORMED, UNAUTHENTICATED, NOT_FOUND),
        },
      },
    },
  };
}
