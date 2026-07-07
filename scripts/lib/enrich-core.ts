/**
 * Pure helpers for the video-enrichment script (scripts/enrich-video.ts).
 *
 * Everything here is I/O-free (no fs, fetch, child_process, or process) so it is
 * unit-testable in the workers vitest pool and the CLI orchestration stays a thin
 * shell around it. Node-touching work (upload, ffmpeg, D1, ledger persistence)
 * lives in enrich-video.ts.
 */
import { resolveMeetingCode } from "../../src/identity";

export interface Incident {
  start: string;
  end: string;
  speaker?: string;
  surface?: string;
  summary: string;
  severity: string;
}

export interface IssueDetail {
  is_real_issue: boolean;
  problem: string;
  expected?: string;
  actual: string;
  where?: { app_url?: string; step?: string; surface?: string };
  evidence?: { timestamp?: string; verbatim_ui_text?: string; reporter_quote?: string; speaker?: string };
  repro_as_observed?: string[];
  severity?: string;
  confidence_notes?: string;
}

export interface CallContext {
  title?: string;
  summary?: string;
  actionItems?: unknown[];
  createdAt?: string;
}

export interface LedgerRow {
  meetingCode: string;
  videoPath: string;
  videoBytes: number;
  fileName: string; // Gemini "files/xxxx"
  fileUri: string;
  mimeType: string;
  uploadedAt: string;
  expiresAt: string; // 48h after upload
  dossierDir: string;
  incidentCount?: number;
  model: string;
}

export interface DossierItem {
  inc: Incident;
  detail: IssueDetail;
  frame?: string;
}

/** Read a `--flag` / `--flag=value` from an argv array. Returns "true" for a bare flag. */
export function readFlag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
}

/** "MM:SS" / "HH:MM:SS" / "123s" -> seconds. */
export function parseTimecode(s: string): number {
  if (/^\d+s$/.test(s)) return Number(s.slice(0, -1));
  const parts = s.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Meeting code from a --code override or the recording filename. Meet recordings
 * are named like `bak-owvg-rzg (2026-07-06 …).mp4`, so try a leading Meet-slug
 * token before falling back to resolving the whole name.
 */
export function deriveCode(filename: string, override?: string): string | null {
  if (override) return resolveMeetingCode(override);
  const token = filename.match(/^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}/i)?.[0] ?? filename.split(/[ (._]/)[0];
  return resolveMeetingCode(token) ?? resolveMeetingCode(filename);
}

/**
 * Interrogation window for an incident: widen a touch around the index-pass
 * timestamps (which are approximate) so a slightly-mistimed entry is still in
 * frame. Returns `{start,end}` in whole seconds, start clamped at 0.
 */
export function clipWindow(inc: Pick<Incident, "start" | "end">): { start: number; end: number } {
  return { start: Math.max(0, parseTimecode(inc.start) - 5), end: parseTimecode(inc.end) + 8 };
}

/**
 * Find a still-live prior upload to reuse (skip re-upload) — same call + same
 * byte size, not yet expired. `nowMs` is passed in to keep this pure/testable.
 */
export function findReusableUpload(
  rows: LedgerRow[],
  code: string,
  bytes: number,
  nowMs: number,
): LedgerRow | undefined {
  return rows.find(
    (r) => r.meetingCode === code && r.videoBytes === bytes && new Date(r.expiresAt).getTime() > nowMs,
  );
}

const base = (p: string): string => p.split("/").pop() ?? p;

/** Render the paste-ready dossier markdown. Pure — takes already-computed items. */
export function renderDossierMarkdown(
  code: string,
  ctx: CallContext | null,
  matchNotes: string,
  items: DossierItem[],
): string {
  const real = items.filter((x) => x.detail.is_real_issue);
  const discarded = items.filter((x) => !x.detail.is_real_issue);
  const md: string[] = [];
  md.push(`# Video dossier — ${ctx?.title ?? code}`);
  md.push(
    `\nMeeting code: \`${code}\`  ·  Call date: ${ctx?.createdAt ?? "?"}  ·  Confirmed issues: ${real.length}${discarded.length ? `  ·  Discarded on re-watch: ${discarded.length}` : ""}`,
  );
  if (matchNotes) md.push(`\n> Match check: ${matchNotes}`);
  md.push(`\n---`);
  real.forEach((x, i) => {
    const d = x.detail;
    md.push(`\n## ${i + 1}. ${d.problem}`);
    md.push(
      `\n**Severity:** ${d.severity ?? x.inc.severity}  ·  **When:** ${d.evidence?.timestamp ?? x.inc.start}${x.inc.speaker ? `  ·  **Who:** ${x.inc.speaker}` : ""}`,
    );
    if (d.where?.app_url)
      md.push(`\n**Where:** \`${d.where.app_url}\`${d.where.step ? ` (step ${d.where.step})` : ""}${d.where.surface ? ` — ${d.where.surface}` : ""}`);
    if (d.expected || d.actual) md.push(`\n**Expected:** ${d.expected ?? "—"}\n\n**Actual:** ${d.actual}`);
    if (d.evidence?.verbatim_ui_text) md.push(`\n**On-screen (verbatim):**\n\n> ${d.evidence.verbatim_ui_text.replace(/\n/g, "\n> ")}`);
    if (d.evidence?.reporter_quote) md.push(`\n**They said:** "${d.evidence.reporter_quote}"`);
    if (d.repro_as_observed?.length)
      md.push(`\n**Repro (as performed):**\n${d.repro_as_observed.map((s, k) => `${k + 1}. ${s}`).join("\n")}`);
    md.push(`\n**Watch:** ${x.inc.start}–${x.inc.end}`);
    if (x.frame) md.push(`\n![incident ${i + 1}](./${base(x.frame)})`);
    if (d.confidence_notes) md.push(`\n_Confidence: ${d.confidence_notes}_`);
    md.push(`\n---`);
  });
  if (discarded.length) {
    md.push(`\n## Discarded on re-watch (not real issues)`);
    discarded.forEach((x) => md.push(`- ${x.inc.start} — ${x.inc.summary} — _${x.detail.confidence_notes ?? "not confirmed"}_`));
  }
  return md.join("\n") + "\n";
}
