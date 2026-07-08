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

  it("lists the newest recording first when a reused code matches multiple rows (issue #5)", async () => {
    // Google recycles Meet codes across unrelated meetings — the June and July
    // calls share a room code but are distinct recordings. Newest first so the
    // most likely intended call leads the list.
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, meeting_code, summary, participants, action_items, created_at)
       VALUES ('5f1c2233445566778899aabb','Design tool soft launch','www-jjni-xtd','s','[]','[]','2026-06-15 17:00:00'),
              ('6a4e745f7249289731dfa86c','Design tool soft launch','www-jjni-xtd','s','[]','[]','2026-07-08 17:00:00')`,
    ).run();

    const out = await getCall({ video_id: "www-jjni-xtd" }, env);
    const text = out.content[0].text;
    expect(text.indexOf("6a4e745f7249289731dfa86c")).toBeGreaterThan(-1);
    expect(text.indexOf("6a4e745f7249289731dfa86c")).toBeLessThan(
      text.indexOf("5f1c2233445566778899aabb"),
    );
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
