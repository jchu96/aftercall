import { describe, it, expect } from "vitest";
import { resolveMeetingCode } from "./identity";

describe("resolveMeetingCode", () => {
  it("extracts the bare code from a full https Meet URL, dropping query/hash", () => {
    expect(resolveMeetingCode("https://meet.google.com/www-jjni-xtd?authuser=0")).toBe(
      "www-jjni-xtd",
    );
    expect(resolveMeetingCode("https://meet.google.com/www-jjni-xtd#frag")).toBe(
      "www-jjni-xtd",
    );
  });

  it("normalizes a schemeless meet.google.com path to the same code", () => {
    expect(resolveMeetingCode("meet.google.com/www-jjni-xtd")).toBe("www-jjni-xtd");
  });

  it("passes a bare Meet slug through unchanged", () => {
    expect(resolveMeetingCode("www-jjni-xtd")).toBe("www-jjni-xtd");
  });

  it("normalizes http://, https://, and www. variants identically", () => {
    expect(resolveMeetingCode("http://meet.google.com/abc-defg-hij")).toBe("abc-defg-hij");
    expect(resolveMeetingCode("https://www.meet.google.com/abc-defg-hij")).toBe(
      "abc-defg-hij",
    );
  });

  it("is case-insensitive (uppercased URL → lowercase code)", () => {
    expect(resolveMeetingCode("HTTPS://MEET.GOOGLE.COM/ABC-DEFG-HIJ")).toBe("abc-defg-hij");
  });

  it("passes a bare hex id through unchanged", () => {
    expect(resolveMeetingCode("6a3d78cf66c5e7f2aa6acf8d")).toBe("6a3d78cf66c5e7f2aa6acf8d");
  });

  it("maps a Zoom join URL to a zoom: code and drops ?pwd", () => {
    expect(resolveMeetingCode("https://us02web.zoom.us/j/1234567890?pwd=secret")).toBe(
      "zoom:1234567890",
    );
    expect(resolveMeetingCode("zoom.us/j/1234567890")).toBe("zoom:1234567890");
  });

  it("returns null for prose / non-identifier input", () => {
    expect(resolveMeetingCode("what did we decide about pricing")).toBeNull();
    expect(resolveMeetingCode("Weekly sync with Pierce")).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(resolveMeetingCode("")).toBeNull();
    expect(resolveMeetingCode("   ")).toBeNull();
  });

  it("does not corrupt a code whose own prefix is 'www-' when stripping host 'www.'", () => {
    // The www. strip must be dot-anchored — it must not eat the code's www- prefix.
    expect(resolveMeetingCode("www-jjni-xtd")).toBe("www-jjni-xtd");
    expect(resolveMeetingCode("meet.google.com/www-jjni-xtd")).toBe("www-jjni-xtd");
  });
});
