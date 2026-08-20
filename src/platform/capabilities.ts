import type { Lifecycle, Platform } from "./types.js";

export type ActionName = "reply";

export interface TextLimits {
  readonly maxLength: number;
}

export interface AttachmentLimits {
  readonly maxCount: number;
  readonly mimeTypes: readonly string[];
  readonly maxBytes: number;
}

/** What a client is told about an operation. */
export type PublicOperation =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly actionableForHours: number | null;
      readonly text: TextLimits;
      readonly attachments: AttachmentLimits;
      /** Largest permitted `depth`, where a top-level comment is 0. */
      readonly maxDepth: number | null;
    };

export type OperationManifest =
  | { readonly supported: false }
  | (Extract<PublicOperation, { readonly supported: true }> & {
      /** Never published: a missing permission is fixed on the credential, not here. */
      readonly requiredScopes: readonly string[];
    });

export interface PlatformManifest {
  readonly platform: Platform;
  readonly operations: Readonly<Record<ActionName, OperationManifest>>;
}

export interface CapabilityDeclaration {
  readonly reply: PublicOperation;
}

export type Action =
  | { readonly status: "available"; readonly replyableUntil?: string }
  | {
      readonly status:
        | "unsupported"
        | "unauthorized"
        | "insufficient_scope"
        | "expired"
        | "forbidden_by_author"
        | "gone";
    };

export type CredentialState = "ok" | "expired" | "insufficient_scope" | "revoked";

export interface CredentialFacts {
  readonly state: CredentialState;
  /** `null` means the platform does not report composition, which differs from "none". */
  readonly grantedScopes: readonly string[] | null;
}

export interface ChannelFacts {
  readonly credential: CredentialFacts | null;
}

export interface CommentFacts {
  readonly createdAtRemote: Date;
  readonly lifecycle: Lifecycle;
  readonly replyDisabled: boolean;
}

export function declareCapabilities(manifest: PlatformManifest): CapabilityDeclaration {
  const reply = manifest.operations.reply;
  return {
    reply: reply.supported
      ? {
          supported: true,
          actionableForHours: reply.actionableForHours,
          text: reply.text,
          attachments: reply.attachments,
          maxDepth: reply.maxDepth,
        }
      : { supported: false },
  };
}

/**
 * Whether this operation can be carried out on this comment right now. Causes of
 * refusal are checked from the least fixable to the most, so the status names the
 * real obstacle: offering to reconnect an account is useless advice when the
 * comment has been deleted.
 */
export function resolveAction(
  manifest: PlatformManifest,
  channel: ChannelFacts,
  comment: CommentFacts,
  now: Date,
): Action {
  const op = manifest.operations.reply;

  if (!op.supported) {
    return { status: "unsupported" };
  }
  if (comment.lifecycle === "deleted") {
    return { status: "gone" };
  }
  if (comment.replyDisabled) {
    return { status: "forbidden_by_author" };
  }

  // Identity is required for any write even where the platform has no granular
  // permissions, so this cannot be folded into the scope check below.
  const credential = channel.credential;
  if (credential === null || credential.state === "revoked" || credential.state === "expired") {
    return { status: "unauthorized" };
  }
  if (credential.state === "insufficient_scope" || missesScopes(op.requiredScopes, credential)) {
    return { status: "insufficient_scope" };
  }

  if (op.actionableForHours === null) {
    return { status: "available" };
  }

  const deadline = new Date(
    comment.createdAtRemote.getTime() + op.actionableForHours * 3_600_000,
  );
  return deadline <= now
    ? { status: "expired" }
    : { status: "available", replyableUntil: deadline.toISOString() };
}

function missesScopes(required: readonly string[], credential: CredentialFacts): boolean {
  const granted = credential.grantedScopes;
  // NULL means the platform never told us which permissions it granted. Refusing
  // on that would hide an operation that works, so the call goes through and the
  // platform decides.
  if (granted === null) {
    return false;
  }
  return required.some((scope) => !granted.includes(scope));
}
