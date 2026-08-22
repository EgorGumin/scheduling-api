import type { PlatformManifest } from "./capabilities.js";
import type { Platform } from "./types.js";

/**
 * Replies with attachments are out of scope for now. The limits are declared
 * anyway, so supporting them later changes a number rather than the model.
 */
const noAttachments = { maxCount: 0, mimeTypes: [], maxBytes: 0 };

export const blueskyManifest: PlatformManifest = {
  platform: "bluesky",
  operations: {
    reply: {
      supported: true,
      // An app-password session authorises the whole account, so there is no
      // granular permission to withhold on locally.
      requiredScopes: [],
      actionableForHours: null,
      // 300 graphemes and 3000 bytes, both enforced by the platform.
      text: { maxLength: 300, counts: "graphemes", maxBytes: 3000 },
      attachments: noAttachments,
      maxDepth: null,
    },
  },
};

export const instagramManifest: PlatformManifest = {
  platform: "instagram",
  operations: {
    reply: {
      supported: true,
      requiredScopes: ["instagram_manage_comments"],
      actionableForHours: null,
      text: { maxLength: 2200, counts: "utf16", maxBytes: null },
      attachments: noAttachments,
      maxDepth: 1,
    },
  },
};

export const facebookManifest: PlatformManifest = {
  platform: "facebook",
  operations: {
    reply: {
      supported: true,
      requiredScopes: ["pages_manage_engagement", "pages_read_engagement"],
      actionableForHours: null,
      text: { maxLength: 8000, counts: "utf16", maxBytes: null },
      attachments: noAttachments,
      maxDepth: 1,
    },
  },
};

export const youtubeManifest: PlatformManifest = {
  platform: "youtube",
  operations: {
    reply: {
      supported: true,
      requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
      actionableForHours: null,
      text: { maxLength: 10000, counts: "utf16", maxBytes: null },
      attachments: noAttachments,
      maxDepth: 1,
    },
  },
};

/**
 * Only platforms with an adapter behind them. The other manifests above are the
 * model written down; adding one here without a client would have the API answer
 * for a platform it cannot reach.
 */
export const manifests: Readonly<Partial<Record<Platform, PlatformManifest>>> = {
  bluesky: blueskyManifest,
};
