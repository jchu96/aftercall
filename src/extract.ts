import OpenAI from "openai";
import type { ActionItem, Participant } from "./schema";

export interface ExtractedSummary {
  title: string;
  summary: string;
  action_items: ActionItem[];
  participants: Participant[];
}

export interface ExtractInput {
  title: string;
  transcript: string;
  attendees?: Array<{ email?: string; name?: string }>;
}

export interface ExtractOptions {
  client: OpenAI;
  model?: string;
  retries?: number;
  retryDelayMs?: number;
}

export const DEFAULT_MODEL = "gpt-4.1-nano";
const MAX_TRANSCRIPT_CHARS = 150_000;

const SYSTEM_PROMPT = `You are an expert assistant that extracts structured information from meeting transcripts.

Given a transcript, produce:
- title: a concise, descriptive title (improve the provided one if needed)
- summary: 2-4 sentences capturing topics and outcomes
- action_items: discrete follow-up tasks. Capture owner when stated ("I'll send the doc" → owner = speaker). Capture due_date in natural language ("Friday", "next week", "2026-05-01") when mentioned.
- participants: people who spoke or were mentioned as attending

Be specific. Prefer concrete action items over generic recommendations.`;

export const EXTRACTION_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["title", "summary", "action_items", "participants"],
  properties: {
    title: { type: "string" as const },
    summary: { type: "string" as const },
    action_items: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        required: ["task", "owner", "due_date"],
        properties: {
          task: { type: "string" as const },
          owner: { type: ["string", "null"] as const },
          due_date: { type: ["string", "null"] as const },
        },
      },
    },
    participants: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        required: ["name", "email", "role"],
        properties: {
          name: { type: ["string", "null"] as const },
          email: { type: ["string", "null"] as const },
          role: { type: ["string", "null"] as const },
        },
      },
    },
  },
};

function buildUserMessage(input: ExtractInput): string {
  const attendeesBlock =
    input.attendees && input.attendees.length > 0
      ? `Attendees from calendar:\n${input.attendees
          .map((a) => `- ${a.name ?? "unknown"}${a.email ? ` <${a.email}>` : ""}`)
          .join("\n")}\n\n`
      : "";

  let transcript = input.transcript;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const head = transcript.slice(0, Math.floor(MAX_TRANSCRIPT_CHARS * 0.7));
    const tail = transcript.slice(-Math.floor(MAX_TRANSCRIPT_CHARS * 0.2));
    transcript = `${head}\n\n[truncated ${input.transcript.length - head.length - tail.length} chars]\n\n${tail}`;
  }

  return `Meeting title: ${input.title}

${attendeesBlock}Transcript:
"""
${transcript}
"""

Extract the structured information per the schema.`;
}

/**
 * Strip nulls from optional fields back to undefined so consumers see clean shape.
 * Strict json_schema requires all properties be in `required`, so OpenAI returns
 * `null` for fields that don't apply — convert back to `undefined` here.
 */
function cleanResult(raw: ExtractedSummary): ExtractedSummary {
  return {
    title: raw.title,
    summary: raw.summary,
    action_items: raw.action_items.map((a) => ({
      task: a.task,
      ...(a.owner != null && { owner: a.owner }),
      ...(a.due_date != null && { due_date: a.due_date }),
    })),
    participants: raw.participants.map((p) => ({
      ...(p.name != null && { name: p.name }),
      ...(p.email != null && { email: p.email }),
      ...(p.role != null && { role: p.role }),
    })),
  };
}

export async function extractFromTranscript(
  input: ExtractInput,
  options: ExtractOptions,
): Promise<ExtractedSummary> {
  const model = options.model ?? DEFAULT_MODEL;
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await options.client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "transcript_extraction",
            strict: true,
            schema: EXTRACTION_SCHEMA,
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned empty content");

      let parsed: ExtractedSummary;
      try {
        parsed = JSON.parse(content) as ExtractedSummary;
      } catch (err) {
        throw new Error(`Failed to parse OpenAI response as JSON: ${(err as Error).message}`);
      }

      return cleanResult(parsed);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const isRetryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!isRetryable || attempt === retries - 1) throw err;
      const delay = retryDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}
