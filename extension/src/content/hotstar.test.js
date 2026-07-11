import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Helpers ─────────────────────────────────────────────────────────────────────

function makeChrome({ inRoom = false, username = "", platform = "" } = {}) {
  const shouldMountChat = Boolean(inRoom && username && platform === "hotstar");
  return {
    storage: { local: { get: vi.fn((_keys, cb) => cb({ inRoom, username, platform })) } },
    runtime: {
      sendMessage: vi.fn((message, callback) => {
        if (typeof callback !== "function") return;
        if (message?.type === "CONTENT_GET_SESSION") {
          callback({
            inRoom,
            username,
            roomCode: "ABC123",
            platform,
            tabPlatform: "hotstar",
            shouldMountChat,
          });
          return;
        }
        callback({});
      }),
      onMessage: {
        addListener: vi.fn(),
      },
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

async function loadHotstar() {
  vi.resetModules();
  return import("./hotstar.js");
}

// Setup / teardown ────────────────────────────────────────────────────────────

let chat;

beforeEach(() => {
  chat = makeWatchPartyChat();
  window.WatchPartyChat = chat;
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  delete window.WatchPartyChat;
  delete global.chrome;
});

// ─── Init-time session check (the refresh fix) ───────────────────────────────

describe("init — session check on page load", () => {
  test("mounts overlay when inRoom:true, username present, platform:hotstar", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "alice", platform: "hotstar" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).toHaveBeenCalledOnce();
    expect(chat.mountChatOverlay).toHaveBeenCalledWith("alice");
  });

  test("does not mount overlay when inRoom:false", async () => {
    global.chrome = makeChrome({ inRoom: false, username: "alice", platform: "hotstar" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });

  test("does not mount overlay when username is empty", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "", platform: "hotstar" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });

  test("does not mount overlay when platform does not match (cross-platform guard)", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "alice", platform: "youtube" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });

  test("does not mount overlay when session check returns nothing", async () => {
    global.chrome = {
      storage: { local: { get: vi.fn((_k, cb) => cb({})) } },
      runtime: {
        sendMessage: vi.fn((_message, callback) => {
          if (typeof callback === "function") callback({});
        }),
        onMessage: { addListener: vi.fn() },
      },
    };
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });
});

// ─── ROOM_JOINED / ROOM_LEFT messages ────────────────────────────────────────

describe("runtime messages", () => {
  async function loadAndGetListener() {
    global.chrome = makeChrome();
    await loadHotstar();
    expect(global.chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
    return global.chrome.runtime.onMessage.addListener.mock.calls[0][0];
  }

  test("ROOM_JOINED calls mountChatOverlay with message username", async () => {
    const listener = await loadAndGetListener();
    listener({ type: "ROOM_JOINED", username: "bob" });
    expect(chat.mountChatOverlay).toHaveBeenCalledWith("bob");
  });

  test("ROOM_LEFT calls unmountChatOverlay", async () => {
    const listener = await loadAndGetListener();
    listener({ type: "ROOM_LEFT" });
    expect(chat.unmountChatOverlay).toHaveBeenCalledOnce();
  });

  test("INCOMING_CHAT calls receiveMessage with payload", async () => {
    const listener = await loadAndGetListener();
    const payload = { username: "carol", text: "hi", timestamp: 1000 };
    listener({ type: "INCOMING_CHAT", payload });
    expect(chat.receiveMessage).toHaveBeenCalledWith(payload);
  });

  test("APPLY_SYNC is a no-op without video while INCOMING_CHAT still works", async () => {
    const listener = await loadAndGetListener();
    const chatPayload = { username: "carol", text: "still here", timestamp: 2000 };
    chat.mountChatOverlay.mockClear();
    chat.unmountChatOverlay.mockClear();
    chat.receiveMessage.mockClear();
    global.chrome.runtime.sendMessage.mockClear();

    listener({ type: "APPLY_SYNC", action: { type: "play", currentTime: 12 } });
    listener({ type: "INCOMING_CHAT", payload: chatPayload });

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
    expect(chat.unmountChatOverlay).not.toHaveBeenCalled();
    expect(chat.receiveMessage).toHaveBeenCalledWith(chatPayload);
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "LOCAL_EVENT" })
    );
  });
});

// ─── onNavigate session restoration ──────────────────────────────────────────

describe("onNavigate — SPA navigation restores overlay", () => {
  test("mounts overlay after pushState when inRoom:true and platform matches", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "dave", platform: "hotstar" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));
    chat.mountChatOverlay.mockClear();

    history.pushState({}, "", "/new-path-" + Date.now());
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).toHaveBeenCalledWith("dave");
  });

  test("does not mount overlay after pushState when platform does not match", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "dave", platform: "netflix" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));
    chat.mountChatOverlay.mockClear();

    history.pushState({}, "", "/new-path-" + Date.now());
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });

  test("does not mount overlay after pushState when inRoom:false", async () => {
    global.chrome = makeChrome({ inRoom: false, username: "dave", platform: "hotstar" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));
    chat.mountChatOverlay.mockClear();

    history.pushState({}, "", "/other-path-" + Date.now());
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });

  test("ignores pushState when URL does not change", async () => {
    global.chrome = makeChrome({ inRoom: true, username: "eve", platform: "hotstar" });
    await loadHotstar();
    await new Promise((r) => setTimeout(r, 0));
    chat.mountChatOverlay.mockClear();

    history.pushState({}, "", location.href);
    await new Promise((r) => setTimeout(r, 0));

    expect(chat.mountChatOverlay).not.toHaveBeenCalled();
  });
});
