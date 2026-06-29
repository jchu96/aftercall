import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { setupD1 } from "../../../test/setup-d1";
import { getCall } from "./get_call";

describe("getCall", () => {
  beforeEach(async () => {
    await setupD1();
  });

  it("returns formatted details (title, summary, participants, action items) for a known video_id", async () => {
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, raw_text, summary, bluedot_summary, participants, action_items)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        "https://meet.google.com/abc-xyz",
        "Weekly sync with Pierce",
        "Long transcript text...",
        "We discussed the Q2 plan and next steps for IronRidge.",
        "Short bluedot summary",
        JSON.stringify([
          { name: "Jeremy Chu", email: "j@example.com" },
          { name: "Pierce Somebody", email: "p@example.com" },
        ]),
        JSON.stringify([
          { task: "Send proposal to Pierce", owner: "Jeremy", due_date: "2026-04-21" },
          { task: "Review spec", owner: "Pierce" },
        ]),
      )
      .run();

    const out = await getCall({ video_id: "https://meet.google.com/abc-xyz" }, env);
    const text = out.content[0].text;

    expect(text).toContain("Weekly sync with Pierce");
    expect(text).toContain("IronRidge");
    expect(text).toContain("Jeremy Chu");
    expect(text).toContain("Pierce");
    expect(text).toContain("Send proposal to Pierce");
    expect(text).toContain("2026-04-21");
    expect(text).toContain("https://meet.google.com/abc-xyz");
  });

  it("returns a not-found message when video_id is unknown", async () => {
    const out = await getCall({ video_id: "nonexistent" }, env);
    expect(out.content[0].text.toLowerCase()).toContain("not found");
  });

  it("resolves a schemeless-stored row when given a full Meet URL", async () => {
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, meeting_code, summary, participants, action_items)
       VALUES (?1, ?2, ?3, ?4, '[]', '[]')`,
    )
      .bind("meet.google.com/www-jjni-xtd", "Schemeless call", "www-jjni-xtd", "A summary.")
      .run();

    const out = await getCall({ video_id: "https://meet.google.com/www-jjni-xtd" }, env);
    expect(out.content[0].text).toContain("Schemeless call");
  });

  it("returns a disambiguation list when two rows share a meeting_code (recurring meeting)", async () => {
    // Recurring Google Meet reuses the same code each week → two rows, one code.
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, meeting_code, summary, participants, action_items)
       VALUES ('wk1','Weekly standup (wk1)','www-jjni-xtd','s','[]','[]'),
              ('wk2','Weekly standup (wk2)','www-jjni-xtd','s','[]','[]')`,
    ).run();

    const out = await getCall({ video_id: "https://meet.google.com/www-jjni-xtd" }, env);
    const text = out.content[0].text;
    expect(text).toContain("wk1");
    expect(text).toContain("wk2");
    expect(text.toLowerCase()).toMatch(/multiple|pick|which/);
  });

  it("returns a disambiguation list (not a guessed row) when a fuzzy query matches multiple", async () => {
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, meeting_code, summary, participants, action_items)
       VALUES ('a1','Planning one','c1','s','[]','[]'), ('a2','Planning two','c2','s','[]','[]')`,
    ).run();

    const out = await getCall({ video_id: "Planning" }, env);
    const text = out.content[0].text;
    expect(text).toContain("Planning one");
    expect(text).toContain("Planning two");
    expect(text.toLowerCase()).toMatch(/multiple|pick|which/);
  });
});
