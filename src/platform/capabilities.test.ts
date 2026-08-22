import { describe, expect, it } from "vitest";
import {
  declareCapabilities,
  resolveAction,
  type ChannelFacts,
  type CommentFacts,
  type PlatformManifest,
} from "./capabilities.js";
import { blueskyManifest, instagramManifest } from "./manifests.js";

const NOW = new Date("2026-08-20T12:00:00Z");

const connected: ChannelFacts = {
  credential: { state: "ok", grantedScopes: ["instagram_manage_comments"] },
};
const readOnly: ChannelFacts = { credential: null };

const liveComment: CommentFacts = {
  createdAtRemote: new Date("2026-08-20T11:00:00Z"),
  lifecycle: "active",
  replyDisabled: false,
};

const withWindow = (hours: number | null): PlatformManifest => ({
  platform: "instagram",
  operations: {
    reply: {
      supported: true,
      requiredScopes: [],
      actionableForHours: hours,
      text: { maxLength: 100, counts: "graphemes", maxBytes: null },
      attachments: { maxCount: 0, mimeTypes: [], maxBytes: 0 },
      maxDepth: 1,
    },
  },
});

describe("channel declaration", () => {
  it("reports what the platform can do, with limits attached", () => {
    const declaration = declareCapabilities(blueskyManifest);
    expect(declaration.reply).toEqual({
      supported: true,
      actionableForHours: null,
      text: { maxLength: 300, counts: "graphemes", maxBytes: 3000 },
      attachments: { maxCount: 0, mimeTypes: [], maxBytes: 0 },
      maxDepth: null,
    });
  });

  it("carries no limits for an unsupported operation, by type", () => {
    const manifest: PlatformManifest = {
      platform: "youtube",
      operations: { reply: { supported: false } },
    };
    expect(declareCapabilities(manifest).reply).toEqual({ supported: false });
  });
});

describe("object availability", () => {
  it("is unsupported when the platform cannot do it at all", () => {
    const manifest: PlatformManifest = {
      platform: "youtube",
      operations: { reply: { supported: false } },
    };
    expect(resolveAction(manifest, connected, liveComment, NOW)).toEqual({
      status: "unsupported",
    });
  });

  it("reports a deleted comment as gone before anything else", () => {
    const deleted = { ...liveComment, lifecycle: "deleted" as const };
    expect(resolveAction(instagramManifest, readOnly, deleted, NOW)).toEqual({
      status: "gone",
    });
  });

  it("reports an author-imposed restriction as such", () => {
    const restricted = { ...liveComment, replyDisabled: true };
    expect(resolveAction(blueskyManifest, connected, restricted, NOW)).toEqual({
      status: "forbidden_by_author",
    });
  });

  it("needs a connected account even where the platform has no scopes", () => {
    expect(blueskyManifest.operations.reply).toMatchObject({ requiredScopes: [] });
    expect(resolveAction(blueskyManifest, readOnly, liveComment, NOW)).toEqual({
      status: "unauthorized",
    });
  });

  it("treats a revoked or expired credential as unauthorized", () => {
    for (const state of ["revoked", "expired"] as const) {
      const channel: ChannelFacts = { credential: { state, grantedScopes: null } };
      expect(resolveAction(blueskyManifest, channel, liveComment, NOW)).toEqual({
        status: "unauthorized",
      });
    }
  });

  it("distinguishes a missing scope from a missing account", () => {
    const channel: ChannelFacts = { credential: { state: "ok", grantedScopes: [] } };
    expect(resolveAction(instagramManifest, channel, liveComment, NOW)).toEqual({
      status: "insufficient_scope",
    });
  });

  it("does not guess when the platform withholds scope composition", () => {
    const channel: ChannelFacts = { credential: { state: "ok", grantedScopes: null } };
    expect(resolveAction(instagramManifest, channel, liveComment, NOW)).toEqual({
      status: "available",
    });
  });

  it("closes the window once the deadline passes", () => {
    const manifest = withWindow(24);
    const old: CommentFacts = { ...liveComment, createdAtRemote: new Date("2026-08-18T00:00:00Z") };
    expect(resolveAction(manifest, connected, old, NOW)).toEqual({ status: "expired" });
  });

  it("hands out the exact deadline while the window is open", () => {
    const manifest = withWindow(24);
    const action = resolveAction(manifest, connected, liveComment, NOW);
    expect(action).toEqual({
      status: "available",
      replyableUntil: "2026-08-21T11:00:00.000Z",
    });
  });

  it("omits a deadline when the operation has no window", () => {
    const action = resolveAction(withWindow(null), connected, liveComment, NOW);
    expect(action).toEqual({ status: "available" });
    expect(action).not.toHaveProperty("replyableUntil");
  });
});
