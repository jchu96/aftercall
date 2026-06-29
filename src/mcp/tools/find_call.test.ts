import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { setupD1 } from "../../../test/setup-d1";
import { findCall } from "./find_call";

interface SeedRow {
  video_id: string;
  meeting_code: string | null;
  title: string;
  participants?: unknown[];
}

async function seed(row: SeedRow) {
  await env.DB.prepare(
    `INSERT INTO transcripts (video_id, title, meeting_code, participants)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(
      row.video_id,
      row.title,
      row.meeting_code,
      JSON.stringify(row.participants ?? []),
    )
    .run();
}

describe("findCall", () => {
  beforeEach(async () => {
    await setupD1();
  });

  it("resolves a row stored schemeless when given a full Meet URL (the original bug)", async () => {
    await seed({
      video_id: "meet.google.com/www-jjni-xtd",
      meeting_code: "www-jjni-xtd",
      title: "Pricing sync",
    });
    const out = await findCall({ query: "https://meet.google.com/www-jjni-xtd" }, env);
    expect(out.content[0].text).toContain("meet.google.com/www-jjni-xtd");
    expect(out.content[0].text).toContain("Pricing sync");
  });

  it("resolves by bare meeting code", async () => {
    await seed({
      video_id: "meet.google.com/www-jjni-xtd",
      meeting_code: "www-jjni-xtd",
      title: "Pricing sync",
    });
    const out = await findCall({ query: "www-jjni-xtd" }, env);
    expect(out.content[0].text).toContain("Pricing sync");
  });

  it("resolves a hex id row", async () => {
    await seed({
      video_id: "6a3d78cf66c5e7f2aa6acf8d",
      meeting_code: "6a3d78cf66c5e7f2aa6acf8d",
      title: "Main Service Panel Naming",
    });
    const out = await findCall({ query: "6a3d78cf66c5e7f2aa6acf8d" }, env);
    expect(out.content[0].text).toContain("Main Service Panel Naming");
  });

  it("matches by title substring (case-insensitive)", async () => {
    await seed({ video_id: "x1", meeting_code: null, title: "Q3 Planning Session" });
    const out = await findCall({ query: "q3 planning" }, env);
    expect(out.content[0].text).toContain("Q3 Planning Session");
  });

  it("matches by participant name via json_each", async () => {
    await seed({
      video_id: "x2",
      meeting_code: null,
      title: "1:1",
      participants: [{ name: "Pierce Brosnan", email: "p@example.com" }],
    });
    const out = await findCall({ query: "pierce" }, env);
    expect(out.content[0].text).toContain("1:1");
  });

  it("ranks an exact code match above a weaker title match", async () => {
    await seed({ video_id: "meet.google.com/abc-defg-hij", meeting_code: "abc-defg-hij", title: "Random" });
    await seed({ video_id: "y2", meeting_code: null, title: "abc-defg-hij retro notes" });
    const out = await findCall({ query: "abc-defg-hij" }, env);
    const text = out.content[0].text;
    // The exact-code row should be listed first.
    expect(text.indexOf("meet.google.com/abc-defg-hij")).toBeLessThan(text.indexOf("y2"));
  });

  it("returns a search_calls hint for prose with no lexical hits", async () => {
    await seed({ video_id: "z1", meeting_code: null, title: "Budget review" });
    const out = await findCall({ query: "what did we decide about hiring" }, env);
    expect(out.content[0].text.toLowerCase()).toContain("search_calls");
  });

  it("returns an identifier-not-found message for an unknown code", async () => {
    const out = await findCall({ query: "https://meet.google.com/zzz-zzzz-zzz" }, env);
    expect(out.content[0].text).toContain("zzz-zzzz-zzz");
    expect(out.content[0].text.toLowerCase()).toContain("no call");
  });
});
