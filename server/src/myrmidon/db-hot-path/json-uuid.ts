// myrmidon(D2): query-fragment helpers for the board DB hot-path fix. See
// docs/myrmidon/DIVERGENCE.md.
import { sql, type SQL } from "drizzle-orm";

// A uuid written into a jsonb column always round-trips through jsonb ->> text.
// Comparing a uuid column to that text (`col::text = json ->> 'key'`) throws
// away the column's primary-key index, so Postgres falls back to a sequential
// scan of the whole table on every sweep call. Casting the json text straight
// to uuid would instead abort the whole statement on one malformed/legacy
// value; this shape check keeps the cast total by returning SQL NULL (which
// matches no uuid row) for anything that is not uuid-shaped.
//
// Equivalent to the text comparison it replaces: the uuid side of every
// comparison below is a real uuid column, so `col::text = <text>` could only
// ever be true for a uuid-shaped <text> in the first place.
export const UUID_SHAPE =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * `(json ->> 'key')` guarded into a uuid (or NULL when absent / not
 * uuid-shaped). Use it wherever a uuid column used to be compared against a
 * json text field as text: `eq(col, jsonTextUuid(sql`${payload} ->> 'key'`))`.
 */
export function jsonTextUuid(jsonText: SQL): SQL {
  // The parentheses around jsonText are load-bearing: `->>` binds looser than
  // `::`, so `${jsonText}::uuid` would parse as `col ->> ('key'::uuid)` and
  // abort the statement with 22P02 before the shape guard ever runs.
  return sql`(case when (${jsonText}) ~ ${UUID_SHAPE} then (${jsonText})::uuid end)`;
}