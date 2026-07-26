import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Helpers ─────────────────────────────────────────────────────────────────────

function makeChrome({ inRoom = false, username = "", platform = "" } = {}) {
  const shouldMountChat = Boolean(inRoom && username && platform === "generic:localhost");
  return {
    runtime: {
      sendMessage: vi.fn((message, callback) => {
        if (typeof callback !== "function") return;
        if (message?.type === "CONTENT_GET_SESSION") {
          callback({
            inRoom,
            username,
            roomCode: "ABC123",
            platform,
            tabPlatform: "generic:localhost",
            shouldMountChat,
          });
          return;
        }
        callback({});
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

function makeWatchPartyChat() {
  return {
    mountChatOverlay: vi.fn(),
    unmountChatOverlay: vi.fn(),
    receiveMessage: vi.fn(),
  };
}

function makeVideo({ width = 640, height = 360, currentTime = 0, paused = true, duration = 120 } = {}) {
  const video = document.createElement("video");
  video.getBoundingClientRect = () => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
  });
  Object.defineProperty(video, "currentTime", { value: currentTime, writable: true });
  Object.defineProperty(video, "paused", { value: paused, writable: true });
  Object.defineProperty(video, "duration", { value: duration, writable: true });
  video.play = vi.fn(() => Promise.resolve());
  video.pause = vi.fn();
  document.body.appendChild(video);
  return video;
}

async function loadGeneric() {
  vi.resetModules();
  return import("./generic.js");
}

function localEventCalls() {
  return global.chrome.runtime.sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.type === "LOCAL_EVENT");
}

// Setup / teardown ────────────────────────────────────────────────────────────

let chat;

beforeEach(() => {
  chat = makeWatchPartyChat();
  window.WatchPartyChat = chat;
  document.body.innerHTML = "";
});

afterEach(() => {
  window.__watchPartyGeneric?.teardown();
  vi.resetModules();
  vi.restoreAllMocks();
  delete window.WatchPartyChat;
  delete global.chrome;
});

// ─── Primary video selection ─────────────────────────────────────────────────

describe("primary video selection", () => {
  test("syncs the largest player and ignores a small decoy", async () => {
    const decoy = makeVideo({ width: 160, height: 90, currentTime: 3 });
    const hero = makeVideo({ width: 1280, height: 720, currentTime: 42 });
    global.chrome = makeChrome();
    await loadGeneric();

    decoy.dispatchEvent(new Event("play"));
    hero.dispatchEvent(new Event("play"));

    expect(localEventCalls()).toEqual([
      { type: "LOCAL_EVENT", action: { type: "play", currentTime: 42 } },
    ]);
  });

  test("prefers an already-playing video over a larger idle one", async () => {
    makeVideo({ width: 1280, height: 720, currentTime: 1, paused: true });
    const playing = makeVideo({ width: 900, height: 500, currentTime: 77, paused: false });
    global.chrome = makeChrome();
    await loadGeneric();

    playing.dispatchEvent(new Event("seeked"));

    expect(localEventCalls()).toEqual([
      { type: "LOCAL_EVENT", action: { type: "seek", currentTime: 77 } },
    ]);
  });

  test("falls back to the only video when the player has no layout yet", async () => {
    const video = makeVideo({ width: 0, height: 0, currentTime: 9 });
    global.chrome = makeChrome();
    await loadGeneric();

    video.dispatchEvent(new Event("pause"));

    expect(localEventCalls()).toEqual([
      { type: "LOCAL_EVENT", action: { type: "pause", currentTime: 9 } },
    ]);
  });

  test("switches to a newly playing player that outranks the current one", async () => {
    makeVideo({ width: 320, height: 180, currentTime: 2 });
    global.chrome = makeChrome();
    await loadGeneric();

    const replacement = makeVideo({ width: 1280, height: 720, currentTime: 55, paused: false });
    replacement.dispatchEvent(new Event("play"));

    expect(localEventCalls()).toContainEqual({
      type: "LOCAL_EVENT",
      action: { type: "play", currentTime: 55 },
    });
  });
});

// ─── Platform identity ───────────────────────────────────────────────────────

describe("platform identity", () => {
  test("reports the watch URL under a hostname-scoped generic platform", async () => {
    makeVideo();
    global.chrome = makeChrome();
    await loadGeneric();

    const watchUrlMessage = global.chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.type === "WATCH_URL_CHANGED");

    expect(watchUrlMessage?.platform).toBe(`generic:${location.hostname}`);
  });
});

// ─── Remote sync ─────────────────────────────────────────────────────────────

describe("APPLY_SYNC", () => {
  async function loadAndGetListener() {
    global.chrome = makeChrome();
    await loadGeneric();
    return global.chrome.runtime.onMessage.addListener.mock.calls[0][0];
  }

  test("pauses the primary video without echoing a local event", async () => {
    const video = makeVideo({ currentTime: 30 });
    const listener = await loadAndGetListener();

    listener({ type: "APPLY_SYNC", action: { type: "pause", currentTime: 30 } });
    video.dispatchEvent(new Event("pause"));

    expect(video.pause).toHaveBeenCalledOnce();
    expect(localEventCalls()).toEqual([]);
  });

  test("seeks the primary video to the remote position", async () => {
    const video = makeVideo({ currentTime: 10 });
    const listener = await loadAndGetListener();

    listener({ type: "APPLY_SYNC", action: { type: "seek", currentTime: 120 } });

    expect(video.currentTime).toBe(120);
  });

  test("is a no-op when the page has no video", async () => {
    const listener = await loadAndGetListener();

    expect(() => listener({ type: "APPLY_SYNC", action: { type: "play", currentTime: 5 } })).not.toThrow();
    expect(localEventCalls()).toEqual([]);
  });
});

// ─── Chat overlay ────────────────────────────────────────────────────────────

describe("chat overlay", () => {
  test("mounts on load when the session is already in a room on this site", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "alice", platform: "generic:localhost" });
    await loadGeneric();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chat.mountChatOverlay).toHaveBeenCalledWith("alice");
  });

  test("does not mount when the room is locked to another site", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "alice", platform: "generic:other.test" });
    await loadGeneric();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });

  test("ROOM_LEFT unmounts the overlay", async () => {
    global.chrome = makeChrome();
    await loadGeneric();
    const listener = global.chrome.runtime.onMessage.addListener.mock.calls[0][0];

    listener({ type: "ROOM_LEFT" });

    expect(chat.unmountChatOverlay).toHaveBeenCalledOnce();
  });
});

// ─── Re-injection guard ──────────────────────────────────────────────────────

describe("re-injection", () => {
  test("a second run replaces the first instead of stacking listeners", async () => {
    const video = makeVideo({ currentTime: 15 });
    global.chrome = makeChrome();
    await loadGeneric();
    await loadGeneric();

    video.dispatchEvent(new Event("play"));

    expect(localEventCalls()).toEqual([
      { type: "LOCAL_EVENT", action: { type: "play", currentTime: 15 } },
    ]);
  });

  test("the replaced instance stops receiving runtime messages", async () => {
    makeVideo({ currentTime: 15 });
    global.chrome = makeChrome();
    await loadGeneric();
    const staleListener = global.chrome.runtime.onMessage.addListener.mock.calls[0][0];

    await loadGeneric();

    expect(global.chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(staleListener);
  });

  test("history patching is restored on teardown", async () => {
    const original = history.pushState;
    global.chrome = makeChrome();
    await loadGeneric();

    expect(history.pushState).not.toBe(original);
    window.__watchPartyGeneric.teardown();

    expect(history.pushState).toBe(original);
  });
});
