# Comment system for a multi-platform scheduling API

Take-home solution. The brief was to design and partially implement a comment system for a social media scheduling API that already supports several platforms, and to deliver a database schema, an API design, TypeScript code and an explanation of the major decisions. It asks for four things: retrieve comments for a published post, reply to a comment, support multiple platforms, expose the functionality over REST. Where it leaves details open, the assumption is written down.

Bluesky is implemented against the live API. Reads need no credentials, so a clean clone reads live comments; replies are published once an account is connected. Instagram, Facebook and YouTube are capability manifests without clients.

## What was asked for

| Deliverable | Where |
|---|---|
| Database schema | [Schema in DESIGN.md](DESIGN.md#schema) for the tables and their invariants; [schema.ts](src/db/schema.ts) for the definition, [drizzle/](drizzle/) for the migrations |
| API design | [API.md](API.md); the generated document is at `GET /v1/openapi.json`, built by [openapi.ts](src/api/openapi.ts) from the schemas in [schemas.ts](src/api/schemas.ts) |
| TypeScript code | [src/](src/) |
| Major design decisions | [DESIGN.md](DESIGN.md), the assumptions in [Assumptions](DESIGN.md#assumptions), the cuts in [Not in v1](DESIGN.md#not-in-v1), and the limits in [Known gaps](DESIGN.md#known-gaps) |
| How AI was used | [AI tools](#ai-tools) |

## Scope

I timeboxed this to two days, one for research and design and one for the code. Every additional platform costs onboarding and hours of debugging small differences, and that time comes out of the domain. So I took the API with no extra conditions — Bluesky needs an account and an app password, no business page / OAuth client / dev portal. Four adapters against mocks would have proved little.

Inside the timebox it was not possible to implement every domain mechanism at enterprise production grade. What I did was mark the domain concerns a real implementation should carry, not without simplifications: multi-tenancy, idempotency on the client's command and on the delivery retry, a reply and its delivery job in one transaction, a read position per post, ordering on a local sequence. Some of the omissions are deliberate and some are out of scope; both are listed in [Known gaps](DESIGN.md#known-gaps).

Authentication is a stand-in, there are no metrics and no quota budget, and the service assumes a single node.

## Run it

It runs with or without a Bluesky account. With one, copy `.env.example` to `.env` and fill in `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`, an app password issued in the Bluesky app, before seeding: the seed connects the account to the channel, and replies go to the platform. With no account, skip that step and the read path still works on live public comments; replies are refused with `channel_unauthorized`.

```bash
npm install
npm run db:up          # postgres 18 in docker, port 5433
npm run db:migrate
npm run seed           # creates a channel and prints its apiKey and channelId
```

The seed does what onboarding and publishing would do in the real product: it creates a tenant, connects an account when one is configured, and records the posts of the account being watched. That account is `BLUESKY_HANDLE` when it is set and `bloomberg.com` otherwise, a public account that posts often and collects comments, so the inbox fills up without any account of your own; `npm run seed -- <handle>` watches whatever you name.

```bash
npm run worker         # sweeps the channel and fills the inbox; leave it running
npm run start          # in a second shell: http://localhost:3000
```

The worker sweeps once at startup and then every five minutes; `SWEEP_CRON` sets the schedule. It also sends the queued replies, so without it running a reply stays `queued`.

Now call the API with the key the seed printed. The first call lists the newest comments left by other people; the watched account's own comments come back as outbound, and `direction=inbound` leaves them out. The second replies to one of them, with `$COMMENT_ID` taken from the first response:

```bash
curl -H "Authorization: Bearer $APIKEY" \
     'http://localhost:3000/v1/comments?limit=5&direction=inbound'

curl -X POST "http://localhost:3000/v1/comments/$COMMENT_ID/replies" \
     -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: readme-1' \
     -d '{"body":"thanks!"}'
```

The reply answers `202` with the reply's status, the worker posts it, and it comes back in the inbox on the next sweep as an outbound comment with no triage state.

Three ways to set a channel up:

- read with no account at all, on platforms whose comments are public, which is what Bluesky allows here
- read and reply on the posts of your own account
- read and reply on someone else's posts, where the platform allows it

The account a channel watches and the credential it replies with are separate fields, so all three are the same pair filled in differently.

`GET /v1/comments/capabilities?channelId=…` reports what the platform supports on the channel: whether replies exist at all, the text limit, the maximum nesting depth. Every comment carries a second answer of its own, whether replying to that comment is possible right now — `available` with an account connected, `unauthorized` without one. The [Capabilities](DESIGN.md#capabilities) section explains why the channel answer and the per-comment answer are kept apart. Triage state is ours, so `PATCH /v1/comments/{id}/state` works on a read-only channel too.

The contract is at `GET /v1/openapi.json`, which needs no key, and `npm run openapi` prints the same document without a running server.

## Layout

```
src/platform/     adapters and everything platform-specific
  port.ts         what every adapter implements
  capabilities.ts what a channel supports, and whether an action is possible on one comment
  manifests.ts    per-platform limits, scopes and reply windows
  bluesky/        appview.ts reads public threads, pds.ts writes as the account
src/domain/
  ingest/         projector and reconciler
  replies/        outbox enqueue and delivery
  triage.ts       handling state
src/api/          REST, problem+json, keyset pagination
  schemas.ts      the published shapes
  openapi.ts      the OpenAPI document
src/db/           schema and migrations
src/worker.ts     the sweep schedule and the delivery jobs
```

Stack: Node 22, TypeScript strict, Fastify, Zod, Drizzle, PostgreSQL 18, graphile-worker, Vitest, and `@atproto/api` for Bluesky.

## Design summary

**Platform differences are data.** Each platform has a manifest with its limits, reply windows and ingest modes. The capability resolver answers the channel question and the per-comment question from it. There is no branch on a platform name outside `src/platform/<name>/`.

**Comments are kept as a local projection.** Sorting and filtering across posts and accounts run on our own columns, a moderation decision survives an edit upstream, and the inbox keeps working while a platform is down. The cost is synchronization and a copy that drifts; the argument is in [Storage in DESIGN.md](DESIGN.md#storage).

**Comments are read by polling.** It is the only path available on every platform, and it stays mandatory even where a push path exists, because deliveries are lost silently and only a catch-up pass recovers them. A pass follows the platform's pagination to the end of each post and spends most of its budget on recent posts, rotating through the rest so none drops off the schedule. How far a post has been read is recorded on that post: a pass reads a subset, so a channel-wide position would mark posts as read that nobody opened. Push would cut the delay between a comment appearing and arriving, and it is not in v1; the reasoning is in [Not in v1](DESIGN.md#not-in-v1).

**Every adapter is held to the port.** A conformance suite states what every adapter must do — a comment belongs to the post that was asked for, identifiers do not repeat, dates parse, `since` narrows the answer, failures carry a retry verdict — and runs it against each adapter. It also holds an adapter to its own manifest: an operation declared supported has to actually reach the platform, and the same reply sent twice has to land on one object.

**The queue is in Postgres.** A reply row and the job that delivers it are inserted in one transaction; getting the same guarantee from an external broker would take a distributed commit, or an outbox in front of the broker anyway. graphile-worker owns attempts, backoff and crash recovery; `outbound_replies` holds the status the API reports.

**The contract is declared once.** Every published shape is a Zod schema; the TypeScript types are inferred from it, every response is parsed against it on the way out, and the OpenAPI document is generated from the same schemas.

## Implementation status

**Working:** ingest on a schedule with paginated reads, projection with two-phase parent links and conflict resolution, handling state, capability resolution, the REST endpoints, and replies delivered to the platform.

The reply path runs on Bluesky. The row and its delivery job commit together, the worker posts it, and the outcome — a retry, a terminal refusal, or the platform's id — ends up in the reply's status, with the comment marked answered in the same transaction as the send. The record is named after the reply, so a retry rewrites it instead of posting a second one. `npm run test:live` answers a comment in a fixed thread, repeats the send, and deletes it.

**Declared only:** the Instagram, Facebook and YouTube manifests, each with its own limits and scopes. Bringing one up means its own application and accounts, so they record what the docs say.

**Cut:** the derived layer (intent, semantic search), hiding and liking, private replies, attachments on replies, per-state counters, assignment to a named person, retention. Reasons in [Not in v1](DESIGN.md#not-in-v1).

## Tests

Three suites, split by what they require: 61 unit tests, 73 integration tests against a real Postgres, and a live suite that posts to Bluesky and deletes after itself.

```bash
npm test
npm run test:integration
npm run test:live         # needs the account from .env
```

Integration tests assert outcomes across boundaries: a stub that answered in one page once let the reconciler ignore the platform's cursor and still pass.

CI runs the linter, the formatter check, the typecheck, both suites and the schema checks against PostgreSQL 18 on every push ([ci.yml](.github/workflows/ci.yml)). The live suite is left out: it calls the live Bluesky API, and their outage would fail our build.

[verify-schema.sql](scripts/verify-schema.sql) checks that the schema rejects cross-tenant references, a credential belonging to another platform, a status outside its vocabulary, and an unhandled comment recorded as handled.

## AI tools

Claude Code for research on the platforms and the domain, assisted and agentic coding, and test generation. Codex as a second pass of code review over that. Adversarial review of the architecture, the design documents and the tests by several models.

The output is validated by the tests and by running against the real API, so every line is held to the same typecheck, linter, two test suites and CI regardless of who wrote it.

A few of the many architectural proposals from the models that I turned down: an external queue broker, since the outbox needs the row and the job in one transaction; hand-writing the worker loop, since graphile-worker already owns attempts, backoff and crash recovery.
