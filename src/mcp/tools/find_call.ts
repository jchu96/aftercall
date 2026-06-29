import type { Env } from "../../env";
import type { ToolResult } from "./recent_calls";
import { lexicalLookup, formatCandidates } from "../resolve";
import { resolveMeetingCode } from "../../identity";

export interface FindCallInput {
  query: string;
  limit?: number;
}

/**
 * Locate a specific call by any identifier a human might paste or mention:
 * a Meet/Zoom URL, a bare meeting code, a hex id, a title fragment, or a
 * participant name/email. Pure lexical (no embeddings) — the structured
 * counterpart to the semantic `search_calls`.
 */
export async function findCall(input: FindCallInput, env: Env): Promise<ToolResult> {
  const query = (input.query ?? "").trim();
  if (!query) {
    return { content: [{ type: "text", text: "Missing `query` argument." }] };
  }
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));

  const rows = await lexicalLookup(query, env, limit);

  if (rows.length === 0) {
    // Distinguish a normalized-but-absent identifier from prose with no hits,
    // and name the recovery tool so the model doesn't dead-end.
    const code = resolveMeetingCode(query);
    const text = code
      ? `No call matches identifier \`${code}\` (normalized from "${query}"). It may not be indexed yet — try \`recent_calls\` to list recent meetings.`
      : `No call found matching "${query}" by title or participant. If you're describing a topic rather than naming a specific meeting, use \`search_calls\` instead.`;
    return { content: [{ type: "text", text }] };
  }

  const header =
    rows.length === 1
      ? `Resolved "${query}" → 1 call. Use its \`video_id\` with get_call or answer_from_transcript:`
      : `Found ${rows.length} calls matching "${query}". Pick one by its \`video_id\`:`;

  return {
    content: [{ type: "text", text: `${header}\n\n${formatCandidates(rows)}` }],
  };
}
