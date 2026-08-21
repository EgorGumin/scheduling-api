-- Proves the schema enforces what the design claims, rather than merely applying.
-- Run: docker compose exec -T postgres psql -U comments -d comments -f - < scripts/verify-schema.sql

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

BEGIN;

-- Two tenants, one platform, same watched subject.
INSERT INTO channels (id, tenant_id, platform, subject_external_id, status)
VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bluesky', 'did:plc:alice', 'active'),
       ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002',
        'bluesky', 'did:plc:bob', 'active');

INSERT INTO posts (id, tenant_id, channel_id, external_post_id)
VALUES ('aaaa1111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'at://alice/post/1');

INSERT INTO comments (id, tenant_id, channel_id, post_id, external_id,
                      created_at_remote, first_seen_at, last_synced_at)
VALUES ('cccc1111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'aaaa1111-0000-0000-0000-000000000001',
        'at://alice/comment/1', now(), now(), now());

\echo '--- checks ---'

-- 1. uuidv7 is available and ordered by time (PostgreSQL 18 builtin).
SELECT CASE WHEN uuidv7() < uuidv7() THEN 'ok  uuidv7 present and time-ordered'
            ELSE 'FAIL uuidv7 not ordered' END;

-- 2. ingest_seq is handed out at insert and is unique.
SELECT CASE WHEN (SELECT count(DISTINCT ingest_seq) = count(*) FROM comments)
            THEN 'ok  ingest_seq unique' ELSE 'FAIL ingest_seq collision' END;

-- 3. A comment cannot point at a post from another tenant.
DO $$
BEGIN
  INSERT INTO comments (tenant_id, channel_id, post_id, external_id,
                        created_at_remote, first_seen_at, last_synced_at)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
          'aaaa1111-0000-0000-0000-000000000001', 'at://bob/comment/1',
          now(), now(), now());
  RAISE EXCEPTION 'FAIL cross-tenant post reference was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'ok  cross-tenant post reference rejected by %', 'comment_post_in_same_channel';
END $$;

-- 4. A reply cannot be queued against another tenant's comment.
DO $$
BEGIN
  INSERT INTO outbound_replies (tenant_id, in_reply_to_comment_id, channel_id,
                                idempotency_key, body, created_at)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'cccc1111-0000-0000-0000-000000000001',
          '22222222-2222-2222-2222-222222222222', 'key-1', 'hello', now());
  RAISE EXCEPTION 'FAIL cross-tenant reply was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'ok  cross-tenant reply rejected by %', 'reply_comment_in_same_channel';
END $$;

-- 5. A comment cannot be given a parent from another channel.
DO $$
BEGIN
  INSERT INTO posts (id, tenant_id, channel_id, external_post_id)
  VALUES ('aaaa2222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002',
          '22222222-2222-2222-2222-222222222222', 'at://bob/post/1');
  INSERT INTO comments (tenant_id, channel_id, post_id, external_id, parent_id,
                        created_at_remote, first_seen_at, last_synced_at)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
          'aaaa2222-0000-0000-0000-000000000002', 'at://bob/comment/2',
          'cccc1111-0000-0000-0000-000000000001', now(), now(), now());
  RAISE EXCEPTION 'FAIL cross-channel parent was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'ok  cross-channel parent rejected by %', 'comment_parent';
END $$;

-- 6. The same external comment cannot land twice in one channel.
DO $$
BEGIN
  INSERT INTO comments (tenant_id, channel_id, post_id, external_id,
                        created_at_remote, first_seen_at, last_synced_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
          'aaaa1111-0000-0000-0000-000000000001', 'at://alice/comment/1',
          now(), now(), now());
  RAISE EXCEPTION 'FAIL duplicate external_id was accepted';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'ok  duplicate external_id rejected, upsert target present';
END $$;

-- 7. A read-only channel needs no credential, and the composite key tolerates the NULL.
INSERT INTO channels (tenant_id, platform, subject_external_id, status, credential_id)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bluesky', 'did:plc:public', 'active', NULL);
SELECT 'ok  read-only channel accepted without credential';

-- 8. A channel cannot borrow an account belonging to another platform.
DO $$
BEGIN
  INSERT INTO platform_credentials (id, tenant_id, platform, credential_ref)
  VALUES ('cccc1111-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001', 'instagram', 'secret://meta');
  INSERT INTO channels (tenant_id, platform, subject_external_id, status, credential_id)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bluesky', 'did:plc:mismatch', 'active',
          'cccc1111-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'FAIL a credential from another platform was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'ok  cross-platform credential rejected by %', 'channel_credential_same_tenant_and_platform';
END $$;

-- 9. A status outside its vocabulary is refused by the column, not by the caller.
DO $$
BEGIN
  UPDATE comments SET lifecycle = 'archived'
   WHERE external_id = 'at://alice/comment/1';
  RAISE EXCEPTION 'FAIL an unknown lifecycle was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  unknown lifecycle rejected by comment_lifecycle';
END $$;

-- 10. A comment waiting to be handled carries no record of having been handled.
DO $$
BEGIN
  INSERT INTO comment_states (comment_id, tenant_id, handling, handled_at, handled_by, updated_at)
  SELECT id, tenant_id, 'new', now(), 'human-1', now()
    FROM comments WHERE external_id = 'at://alice/comment/1';
  RAISE EXCEPTION 'FAIL an unhandled comment was recorded as handled';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  handled metadata rejected on a new comment';
END $$;

ROLLBACK;
