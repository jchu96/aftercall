import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleWebhook, type HandlerDeps } from "./handler";
import { setupD1 } from "../test/setup-d1";

beforeEach(async () => {
  await setupD1();
});

const TEST_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

async function signedRequest(payload: unknown): Promise<Request> {
  const body = JSON.stringify(payload);
  const svixId = "msg_" + Math.random().toString(36).slice(2);
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `${svixId}.${timestamp}.${body}`;
  const secretBytes = Uint8Array.from(
    atob(TEST_SECRET.replace(/^whsec_/, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return new Request("http://localhost/", {
    method: "POST",
    body,
    headers: {
      "svix-id": svixId,
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${b64}`,
    },
  });
}

function transcriptPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "meeting.transcript.created",
    meetingId: "https://meet.google.com/test-mtg-id",
    videoId: "v_test",
    title: "Test sync",
    createdAt: 1741088306,
    attendees: ["alice@example.com"],
    transcript: [
      { speaker: "Speaker: A", text: "Hi." },
      { speaker: "Speaker: B", text: "Hello." },
    ],
    ...overrides,
  };
}

const fakeSummary = {
  title: "Test sync",
  summary: "Brief test discussion.",
  action_items: [
    { task: "Send notes", owner: "Alice", due_date: "Friday" },
    { task: "Book room" },
  ],
  participants: [{ name: "Alice" }, { name: "Bob" }],
};

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const openai = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...fakeSummary,
                  action_items: fakeSummary.action_items.map((a) => ({
                    task: a.task,
                    owner: a.owner ?? null,
                    due_date: a.due_date ?? null,
                  })),
                  participants: fakeSummary.participants.map((p) => ({
                    name: p.name ?? null,
                    email: null,
                    role: null,
                  })),
                }),
              },
            },
          ],
        }),
      },
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
      }),
    },
  } as never;

  const notion = {
    pagesCreate: vi.fn().mockResolvedValue({
      id: "page_id",
      url: "https://notion.so/page_id",
    }),
  };

  // Mock Vectorize binding (miniflare doesn't support it)
  env.VECTORIZE = {
    upsert: vi.fn().mockResolvedValue({ mutationId: "m1" }),
  } as unknown as VectorizeIndex;

  return {
    openai,
    notion,
    env,
    ...overrides,
  };
}

describe("handleWebhook", () => {
  it("returns 405 for non-POST", async () => {
    const res = await handleWebhook(
      new Request("http://localhost/", { method: "GET" }),
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });

  it("returns 401 for invalid signature", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
      headers: {
        "svix-id": "msg_x",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,invalid",
      },
    });
    const res = await handleWebhook(req, makeDeps());
    expect(res.status).toBe(401);
  });

  it("skips summary events with 200", async () => {
    const req = await signedRequest({
      type: "meeting.summary.created",
      meetingId: "x",
      videoId: "v",
      title: "x",
      summary: "Bluedot's summary",
    });
    const deps = makeDeps();
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ignored");
    expect(deps.openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("runs full pipeline for valid transcript: D1 + Vectorize + Notion + Followups", async () => {
    const req = await signedRequest(transcriptPayload());
    const deps = makeDeps();
    const res = await handleWebhook(req, deps);

    expect(res.status).toBe(200);
    expect(deps.openai.chat.completions.create).toHaveBeenCalledOnce();
    expect(deps.openai.embeddings.create).toHaveBeenCalledOnce();
    expect(env.VECTORIZE.upsert).toHaveBeenCalledOnce();
    // 1 transcript page + 2 followup rows = 3 Notion pages
    expect(deps.notion.pagesCreate).toHaveBeenCalledTimes(3);

    const row = await env.DB
      .prepare("SELECT video_id, title FROM transcripts WHERE video_id = ?")
      .bind("https://meet.google.com/test-mtg-id")
      .first();
    expect(row).toMatchObject({
      video_id: "https://meet.google.com/test-mtg-id",
      title: "Test sync",
    });
  });

  it("dedupes concurrent retries — 2nd call sees existing row, skips Notion", async () => {
    const req1 = await signedRequest(transcriptPayload());
    const req2 = await signedRequest(transcriptPayload());
    const deps1 = makeDeps();
    const deps2 = makeDeps();

    const [res1, res2] = await Promise.all([
      handleWebhook(req1, deps1),
      handleWebhook(req2, deps2),
    ]);

    // Both succeed
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Exactly one of them inserted, the other deduped
    const insertCalls =
      (deps1.notion.pagesCreate as ReturnType<typeof vi.fn>).mock.calls.length +
      (deps2.notion.pagesCreate as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(insertCalls).toBe(3); // only one ran the full Notion pipeline

    const { results } = await env.DB
      .prepare("SELECT COUNT(*) as count FROM transcripts WHERE video_id = ?")
      .bind("https://meet.google.com/test-mtg-id")
      .all();
    expect(results[0].count).toBe(1);
  });

  it("returns 200 even when Notion transcript page fails (DB is source of truth)", async () => {
    const req = await signedRequest(transcriptPayload());
    const deps = makeDeps({
      notion: {
        pagesCreate: vi.fn().mockRejectedValue(new Error("Notion 500")),
      },
    });
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT video_id FROM transcripts WHERE video_id = ?")
      .bind("https://meet.google.com/test-mtg-id")
      .first();
    expect(row).toBeTruthy();
  });

  it("returns 500 when extraction fails (so Svix retries)", async () => {
    const req = await signedRequest(transcriptPayload());
    const deps = makeDeps();
    (deps.openai.chat.completions.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("openai down"), { status: 500 }),
    );
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(500);
  });

  it("returns 400 on empty transcript array", async () => {
    const req = await signedRequest(transcriptPayload({ transcript: [] }));
    const deps = makeDeps();
    const res = await handleWebhook(req, deps);
    expect(res.status).toBe(400);
    expect(deps.openai.chat.completions.create).not.toHaveBeenCalled();
  });
});
