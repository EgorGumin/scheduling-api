import { expect, it } from "vitest";
import type { CommentProvider } from "./port.js";
import { PlatformError, type ChannelContext } from "./types.js";

/** An adapter plus what it takes to call it. Adding a platform means writing one of these. */
export interface ConformanceCase {
  readonly provider: CommentProvider;
  readonly ctx: ChannelContext;
  /** A post the provider can answer for, with at least one comment under it. */
  readonly postExternalId: string;
  /** Shaped like the platform's identifiers, but pointing at nothing. */
  readonly unknownExternalId: string;
}

/** A reply identifier, since the port promises one and adapters may derive a key from it. */
const REPLY_ID = "01a01fc6-0000-7000-8000-000000000001";

/**
 * Every adapter has to behave the same way in a few respects: a comment
 * belongs to the post that was asked for, identifiers do not repeat, dates parse,
 * `since` narrows the answer, errors say whether another attempt is worth making.
 * The projector and the reconciler rely on all of that and branch on no platform
 * name.
 *
 * These are those assumptions, checked against each adapter. An adapter that
 * breaks one fails here rather than somewhere in the domain, and a port shaped
 * around one platform shows up as another adapter failing.
 *
 * `load` is called again for every assertion, so no adapter carries state from
 * one to the next.
 */
export function runConformance(name: string, load: () => Promise<ConformanceCase>): void {
  it(`${name}: returns comments anchored to the post that was asked for`, async () => {
    const { provider, ctx, postExternalId } = await load();
    const page = await provider.listComments(ctx, { postExternalId });

    expect(page.items.length).toBeGreaterThan(0);
    for (const comment of page.items) {
      expect(comment.postExternalId).toBe(postExternalId);
      expect(comment.externalId).toBeTruthy();
    }
  });

  it(`${name}: hands back identifiers that are unique within the page`, async () => {
    const { provider, ctx, postExternalId } = await load();
    const page = await provider.listComments(ctx, { postExternalId });
    const ids = page.items.map((comment) => comment.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(`${name}: dates are real dates, and creation never post-dates the version`, async () => {
    const { provider, ctx, postExternalId } = await load();
    const page = await provider.listComments(ctx, { postExternalId });

    for (const comment of page.items) {
      expect(Number.isNaN(comment.createdAtRemote.getTime())).toBe(false);
      if (comment.remoteVersion !== null) {
        expect(comment.remoteVersion.getTime()).toBeGreaterThanOrEqual(
          comment.createdAtRemote.getTime() - 1000,
        );
      }
    }
  });

  it(`${name}: media entries are http references`, async () => {
    const { provider, ctx, postExternalId } = await load();
    const page = await provider.listComments(ctx, { postExternalId });

    for (const comment of page.items) {
      for (const media of comment.media) {
        expect(media.url).toMatch(/^https?:\/\//);
      }
    }
  });

  it(`${name}: a since filter never widens the result`, async () => {
    const { provider, ctx, postExternalId } = await load();
    const all = await provider.listComments(ctx, { postExternalId });
    const future = await provider.listComments(ctx, {
      postExternalId,
      since: new Date(Date.now() + 86_400_000),
    });

    expect(future.items.length).toBeLessThanOrEqual(all.items.length);
  });

  it(`${name}: platform failures arrive as PlatformError with a retry verdict`, async () => {
    const { provider, ctx, unknownExternalId } = await load();
    try {
      await provider.postReply(ctx, {
        parentExternalId: unknownExternalId,
        body: "hi",
        replyId: REPLY_ID,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect(typeof (error as PlatformError).retryable).toBe("boolean");
      return;
    }
    // Succeeding is allowed; a raw platform exception escaping is not.
  });

  it(`${name}: the manifest agrees with what the adapter will accept`, async () => {
    const { provider } = await load();
    const op = provider.manifest.operations.reply;
    if (op.supported) {
      expect(op.text.maxLength).toBeGreaterThan(0);
      expect(op.attachments.maxCount).toBeGreaterThanOrEqual(0);
    }
  });
}
