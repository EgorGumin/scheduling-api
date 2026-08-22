# Design

The decisions behind the schema, the ingest loop and the platform port. The endpoints are in [API.md](API.md); implementation status is in the [README](README.md#implementation-status).

## Context

A scheduling product publishes posts to several social platforms and now needs comments on those posts: read them, answer them, keep working as platforms are added.

Platforms differ in thread depth, pagination, available actions, attachment limits, reply windows, event delivery and error taxonomies. Some behavior depends on the account type or its granted permissions rather than on the platform alone.

Users want the features of the platform they are on, so the model keeps those differences visible.

## Assumptions

The brief leaves these open, so I fixed them and built accordingly.

1. **Multi-tenant.** Several workspaces, each with several connected accounts. Every query is scoped by tenant.
2. **Publishing already exists.** This module attaches to it and knows the external id of a published post. It does not own publishing.
3. **The inbox must work while a platform is down.** Listing, filtering, counting and searching answer from local storage. This is the assumption that decides the storage question below.
4. **An agent answers most comments,** a person handles escalations. So the metrics that matter are ingest completeness and answer coverage rather than operator response time.
5. **Account connection is another module's job.** Tokens, OAuth flows and reconnection live there; this module reads credential state and may downgrade it. Disconnecting a channel is that module's operation, and it leaves the credential in a state other than `ok`. Action availability is therefore derived from the credential alone; this module does not derive it again from channel status.
6. **One deployment.** Modules are separated by dependency direction, not by process. Splitting them later is a deployment decision, not a redesign.

## Boundaries

This module owns comments, their handling state, and outbound replies. It reads channels, credentials and posts, which belong to the connection and publishing modules.

Those tables are included in this schema so the system can run without a second source of truth for channels. They contain only the columns this module needs.

One write crosses the boundary: when a platform refuses an operation for lack of permission, this module downgrades `platform_credentials.state`. The refusal is observed at runtime by this module and its caller; the owning module otherwise knows only what was granted at consent time unless that result is passed back to it. The two writers have separate responsibilities: this module only downgrades the state, and the owning module alone restores it.

## Storage

**Comments are kept as a local projection.**

Storing only platform ids and local flags would respect the ownership boundary and use less storage, but it would require fetching content on every read.

That model cannot support the required inbox. A cross-post, cross-account list cannot sort or filter on fields held by remote services. A moderation decision loses its subject if the remote text changes, and expired remote history leaves holes. It would also violate assumption 3: the inbox must remain available while a platform is down.

The trade-offs are synchronization machinery, possible drift from the source, deletion propagation and storage.

The platform stays the source of truth. Our copy is derived and rebuildable. That is expressed to clients through `lifecycle` on the object and through `Action.status`, rather than through a freshness flag they cannot act on.

## Capabilities

Platform differences are data, resolved at two levels.

A **manifest** per platform holds its limits, reply windows, required permissions and ingest modes. Adding a platform means adding a manifest and an adapter; no branch on a platform name exists outside `src/platform/<name>/`.

A **channel declaration** answers what the platform can do on this channel. An **action** answers whether an operation is possible on this comment right now. An operation can be supported but unavailable because the window closed, the author disabled replies, or the credential lost a permission.

```ts
type Action =
  | { status: "available"; replyableUntil?: string }
  | { status: "unsupported" | "unauthorized" | "insufficient_scope"
            | "expired" | "forbidden_by_author" | "gone" };
```

Checks run from the least fixable cause to the most. For example, a deleted comment is reported as gone rather than as requiring an account reconnection.

Identity is checked separately from permissions because a write needs an account identity even on a platform without granular scopes. Without that distinction, a read-only channel could report that replying is possible. When a platform does not report granted permissions, the call is allowed: treating missing information as denial would hide an operation that may work.

`forbidden_by_author` is read off the object rather than assumed. Platforms report it per comment: a thread-wide rule set by the post's author is the usual cause, and a block between our account and one commenter restricts that node alone. The field is the reading account's relationship to the post, so an unauthenticated read has none to report and the comment is stored as not restricted.

The stored value reflects the last read of that comment, and an account change does not trigger a re-check. Preserving an older answer would leave a restriction in place until a full re-read even when it no longer applied. A false "allowed" causes one delivery attempt that the platform can refuse and the outbox can record. A false "forbidden" hides the action without triggering a re-check.

Quantities express absence too: `attachments.maxCount: 0` says attachments are impossible, with no separate boolean to contradict it later.

Everything is computed per request from local data, so there is no cache to invalidate. Local data still lags: a permission revoked a minute ago is visible only after the first refusal.

## Ingest

**Comments are read by scheduled polling.** Polling is the only path available on every platform and remains the catch-up path where push delivery also exists. A dropped push event would otherwise become permanent data loss.

A pass follows platform pagination to the end of every post it reads, without a page cap. Platforms return the newest page first. If a capped walk advanced the post position, older pages outside the cap would also fall outside the next read window and be omitted permanently. A long walk makes the pass slower but ends when the platform stops returning cursors. A repeated cursor ends the walk as a failure instead of creating a loop.

A walk is not resumable: an interrupted one restarts from the first page, which costs quota and changes nothing, because every page goes through the same idempotent upsert.

**Outbound comments are identified during ingest.** A channel can watch one account while using another account for writes. The write identity is stored on the credential and obtained from the platform when the connection is created, rather than trusted from configuration. Any comment written by that identity is outbound, whether it was sent through this system or the platform's app, so ingest does not seed handling state for it. A channel without a connected write account has no outbound identity and suppresses nothing.

A pass has a fixed post budget. Most of it goes to the newest posts; the remainder rotates through older posts in least-recently-read order. Always selecting the newest N would stop checking a post as soon as it aged out, even though comments could still arrive on it.

This module does not retire posts. It reads the posts registered by the publishing module until that module removes them. The budget limits each pass, not the full rotation, so a growing set of posts increases the interval between reads of each older post.

**Read positions are stored per post.** A pass reads only a subset of a channel's posts. A channel-wide position could move past a comment on a post the pass never opened, causing that comment to be filtered out when the post is eventually read. A per-post position describes only reads of that post.

A post's position comes from the moment the pass began, less one minute. A pass reads its posts one after another, so a position stamped at the end would move the posts read first past comments that arrived meanwhile. The minute covers the gap between our clock and the platform's index time. A failed post keeps its previous position, so the next pass starts from the same point.

One unreadable post does not stop the rest of the channel. Degradation applies to a channel whose passes make no progress three times in succession, not to a channel with one failed post.

## Conflicts and ordering

A post is read repeatedly and its comments arrive again each time, so every write is an upsert on `(channel_id, external_id)`.

A higher `remote_version` wins; with equal or missing versions, the last arrival wins. `remote_version` is the monotonic value exposed by the platform. On Bluesky this is `indexedAt`, because the record itself carries no revision.

Deletion has no conflict rule because no ingest source reports a deletion event. A missing record may also be outside the current read window, so absence does not prove deletion.

The same conflict policy applies to every platform. Several providers expose no reliable version, so platform-specific policies would still be approximate.

**Inbox ordering uses an insert-time counter.** A catch-up pass can ingest a comment whose `created_at_remote` is older than the client's cursor. Ordering the inbox by remote creation time would hide that comment from the client. `ingest_seq` gives the inbox a single cursor value without a timestamp tie-break. Thread reads still use platform time because they represent conversation chronology.

The sequence is assigned at insert, but the row becomes visible at commit. A late commit can therefore place a row behind a cursor already returned to a client. This race can skip a row but does not create duplicates. Preventing it requires a watermark that limits reads to positions below all open transactions. That mechanism is not implemented, so the contract states the limitation.

## Threads

A parent may arrive after its children when a platform paginates a thread or returns it newest-first. Parent linking therefore has two phases: ingest records the platform's parent reference, then fills the internal foreign key when the parent appears.

`depth` is denormalized from the parent at insert. It is not checked by a constraint, because at insert time an unresolved parent means the depth is unknown.

**Parent linking.** One statement resolves internal parent ids by matching platform references; it does not depend on whether each parent is already linked. Depth does propagate through the tree, so it is recomputed in one walk from the channel's roots. Updating one level per round would require as many rounds as the deepest subtree and could leave an incorrect depth after a fixed round limit. Reply validation checks `maxDepth` against the recomputed value.

## Replies

**Reply delivery.** A reply is queued rather than sent synchronously. Its row and delivery job are inserted in the same Postgres transaction, which is why the queue lives in this database; the alternatives are under [Rejected alternatives](#rejected-alternatives).

graphile-worker owns attempts, backoff, locking and crash recovery. `outbound_replies` holds the business outcome the API reports: `queued`, `sending`, `retrying`, `posted`, `failed`, `expired`. Keeping retry state in both places would mean two mechanisms disagreeing about one task.

`Idempotency-Key` is resolved before preconditions are checked again. On a retry, the credential may have been revoked or the reply window may have closed since the command was accepted. Rechecking would reject the retry and prevent the caller from learning the accepted reply id. Preconditions apply only to a key not seen before.

**Delivery guarantee.** Attempts are at least once, but publication is not guaranteed: attempts can run out, windows can close and refusals can be permanent. The API guarantees that the outcome is observable in the task status.

The platform can accept a reply just before the process dies without recording its external id. A retry can then send the reply again. Writing the external id immediately after the platform response narrows this window. That write and the resulting handling-state change share one transaction; separate writes could leave a delivered reply on an unhandled comment with no pending job to repair it. Ingest does not reduce the chance of duplication, but it records any duplicate as a second outbound comment instead of leaving it invisible.

Bluesky closes this window because the writer chooses the record key. The reply uses a key derived from its internal identifier, so a repeated write targets the same record. The port carries that identifier; adapters for platforms that cannot use it ignore it.

Other platforms remain exposed to this duplicate window. Re-reading the thread before a retry could find a delivered reply only when the platform returns an id that can be looked up, and the port has no method for reading one object. Matching by author, text and time is unsafe because an older identical reply could be mistaken for the current attempt and mark an unsent task as complete.

Permanent refusals do not retry. The delivery task throws to hand a retry decision back to the worker and returns normally when there is nothing more to try.

## Handling state

Handling state is ours. Synchronization never touches it, and it survives the comment being deleted upstream.

`new`, `answered`, `escalated` and `ignored` have distinct consequences. `answered` is the only state the system sets automatically, after delivery. The others record a decision by a person or an agent.

A reply appearing under a comment does not close it automatically. For example, "I'll DM you" may end the public exchange while handing the lead to another agent in a private channel. Automatically marking it `answered` would hide that work. The state changes only through an explicit handling decision or after this system delivers a reply, when the initiating actor's intent is known.

`spam` is a classification rather than a handling state. Classification describes what a comment is; handling records what was done about it, and the two can change independently. Classification belongs to the derived layer. Its corresponding platform action, hiding the comment, is also outside this version.

`handled_by` holds an opaque actor id with no indication of its kind. Actor types belong to the identity service; copying one here would store someone else's fact and drift when it is reclassified.

## Authentication

The module takes an `authenticate(request) -> tenantId` function and does not depend on how the caller was identified. Key issuing, rotation and revocation remain in the product's identity module.

The default supplied when nothing is passed in treats the bearer token as the tenant id. It authenticates nobody: knowing a tenant's id is enough to act as that tenant. It exists so the module runs on its own, and a deployment that reaches a network passes in a real one.

## Tenant isolation

Isolation rests on composite foreign keys wherever an identifier arrives from outside, so the database refuses the mistake even when a query forgets to scope itself. A comment's post must belong to the same channel; a reply must leave through the channel its comment belongs to; a comment's parent must be in the same channel; a handling state must belong to the same tenant as its comment.

Each composite foreign key requires a redundant unique constraint on the referenced table. Because `id` is already unique, a tuple containing it cannot reject anything the primary key would accept. This still creates a btree on the largest, most-written table. `comments` creates one for `(tenant_id, channel_id, id)`, shared by both the post and parent links.

The same reasoning puts `platform` in the key that binds a channel to its credential. Tenant alone would let a Bluesky channel hold an Instagram account, and every capability answer computed from it would be about the wrong platform.

`scripts/verify-schema.sql` asserts that the database refuses these references rather than trusting that it does.

## Schema

Seven tables. Full DDL in `drizzle/`, typed definitions in `src/db/schema.ts`.

| Table | Holds | Owned by |
|---|---|---|
| `platform_credentials` | Reference to a secret, granted permissions, state | Connection module |
| `channels` | The watched subject on a platform | Connection module |
| `posts` | External post id, preview, permalink, how far its comments are read | Publishing module |
| `comments` | The projection | This module |
| `comment_states` | Handling decision and its author | This module |
| `outbound_replies` | Queued replies and delivery outcome | This module |
| `sync_state` | Last pass and consecutive failures per channel | This module |

The central table:

```sql
CREATE TABLE comments (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL,
  channel_id          uuid NOT NULL,
  post_id             uuid NOT NULL,
  external_id         text NOT NULL,
  parent_external_id  text,                    -- always recorded
  parent_id           uuid,                    -- resolved when the parent arrives
  depth               smallint NOT NULL DEFAULT 0,
  author_external_id  text,
  author_display_name text,
  author_handle       text,
  body                text,
  media               jsonb,                   -- references, never bytes
  is_outbound         boolean NOT NULL DEFAULT false,
  lifecycle           text NOT NULL DEFAULT 'active',
  reply_disabled      boolean NOT NULL DEFAULT false,
  created_at_remote   timestamptz NOT NULL,
  edited_at_remote    timestamptz,
  remote_version      timestamptz,             -- conflict resolution
  first_seen_at       timestamptz NOT NULL,
  ingest_seq          bigserial NOT NULL,      -- inbox order and cursor
  last_synced_at      timestamptz NOT NULL,
  UNIQUE (ingest_seq),
  UNIQUE (channel_id, external_id),            -- the upsert target
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_id, id),
  CONSTRAINT comment_post_in_same_channel
    FOREIGN KEY (tenant_id, channel_id, post_id)
    REFERENCES posts (tenant_id, channel_id, id),
  CONSTRAINT comment_parent
    FOREIGN KEY (tenant_id, channel_id, parent_id)
    REFERENCES comments (tenant_id, channel_id, id)
);

CREATE INDEX ON comments (tenant_id, ingest_seq);
CREATE INDEX ON comments (channel_id, ingest_seq);
CREATE INDEX ON comments (post_id, created_at_remote DESC, id);
```

The comment's `platform` is derived from its channel and joined on read. Storing another copy without an equality constraint would allow the values to drift.

The inbox query filters on `comment_states.handling` and orders by `comments.ingest_seq`, which no single index can serve across the table boundary. At a million comments with twenty unhandled, the scan reads far too much. A production-scale version should drive the query from `comment_states`, with its own copy of the sequence and a partial index on unhandled values, then join the comments. That optimization is not implemented, because nothing in this submission runs at that size.

Queries use Drizzle's builder by default and use `sql` for CTEs, conditional upserts and set operations. These include the orphan linker, the comment upsert with its conflict policy, the keyset page with six optional filters and the post budget with its `UNION ALL`. Roughly a third of the queries are in this group. Expressing them through the builder would add indirection without removing the need to review the generated SQL.

The distinction affects type safety. A builder query derives column types from the schema and returns a `Date` for `timestamptz`; a raw query returns the driver's value behind an unchecked, hand-written row type. In one observed bug, a timestamp arrived as a string and silently failed a comparison. Raw-query conversions are now explicit, and response schemas validate the final representation at the API boundary.

**Status columns.** Statuses use `text` with a `CHECK` constraint. Their vocabularies are expected to grow as platforms are added. Extending a Postgres enum changes a database type and has its own locking behavior; a `CHECK` changes through an ordinary migration. Both approaches prevent unknown values from entering the column.

## The published contract

Every response shape is declared as a schema in the module that owns the type: capabilities beside their resolver, handling state beside its write query, and comments and pages in `src/api/schemas.ts`. Each declaration supplies the inferred TypeScript type, response validation and OpenAPI output. An interface alone would leave validation and documentation to be maintained separately.

A malformed request returns `400`. A response that does not match its schema indicates an internal defect and returns `500` instead of emitting an invalid field. This validation also catches mapping defects introduced by unchecked raw-query row types.

The cost is a pass over every response object on the way out.

## The adapter port

```ts
interface CommentProvider {
  readonly platform: Platform;
  readonly manifest: PlatformManifest;

  listComments(ctx: ChannelContext, query: ListQuery): Promise<Page<RawComment>>;
  postReply(ctx: ChannelContext, cmd: ReplyCommand): Promise<PostedReply>;
}
```

Each adapter translates its platform's error taxonomy into ours once, including whether another attempt could plausibly succeed. Downstream code does not inspect platform HTTP statuses.

Bluesky reads and writes use different services. The adapter reads from the public AppView without credentials, which lets the seed and live-read tests run from a clean clone. It writes to the account's server through an authenticated session. Both paths use the official `@atproto/api` client, which checks responses against the published lexicons, and both translate failures into `PlatformError`.

The account determines which server receives a write. Its repository lives on a host named in its DID document. The current connection flow starts login at `bsky.social`, then follows the host returned by that service. As a result, accounts on independently operated servers cannot connect through this implementation. This is a current product boundary, not a limitation of the protocol.

The session is reused because logging in for every reply would consume the published allowance of thirty logins per five minutes for one account. An expired access token is renewed with its refresh token instead of another login. Refreshes are serialized because the refresh token rotates; concurrent refreshes could otherwise spend the same token twice. A withdrawn password is reported immediately as a permanent failure.

A conformance suite runs the same assertions against every implementation of the port.

## Rejected alternatives

**Storing platform ids with our own flags.** Rejected for the availability and query constraints described under [Storage](#storage).

**A capability model built from the intersection of platforms.** It would expose only features shared by every platform, hiding additional features available to a particular user and channel.

**A capability model built from the union of all fields.** The core grows with every platform, most fields are optional, and no type tells a client which ones are populated.

**Fastify's own response serialization for the same job.** A route schema compiled by fast-json-stringify would strip fields that do not match rather than report them, which turns the class of bug above into a silently missing field. `@fastify/swagger` would produce the document from those same route schemas and add a dependency for a UI this submission does not need.

**An external queue broker (Redis with BullMQ, RabbitMQ).** The task must commit in the same transaction as the state change, which a broker outside Postgres reaches only through a distributed commit. The outbox table would remain, with the broker acting as a notification layer on top of it. graphile-worker already takes tasks with `FOR UPDATE SKIP LOCKED` and wakes on `LISTEN/NOTIFY`, so that layer adds nothing with the current single consumer model. Revisit the decision if independent consumers or other implementation languages are introduced, tasks hold transactions for longer, or measurements show locking or autovacuum pressure on the queue table.

## Not in v1

**Derived layer** (intent classification, semantic search). It requires a model provider. The expected schema shape is understood, but the implementation is not included.

**Hiding, liking, deleting.** The model can express them through a manifest entry and vocabulary key, but no endpoints implement them.

**Private replies.** Instagram and Facebook support them with a seven-day window. The declaration already has the shape; the semantics need more care than this version has.

**Attachments on replies.** `attachments.maxCount` is 0 everywhere, which describes this API rather than the platforms.

**Per-state counters.** Filter tabs would use them, but no count endpoint is implemented. Deriving a count from the loaded page would undercount results outside that page.

**Assignment to a named person.** `handled_by` records who completed a handling action. Work assignment requires a separate workflow and states.

**Retention.** A production deployment needs a retention policy for third-party text. The proposed implementation is a scheduled pass that redacts content but keeps rows referenced by handling state and sent replies. It is not implemented.

**Push ingest.** Instagram and Facebook can send HTTP callbacks to a registered application; Bluesky exposes a websocket carrying network records that must be filtered. Push could reduce ingest delay to seconds, while scheduled polling would remain the catch-up path described in [Ingest](#ingest). Supporting it requires a raw event inbox, pre-tenant deduplication, edge signature verification and a second path into the same projector. It is not implemented.

**Outbound webhooks to clients.** Clients poll. The reasons a client can act on are visible in `Action.status`.

**Strict pagination guarantee.** See [Conflicts and ordering](#conflicts-and-ordering).

## Known gaps

These known limitations are roughly ordered by their expected production cost.

- **Duplicate reply delivery is prevented on Bluesky but remains possible elsewhere.** Other platforms need a single-object read method so a retry can check whether the reply was delivered. [Replies](#replies).
- **A queued reply is delivered with the channel's credential as it stands at delivery.** `outbound_replies` records the channel rather than the account the command was accepted under, and delivery reads `channels.credential_id` again. A channel reconnected to a different account between the `202` and the send would publish under that account. The fix is to record the credential at enqueue and refuse the delivery when it no longer matches. [Replies](#replies).
- **Pagination can skip a row under concurrent ingest.** A watermark would close the late-commit race. [Conflicts and ordering](#conflicts-and-ordering).
- **Author reply restrictions are unavailable during ingest.** Reads use the public AppView without a reading account, so comments are currently stored as unrestricted even when a write account is connected. [Capabilities](#capabilities).
- **The bundled authentication is a stand-in.** It treats the bearer token as the tenant id and verifies nothing, so it must not be exposed as it stands. [Authentication](#authentication).
- **Platform rate limiting is a fixed concurrency of five reads per channel**, applied per process, so several workers on one channel would multiply it. The fix is a quota budget shared across processes.
- **Raw SQL row types are unchecked.** Explicit conversions and response validation catch known mapping failures, but the row declarations themselves are not derived from the database schema. [Schema](#schema).
- **A parent link is not checked against the post.** The foreign key covers tenant and channel, and orphan linking matches the platform's reference within the channel, so a reference to a comment under another post of the same channel would link. `depth` would then be counted across two threads and checked against `maxDepth` before a reply is queued. The fix is to carry `post_id` in the parent key. [Threads](#threads).
- **API.md is written by hand** and its examples are captured from the running service, so the prose and the generated document can drift. Only the schemas, the responses and the OpenAPI are checked against each other.
- **Thread reads stop at the platform limit.** Bluesky accepts a maximum depth of 1000, so a deeper reply would be missing without a signal.
- **A page walk is not resumable.** An interrupted one restarts from the first page and that post keeps its old position until the walk finishes. [Ingest](#ingest).
- **Nothing detects a deletion.** Bluesky marks the gap with `#notFoundPost` and `#blockedPost` nodes, which the adapter skips; whether a deleted leaf leaves a marker at all I could not check without an account. [Conflicts and ordering](#conflicts-and-ordering).
