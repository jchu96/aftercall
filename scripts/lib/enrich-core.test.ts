import { describe, it, expect } from "vitest";
import {
  readFlag,
  parseTimecode,
  deriveCode,
  clipWindow,
  frameSeconds,
  findReusableUpload,
  renderDossierMarkdown,
  type LedgerRow,
  type DossierItem,
} from "./enrich-core";

describe("readFlag", () => {
  it("reads --flag=value", () => {
    expect(readFlag(["--max=5"], "max")).toBe("5");
    expect(readFlag(["--code=abc-def-ghi"], "code")).toBe("abc-def-ghi");
  });
  it("returns 'true' for a bare flag and undefined when absent", () => {
    expect(readFlag(["--reupload"], "reupload")).toBe("true");
    expect(readFlag(["--max=5"], "reupload")).toBeUndefined();
  });
  it("keeps '=' inside the value", () => {
    expect(readFlag(["--q=a=b=c"], "q")).toBe("a=b=c");
  });
});

describe("parseTimecode", () => {
  it("parses MM:SS", () => expect(parseTimecode("02:40")).toBe(160));
  it("parses HH:MM:SS", () => expect(parseTimecode("01:07:06")).toBe(4026));
  it("parses Ns", () => expect(parseTimecode("720s")).toBe(720));
});

describe("deriveCode", () => {
  it("extracts the Meet slug from a recording filename", () => {
    expect(deriveCode("bak-owvg-rzg (2026-07-06 21_06 GMT-4).mp4")).toBe("bak-owvg-rzg");
  });
  it("honors an explicit override (Meet URL)", () => {
    expect(deriveCode("whatever.mp4", "https://meet.google.com/xyz-abcd-efg")).toBe("xyz-abcd-efg");
  });
  it("returns null when nothing looks like a meeting id", () => {
    expect(deriveCode("random-recording.mp4")).toBeNull();
  });
});

describe("clipWindow", () => {
  it("widens the window and clamps start at 0", () => {
    expect(clipWindow({ start: "02:40", end: "02:44" })).toEqual({ start: 155, end: 172 });
    expect(clipWindow({ start: "00:02", end: "00:10" })).toEqual({ start: 0, end: 18 });
  });
});

describe("frameSeconds", () => {
  const inc = { start: "02:40", end: "02:44" }; // clip window [155, 172]
  it("uses an in-window absolute timestamp as-is", () => {
    expect(frameSeconds(inc, "02:41")).toBe(161);
  });
  it("clamps a below-window (clip-relative-looking) timestamp into the window", () => {
    expect(frameSeconds(inc, "00:03")).toBe(155);
  });
  it("clamps an above-window timestamp to the window end", () => {
    expect(frameSeconds(inc, "10:00")).toBe(172);
  });
  it("falls back to incident start when the timestamp is missing/unparseable", () => {
    expect(frameSeconds(inc)).toBe(160);
    expect(frameSeconds(inc, "not-a-time")).toBe(160);
  });
});

describe("findReusableUpload", () => {
  const now = Date.parse("2026-07-07T12:00:00Z");
  const base: LedgerRow = {
    meetingCode: "bak-owvg-rzg", videoPath: "/v.mp4", videoBytes: 100, fileName: "files/a",
    fileUri: "u", mimeType: "video/mp4", uploadedAt: "", expiresAt: "2026-07-08T12:00:00Z",
    dossierDir: "", model: "gemini-3.5-flash",
  };
  it("reuses a matching, unexpired row", () => {
    expect(findReusableUpload([base], "bak-owvg-rzg", 100, now)?.fileName).toBe("files/a");
  });
  it("skips an expired row", () => {
    expect(findReusableUpload([{ ...base, expiresAt: "2026-07-07T11:00:00Z" }], "bak-owvg-rzg", 100, now)).toBeUndefined();
  });
  it("skips on byte-size mismatch (different recording, same code)", () => {
    expect(findReusableUpload([base], "bak-owvg-rzg", 999, now)).toBeUndefined();
  });
  it("skips on code mismatch", () => {
    expect(findReusableUpload([base], "other-code-xyz", 100, now)).toBeUndefined();
  });
});

describe("renderDossierMarkdown", () => {
  const items: DossierItem[] = [
    {
      inc: { start: "02:40", end: "02:44", speaker: "Jane", surface: "BOM", summary: "csv missing field", severity: "med" },
      detail: {
        is_real_issue: true,
        problem: "CSV lacks the LIS number",
        expected: "LIS number present",
        actual: "no LIS column",
        where: { app_url: "https://app.example.com/bom", step: "4", surface: "BOM export" },
        evidence: { timestamp: "02:41", verbatim_ui_text: "Export NetSuite CSV", reporter_quote: "I thought the LIS would be here", speaker: "Jane" },
        repro_as_observed: ["Open Review & Export", "Click Export", "Open the CSV"],
        severity: "med",
        confidence_notes: "url legible",
      },
      frame: "/tmp/dossier/incident-01.png",
    },
    {
      inc: { start: "05:00", end: "05:10", summary: "just hovering", severity: "low" },
      detail: { is_real_issue: false, problem: "not a bug", actual: "user hovered", confidence_notes: "no defect" },
    },
  ];
  const md = renderDossierMarkdown("bak-owvg-rzg", { title: "BOM Fixes", createdAt: "2026-07-07" }, "matches", items);

  it("headers with title and confirmed/discarded counts", () => {
    expect(md).toContain("# Video dossier — BOM Fixes");
    expect(md).toContain("Confirmed issues: 1");
    expect(md).toContain("Discarded on re-watch: 1");
  });
  it("renders the confirmed issue with url, verbatim text, quote, repro, screenshot", () => {
    expect(md).toContain("## 1. CSV lacks the LIS number");
    expect(md).toContain("`https://app.example.com/bom` (step 4)");
    expect(md).toContain("> Export NetSuite CSV");
    expect(md).toContain('"I thought the LIS would be here"');
    expect(md).toContain("1. Open Review & Export");
    expect(md).toContain("![incident 1](./incident-01.png)");
  });
  it("lists the discarded item separately, not as a numbered issue", () => {
    expect(md).toContain("- 05:00 — just hovering — _no defect_");
    expect(md).not.toContain("## 2.");
  });
  it("omits app_url line when empty (abstention path)", () => {
    const noUrl = renderDossierMarkdown("c", null, "", [
      { inc: { start: "01:00", end: "01:05", summary: "x", severity: "low" }, detail: { is_real_issue: true, problem: "p", actual: "a", where: { app_url: "" } } },
    ]);
    expect(noUrl).not.toContain("**Where:**");
  });
});
