import { describe, expect, it } from "vitest";
import { openapiDocument } from "./openapi.js";
import { commentViewSchema } from "./schemas.js";

const HEX = "0".repeat(32);

const comment = {
  id: `cmt_${HEX}`,
  channelId: `chn_${HEX}`,
  postId: `pst_${HEX}`,
  platform: "bluesky",
  parentId: null,
  depth: 0,
  author: { id: "did:plc:x", displayName: null, handle: "a.bsky.social" },
  body: "hello",
  media: [],
  direction: "inbound",
  lifecycle: "active",
  createdAt: "2026-08-22T10:00:00.000Z",
  editedAt: null,
  firstSeenAt: "2026-08-22T10:00:01.000Z",
  state: { handling: "new", handledAt: null, handledBy: null, note: null },
  actions: { reply: { status: "available" } },
  replyIds: [],
};

const name = (ref: string): string => ref.replace("#/components/schemas/", "");

function refs(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(refs);
  }
  if (node === null || typeof node !== "object") {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : refs(value),
  );
}

describe("the published document", () => {
  const document = openapiDocument();
  const schemas = (document["components"] as { schemas: Record<string, unknown> }).schemas;

  it("leaves no reference dangling", () => {
    const missing = [...new Set(refs(document))].filter((ref) => !(name(ref) in schemas));
    expect(missing).toEqual([]);
  });

  it("reaches every schema it declares", () => {
    // A component nothing links to was described and then never attached to a route.
    const reached = new Set<string>();
    const walk = (node: unknown): void => {
      for (const ref of refs(node)) {
        if (!reached.has(name(ref))) {
          reached.add(name(ref));
          walk(schemas[name(ref)]);
        }
      }
    };
    walk(document["paths"]);
    expect([...reached].sort()).toEqual(Object.keys(schemas).sort());
  });

  it("describes every route the server answers", () => {
    expect(Object.keys(document["paths"] as object).sort()).toEqual([
      "/v1/comments",
      "/v1/comments/capabilities",
      "/v1/comments/{commentId}",
      "/v1/comments/{commentId}/replies",
      "/v1/comments/{commentId}/state",
      "/v1/replies/{replyId}",
    ]);
  });
});

describe("validating on the way out", () => {
  it("accepts what the read side builds", () => {
    expect(commentViewSchema.parse(comment)).toMatchObject({ id: comment.id });
  });

  it("refuses a timestamp that is not one", () => {
    // A raw SQL projection hands back whatever the driver made of the column.
    const parsed = commentViewSchema.safeParse({ ...comment, createdAt: 1_755_856_800 });
    expect(parsed.success).toBe(false);
  });

  it("refuses an identifier without its kind", () => {
    const parsed = commentViewSchema.safeParse({ ...comment, id: HEX });
    expect(parsed.success).toBe(false);
  });
});
