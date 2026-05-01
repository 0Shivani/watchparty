import { describe, test, expect } from "vitest";
import { parseInviteLink } from "./parseInviteLink.js";

describe("parseInviteLink", () => {
  test("valid https link returns serverUrl and uppercased roomCode", () => {
    expect(parseInviteLink("https://example.com?room=ABC123")).toEqual({
      serverUrl: "https://example.com",
      roomCode: "ABC123",
    });
  });

  test("valid http link is accepted", () => {
    expect(parseInviteLink("http://localhost:3000?room=TEST")).toEqual({
      serverUrl: "http://localhost:3000",
      roomCode: "TEST",
    });
  });

  test("ngrok-style invite URL works", () => {
    expect(parseInviteLink("https://abc123.ngrok-free.app?room=XYZ789")).toEqual({
      serverUrl: "https://abc123.ngrok-free.app",
      roomCode: "XYZ789",
    });
  });

  test("lowercase room code is uppercased", () => {
    expect(parseInviteLink("https://example.com?room=abc123")).toEqual({
      serverUrl: "https://example.com",
      roomCode: "ABC123",
    });
  });

  test("mixed-case room code is fully uppercased", () => {
    expect(parseInviteLink("https://example.com?room=abCDef")).toEqual({
      serverUrl: "https://example.com",
      roomCode: "ABCDEF",
    });
  });

  test("leading and trailing whitespace on input is trimmed", () => {
    expect(parseInviteLink("  https://example.com?room=ABC  ")).toEqual({
      serverUrl: "https://example.com",
      roomCode: "ABC",
    });
  });

  test("room code with surrounding whitespace (URL-encoded) is trimmed", () => {
    expect(parseInviteLink("https://example.com?room=%20ABC%20")).toEqual({
      serverUrl: "https://example.com",
      roomCode: "ABC",
    });
  });

  test("missing room param returns null", () => {
    expect(parseInviteLink("https://example.com")).toBeNull();
  });

  test("URL with other query params but no room returns null", () => {
    expect(parseInviteLink("https://example.com?session=123&user=foo")).toBeNull();
  });

  test("path-only URL without room param returns null", () => {
    expect(parseInviteLink("https://example.com/join")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseInviteLink("")).toBeNull();
  });

  test("plain room code without protocol returns null", () => {
    expect(parseInviteLink("example.com?room=ABC")).toBeNull();
  });

  test("ftp protocol returns null", () => {
    expect(parseInviteLink("ftp://example.com?room=ABC")).toBeNull();
  });

  test("malformed URL returns null", () => {
    expect(parseInviteLink("https://")).toBeNull();
  });

  test("whitespace-only string returns null", () => {
    expect(parseInviteLink("   ")).toBeNull();
  });
});
