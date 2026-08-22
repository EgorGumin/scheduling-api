import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";

/** What we decided about a comment; mirrors the check constraint on `comment_states`. */
export const HANDLING = ["new", "answered", "escalated", "ignored"] as const;
export type Handling = (typeof HANDLING)[number];

export interface StatePatch {
  readonly handling?: Handling | undefined;
  /** Absent leaves the note alone; `null` clears it. */
  readonly note?: string | null | undefined;
}

export const triageStateSchema = z.object({
  handling: z.enum(HANDLING),
  handledAt: z.iso.datetime().nullable(),
  handledBy: z.string().nullable(),
  note: z.string().nullable(),
});
export type TriageState = z.infer<typeof triageStateSchema>;

type Row = {
  handling: Handling;
  handled_at: string | null;
  handled_by: string | null;
  note: string | null;
};

/**
 * Records a decision about a comment. `null` when there is nothing to decide
 * about: no such comment for this tenant, or the comment is a reply of ours.
 */
export async function setHandling(
  db: Database,
  tenantId: string,
  commentId: string,
  patch: StatePatch,
  actor: string | null,
): Promise<TriageState | null> {
  // `new` alongside a handler is a contradiction the schema refuses, so
  // reopening clears the timestamp and the actor.
  const reopened = patch.handling === "new";
  const handling = patch.handling ?? null;

  const rows = await db.execute<Row>(sql`
    UPDATE comment_states
       SET handling = COALESCE(${handling}, handling),
           note = CASE WHEN ${patch.note === undefined} THEN note ELSE ${patch.note ?? null} END,
           handled_at = CASE WHEN ${reopened} THEN NULL
                             WHEN ${handling}::text IS NULL THEN handled_at
                             ELSE now() END,
           handled_by = CASE WHEN ${reopened} THEN NULL
                             WHEN ${handling}::text IS NULL THEN handled_by
                             ELSE COALESCE(${actor}, handled_by) END,
           updated_at = now()
     WHERE comment_id = ${commentId}::uuid AND tenant_id = ${tenantId}::uuid
       -- A reply of ours is seeded with a state row before the next pass marks
       -- it outbound. The read side never shows that row; this keeps it unwritten.
       AND EXISTS (SELECT 1 FROM comments c
                    WHERE c.id = comment_states.comment_id AND c.is_outbound = false)
    RETURNING handling, handled_at, handled_by, note
  `);

  const row = rows.at(0);
  if (row === undefined) {
    return null;
  }
  return {
    handling: row.handling,
    handledAt: row.handled_at === null ? null : new Date(row.handled_at).toISOString(),
    handledBy: row.handled_by,
    note: row.note,
  };
}
