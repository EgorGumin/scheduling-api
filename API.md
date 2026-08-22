# API

Every example below is a real response from the running service. Reasoning behind the shapes is in [DESIGN.md](DESIGN.md).

The machine-readable contract is available at `GET /v1/openapi.json`; `npm run openapi` prints the same document without starting the server. Both are generated from the schemas used to validate responses. This file documents behavior and rationale that OpenAPI does not express.

## Conventions

**Base and version.** `https://{host}/v1`. Within a version, new fields, new endpoints and new enum values may appear. Removing a field, narrowing a type or adding a required request field needs `/v2`.

**Enums are open.** New enum values may be added within v1. Clients must ignore unknown fields and preserve unknown enum values. Treat an unrecognized `Action.status` as unavailable. Generated TypeScript types should include `| (string & {})` so the value remains representable.

The OpenAPI document lists only the enum values emitted by the current build. A value is added to the schema in the same change that starts sending it; adding one does not require `/v2`.

**Authentication.** `Authorization: Bearer <api-key>`. The key is issued per tenant and scopes every request implicitly. Another tenant's resource returns `404` rather than `403`, so the API never confirms that it exists.

The server accepts an authentication function. A production deployment must pass the identity module's implementation. The bundled default treats the bearer token as the tenant id and performs no verification; do not expose it on a network.

The API key identifies the tenant. `X-Actor-Id` identifies the actor who handled a comment or requested a reply. It is an opaque string of at most 128 characters, stored and never interpreted. It is optional; without it those fields stay `null`. The API trusts this header. V1 does not bind the actor to a signed principal in the token.

**Identifiers** are prefixed and opaque: `chn_`, `pst_`, `cmt_`, `rpl_`. The prefix turns a misrouted id into a `400` at the edge instead of a confusing `404` three layers in. External platform ids appear only inside `author.id` and are passed through verbatim.

**Unknown query parameters are rejected** with `400`. Treating one as absent returns a page that quietly means something else.

**Only platforms this deployment has an adapter for are offered.** A platform whose limits are known but whose client is not built reports `unsupported`; only built adapters accept commands.

## Comment

```jsonc
{
  "id": "cmt_01a01fc64fcf786fb4feeb86a1e83ef3",
  "channelId": "chn_01a01fc63c7f749fb94c1573a6ee80f8",
  "postId": "pst_01a01fc6417b7b39a5189c3c91dd3333",
  "platform": "bluesky",
  "parentId": null,                 // null until the parent has been ingested
  "depth": 0,
  "author": {                       // null when the platform reports none
    "id": "did:plc:7jh5s3ovh25riisd7hu7kjmc",
    "displayName": "Paul Baker",
    "handle": "paul-0-o-baker.bsky.social"
  },
  "body": "How about city ordinances limiting vegetation…",
  "media": [],                      // [{ type, url, altText? }]
  "direction": "inbound",           // inbound | outbound
  "lifecycle": "active",            // active | hidden | deleted | unknown
  "createdAt": "2026-08-20T01:04:03.401Z",
  "editedAt": null,
  "firstSeenAt": "2026-08-20T15:24:45.387Z",
  "state": { "handling": "new", "handledAt": null, "handledBy": null, "note": null },  // null on our own replies
  "actions": { "reply": { "status": "unauthorized" } },
  "replyIds": []                    // our delivery tasks (rpl_), not comments
}
```

`body` is `null` when the comment was deleted upstream; `lifecycle` says which.

`media` carries references as the platform gave them. Nothing is downloaded or proxied, and availability is not guaranteed. `type` is `image`, `video`, `gif`, `link_preview` or `unknown`.

## Actions

`actions` maps an action name to its availability on this object. The v1 vocabulary contains only `reply`. Every action key is present. An unavailable action remains present with a status.

```ts
type Action =
  | { status: "available"; replyableUntil?: string }
  | { status: "unsupported" | "unauthorized" | "insufficient_scope"
            | "expired" | "forbidden_by_author" | "gone" };
```

`supported` on a channel and `available` on an object are different claims. The first says whether the platform can do this at all on this channel. The second says whether it can be done now, on this comment.

Clients map each status to the behavior below:

| Status | What the client can do |
|---|---|
| `unsupported` | nothing; the platform lacks the operation |
| `unauthorized` | connect an account |
| `insufficient_scope` | request the missing permission |
| `expired` | nothing; the window closed |
| `forbidden_by_author` | nothing; the author disallowed it |
| `gone` | nothing; the object was deleted |

Interface rule: `unsupported` may be hidden; the rest should be shown disabled with the reason, and `unauthorized` and `insufficient_scope` get an action button. The client never needs a platform name to render this.

Permission details belong to the credential, which another module owns. Reconnecting a credential updates every channel that uses it.

## Endpoints

### `GET /v1/openapi.json`

The contract as OpenAPI 3.1. No authentication: a client generator should not need a key to describe the shapes.

### `GET /v1/comments`

One feed across posts and channels, newest received first.

Parameters: `channelId`, `postId` (comma-separated), `publisherPostId` (comma-separated), `handling`, `lifecycle`, `direction`, `limit` (1–100, default 25), `cursor`. A comma-separated list carries at most 50 entries.

`publisherPostId` is there because the caller that scheduled the post knows it by the publishing module's identifier and has never seen ours.

```jsonc
{
  "data": [ /* Comment */ ],
  "included": {
    "posts": [{
      "id": "pst_01a01fc6417b7b39a5189c3c91dd3333",
      "preview": "New regulations are designed to protect homes from wildfire…",
      "permalink": "https://bsky.app/profile/bloomberg.com/post/3mthwuealxt2j",
      "publishedAt": "2026-08-20T00:00:19.000Z",
      "publisherPostId": null       // set when the post was published through the system
    }]
  },
  "page": { "nextCursor": null }
}
```

Posts are side-loaded so a hundred comments on one post do not repeat it a hundred times. A comment references its post by id; the object appears once.

### `GET /v1/comments/{commentId}`

One comment, the same shape as a list element. Useful for polling a single item after acting on it without refetching a page.

### `GET /v1/comments/capabilities?channelId=…`

What the platform supports on this channel.

```jsonc
{
  "reply": {
    "supported": true,
    "actionableForHours": null,     // null = no window
    "text": {
      "maxLength": 300,
      "counts": "graphemes",        // graphemes | utf16 — one emoji is 1 or 2
      "maxBytes": 3000              // a second, independent cap; null where none
    },
    "attachments": { "maxCount": 0, "mimeTypes": [], "maxBytes": 0 },
    "maxDepth": null                // null = arbitrary nesting
  }
}
```

Comment capabilities remain under `/v1/comments` because publishing exposes a different capability set for the same channel. This endpoint accepts only `channelId` and returns channel-level limits. Restrictions that depend on a particular comment appear in its `actions`.

`counts` defines how clients measure `maxLength`. `maxCount: 0` means attachments are unsupported. `actionableForHours` is measured from the comment's `createdAt`; `replyableUntil` gives the deadline for one comment.

Capabilities are computed from local data and may remain stale until the platform refuses an action.

### `POST /v1/comments/{commentId}/replies`

Requires `Idempotency-Key`, at most 255 characters. Body: `{ "body": "…" }`.

`202` with the reply's status when the task is queued. `200` with the same object when the key was seen before and the request is identical, and no second task is created. `409 idempotency_conflict` when the key was reused with different content, because that is a client bug and returning the earlier reply would hide it.

Idempotency is resolved before preconditions are checked again. A retry returns the original accepted command even if the credential, comment or reply window changed after the first request. This lets the client recover the reply id after losing the first response.

The command is checked against the channel's capabilities before it is queued: text length in graphemes, nesting depth, and whether the action is available at all. A rejection at this stage costs no platform call.

### `GET /v1/replies/{replyId}`

```jsonc
{
  "id": "rpl_01a01fc6…",
  "inReplyToCommentId": "cmt_01a01fc6…",
  "status": "queued",          // queued | sending | retrying | posted | failed | expired
  "externalId": null,          // the platform's id, once accepted
  "postedAt": null,
  "error": null,               // { "code": "…" } on failure
  "createdAt": "2026-08-20T15:25:19.190Z"
}
```

Delivery attempts are at least once, but publication is not guaranteed. After attempts stop, `status` records whether the reply was posted, failed or expired.

Error codes reported here: `rate_limited`, `unavailable` (both retried), `permission_denied`, `not_found`, `constraint_violated`, `window_expired`, `forbidden_by_author` (all terminal).

### `PATCH /v1/comments/{commentId}/state`

Body: `handling`, `note`, either or both. Returns the new state.

```jsonc
{ "handling": "escalated", "handledAt": "2026-08-20T15:25:07.319Z",
  "handledBy": "agent-7", "note": "pricing question" }
```

`handling` is `new`, `answered`, `escalated` or `ignored`. `answered` is also set by the system when a reply is delivered, crediting the actor who asked for that reply. `handledBy` comes from `X-Actor-Id` and is stored without interpretation.

Setting `handling` back to `new` clears `handledAt` and `handledBy`. The `note` is preserved.

Handling state is local to this API, so it can be changed on a read-only channel and survives the comment being deleted upstream.

Outbound comments carry `"state": null`; this endpoint returns `404` for them. Triage applies only to inbound comments.

## Pagination

The cursor uses the sequence assigned when a comment is ingested. `nextCursor` is opaque and should be sent back unchanged; a malformed one is rejected with `400`. It is not signed, but modifying it cannot escape tenant scoping. `nextCursor: null` is the only end-of-feed signal; a short page may still have a successor.

The cursor is ordered by ingest sequence. A catch-up pass can return a comment created before the position already served, and that comment remains visible.

**Known limit.** Under concurrent ingest, a row may commit behind an already-issued cursor and be skipped. This cannot produce duplicates. A watermark would close the gap, but v1 does not implement one.

## Errors

`application/problem+json`.

```jsonc
{ "type": "about:blank#channel_unauthorized", "title": "channel_unauthorized",
  "status": 409, "detail": "this channel has no connected account" }
```

`400 invalid_request` also carries `issues`, an array of `{ path, message }`.

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | Malformed request, unknown parameter, malformed cursor |
| `unauthenticated` | 401 | Missing or unusable key |
| `not_found` | 404 | No such object, or it belongs to another tenant |
| `idempotency_conflict` | 409 | Key reused with different content |
| `channel_unauthorized` | 409 | The channel has no connected account |
| `channel_insufficient_scope` | 409 | The account lacks a required permission |
| `window_expired` | 409 | The platform's reply window has closed |
| `action_unavailable` | 409 | Refused for another reason, carried in `action` |
| `constraint_violated` | 422 | Violates a declared limit, such as text length |

Five codes share 409: the request is well formed, the state refuses it, and that state can change. None of them is a 403, which would mean the caller may never do this.

`500 internal` exists but is not part of the contract: it means a defect on our side, and there is nothing for a client to branch on.

## Not in v1

Design rationale for the larger exclusions is collected in [DESIGN.md](DESIGN.md#not-in-v1).

- **Push ingest.** Comments are polled on a schedule. The resulting delay is bounded by the poll interval; adding push later would not change the endpoint shapes.
- **Comment actions.** Hiding, liking and deleting comments.
- **Reply variants.** Private replies and attachments.
- **State concurrency.** Optimistic locking for handling state.
- **Threads.** There is no thread endpoint; clients can assemble one from `parentId` and `depth`.
- **Client notifications.** There are no outbound webhooks. Clients poll, and action availability is exposed through `Action.status`.
- **Derived features.** Annotations and semantic search.
- **Reply management.** Cancelling queued replies and listing replies.
- **Aggregates.** Per-state counters.
- **Sync controls.** Clients cannot force a sync or inspect ingest freshness.
