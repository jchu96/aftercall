import OpenAI from "openai";
import type { Env } from "./env";
import { verifyBluedotWebhook, WebhookVerificationError } from "./webhook-verify";
import {
  isTranscriptEvent,
  normalizeTranscriptEvent,
  type BluedotWebhookPayload,
} from "./bluedot";
import { extractFromTranscript, DEFAULT_MODEL } from "./extract";
import { chunkTranscript, generateEmbeddings } from "./embeddings";
import { writeTranscript } from "./d1";
import { upsertChunkEmbeddings, type EmbeddedChunk } from "./vectorize";
import { createTranscriptPage, createFollowupRow, type NotionDeps, createNotionDeps } from "./notion";
import { log } from "./logger";

export interface HandlerDeps {
  openai: OpenAI;
  notion: NotionDeps;
  env: Env;
}

export async function handleWebhook(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await request.text();

  let payload: BluedotWebhookPayload;
  try {
    payload = verifyBluedotWebhook<BluedotWebhookPayload>(
      body,
      request.headers,
      deps.env.BLUEDOT_WEBHOOK_SECRET,
    );
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      log("warn", "webhook_verify_failed", { error: err.message });
      return new Response("Unauthorized", { status: 401 });
    }
    throw err;
  }

  const svixId = request.headers.get("svix-id") ?? "";
  log("info", "webhook_received", {
    type: payload.type,
    meeting_id: payload.meetingId,
    title: payload.title,
    svix_id: svixId,
  });

  if (!isTranscriptEvent(payload)) {
    log("info", "webhook_skipped_non_transcript", {
      type: payload.type,
      meeting_id: payload.meetingId,
    });
    return new Response("OK (event ignored)", { status: 200 });
  }

  let normalized;
  try {
    normalized = normalizeTranscriptEvent(payload);
  } catch (err) {
    log("error", "normalize_failed", {
      error: err instanceof Error ? err.message : String(err),
      meeting_id: payload.meetingId,
    });
    return new Response("Bad payload", { status: 400 });
  }

  try {
    // 1. Extract structured summary via OpenAI
    const summary = await extractFromTranscript(
      {
        title: normalized.title,
        transcript: normalized.transcriptText,
        attendees: normalized.attendees,
      },
      {
        client: deps.openai,
        model: deps.env.OPENAI_EXTRACTION_MODEL || DEFAULT_MODEL,
      },
    );
    log("info", "extract_ready", {
      video_id: normalized.videoId,
      action_items: summary.action_items.length,
      participants: summary.participants.length,
    });

    // 2. Chunk + embed transcript
    const chunks = chunkTranscript(normalized.transcriptText, {
      maxTokens: 500,
      overlapTokens: 50,
    });
    const embedded = await generateEmbeddings(chunks, { client: deps.openai });
    log("info", "embeddings_ready", { video_id: normalized.videoId, chunks: embedded.length });

    // 3. Write to D1 FIRST (idempotency gate — concurrent retries dedupe here
    //    before any Notion writes happen)
    const writeResult = await writeTranscript(deps.env.DB, {
      videoId: normalized.videoId,
      svixId,
      title: summary.title || normalized.title,
      rawText: normalized.transcriptText,
      summary: summary.summary,
      participants: summary.participants,
      actionItems: summary.action_items,
      language: normalized.language,
    });

    if (!writeResult.inserted) {
      log("info", "duplicate_skipped", { video_id: normalized.videoId });
      return new Response("OK (duplicate)", { status: 200 });
    }

    log("info", "transcript_inserted", {
      video_id: normalized.videoId,
      transcript_id: writeResult.transcriptId,
    });

    // 4. Upsert embeddings into Vectorize (after D1 so we have transcript_id)
    const vectorChunks: EmbeddedChunk[] = embedded.map((e) => ({
      transcriptId: writeResult.transcriptId!,
      chunkIndex: e.chunkIndex,
      text: e.text,
      embedding: e.embedding,
    }));
    await upsertChunkEmbeddings(deps.env.VECTORIZE, vectorChunks);
    log("info", "vectors_upserted", {
      video_id: normalized.videoId,
      count: vectorChunks.length,
    });

    // 5. Create Notion transcript page (failures non-fatal — D1 is source of truth)
    try {
      const page = await createTranscriptPage(
        {
          dataSourceId: deps.env.NOTION_TRANSCRIPTS_DATA_SOURCE_ID,
          title: summary.title || normalized.title,
          summary: summary.summary,
          participants: summary.participants,
          actionItems: summary.action_items,
          videoId: normalized.videoId,
          language: normalized.language,
          createdAt: normalized.createdAt ?? new Date(),
        },
        deps.notion,
      );
      log("info", "transcript_page_created", {
        video_id: normalized.videoId,
        page_id: page.pageId,
      });
    } catch (err) {
      log("error", "transcript_page_failed", {
        video_id: normalized.videoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 6. One Followups row per action item (each failure is independent)
    let followupsCreated = 0;
    for (const item of summary.action_items) {
      try {
        await createFollowupRow(
          {
            dataSourceId: deps.env.NOTION_FOLLOWUPS_DATA_SOURCE_ID,
            task: item.task,
            owner: item.owner,
            due_date: item.due_date,
            meetingTitle: summary.title || normalized.title,
            meetingUrl: normalized.meetingUrl,
            videoId: normalized.videoId,
          },
          deps.notion,
        );
        followupsCreated++;
      } catch (err) {
        log("error", "followup_failed", {
          video_id: normalized.videoId,
          task: item.task,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("info", "followups_created", {
      video_id: normalized.videoId,
      count: followupsCreated,
      total: summary.action_items.length,
    });

    return new Response("OK", { status: 200 });
  } catch (err) {
    log("error", "pipeline_failed", {
      video_id: normalized.videoId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Return 500 so Svix retries
    return new Response("Processing failed", { status: 500 });
  }
}

export function buildHandlerDeps(env: Env): HandlerDeps {
  return {
    openai: new OpenAI({ apiKey: env.OPENAI_API_KEY }),
    notion: createNotionDeps(env.NOTION_INTEGRATION_KEY),
    env,
  };
}
