import { describe, test, expect } from "vitest";
import { parseInviteContextFromUrl, parseInviteLink } from "./parseInviteLink.js";

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

describe("parseInviteContextFromUrl", () => {
  test("returns invite metadata from redirected OTT URL", () => {
    expect(
      parseInviteContextFromUrl(
        "https://www.youtube.com/watch?v=abc&wp_room=ABC123&wp_server=https%3A%2F%2Fdemo.ngrok-free.app&wp_platform=youtube"
      )
    ).toEqual({
      roomCode: "ABC123",
      serverUrl: "https://demo.ngrok-free.app",
      platform: "youtube",
    });
  });

  test("accepts missing platform", () => {
    expect(
      parseInviteContextFromUrl(
        "https://www.netflix.com/watch/123?wp_room=ROOM12&wp_server=https%3A%2F%2Fexample.com"
      )
    ).toEqual({
      roomCode: "ROOM12",
      serverUrl: "https://example.com",
      platform: "",
    });
  });

  test("normalizes room code casing and whitespace", () => {
    expect(
      parseInviteContextFromUrl(
        "https://www.primevideo.com/detail/xyz?wp_room=%20ab12cd%20&wp_server=https%3A%2F%2Flocalhost%3A3001"
      )
    ).toEqual({
      roomCode: "AB12CD",
      serverUrl: "https://localhost:3001",
      platform: "",
    });
  });

  test("returns null when required params are missing", () => {
    expect(parseInviteContextFromUrl("https://www.hotstar.com/in")).toBeNull();
  });

  test("returns null for unsupported platform values", () => {
    expect(
      parseInviteContextFromUrl(
        "https://www.youtube.com/watch?v=abc&wp_room=ABC123&wp_server=https%3A%2F%2Fexample.com&wp_platform=unknown"
      )
    ).toBeNull();
  });
});
