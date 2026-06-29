/**
 * Meeting-identifier normalization.
 *
 * `video_id` is stored verbatim as Bluedot sends it — sometimes a full URL
 * (`https://meet.google.com/www-jjni-xtd`), sometimes a schemeless path
 * (`meet.google.com/www-jjni-xtd`), sometimes a bare code (`www-jjni-xtd`),
 * sometimes an opaque hex id. That inconsistency means an exact
 * `WHERE video_id = ?` lookup misses whenever the caller's form differs from
 * the stored form.
 *
 * `resolveMeetingCode` collapses any of those forms to a single canonical
 * code, which is persisted in the indexed `meeting_code` column at ingest and
 * recomputed from user input at query time. It is the join key for all
 * identifier lookups. Pure — no I/O.
 */

/** A Google-Meet slug: three groups of letters, e.g. `www-jjni-xtd` / `abc-defg-hij`. */
const MEET_SLUG = /^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$/;
/** A bare hex object id (Bluedot's non-Meet meeting id). */
const HEX_ID = /^[0-9a-f]{16,}$/;

/**
 * Derive the canonical meeting code from any identifier form, or `null` when
 * the input doesn't look like a meeting identifier (treat as a text query).
 */
export function resolveMeetingCode(raw: string): string | null {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;

  // Strip scheme, then a leading host-style "www." (dot-anchored, so a code
  // like "www-jjni-xtd" is preserved).
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  // Drop query string / fragment.
  s = s.split(/[?#]/, 1)[0];
  // Drop trailing slash(es).
  s = s.replace(/\/+$/, "");

  // Provider-specific path extraction.
  if (s.includes("zoom.us/j/")) {
    const id = s.slice(s.indexOf("zoom.us/j/") + "zoom.us/j/".length).split("/")[0];
    return id ? `zoom:${id}` : null;
  }
  if (s.includes("meet.google.com/")) {
    const code = s.slice(s.indexOf("meet.google.com/") + "meet.google.com/".length).split("/")[0];
    return code || null;
  }

  // Bare forms.
  if (MEET_SLUG.test(s)) return s;
  if (HEX_ID.test(s)) return s;

  // Anything else (prose, partial words, unknown hosts) is not an identifier.
  return null;
}
