import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const BRIDGE_COMMAND_SOURCE = "wp-netflix";
const BRIDGE_ACK_SOURCE = "wp-netflix-bridge";

// Helpers ─────────────────────────────────────────────────────────────────────

function makeChrome() {
  return {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://picnic/${path}`),
      sendMessage: vi.fn((message, callback) => {
        if (typeof callback === "function") callback({});
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

function makeVideo({ currentTime = 0 } = {}) {
  const container = document.createElement("div");
  container.className = "VideoContainer";
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: currentTime, writable: true });
  video.play = vi.fn(() => Promise.resolve());
  video.pause = vi.fn();
  container.appendChild(video);
  document.body.appendChild(container);
  return video;
}

async function loadNetflix() {
  vi.resetModules();
  await import("./netflix.js");
  return global.chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0];
}

function bridgeCommands() {
  return window.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.source === BRIDGE_COMMAND_SOURCE);
}

function localEventCalls() {
  return global.chrome.runtime.sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.type === "LOCAL_EVENT");
}

// Stands in for the page-world bridge by acking every command it receives.
function ackBridgeCommands(ok = true) {
  bridgeCommands().forEach(({ requestId }) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: BRIDGE_ACK_SOURCE, requestId, ok },
        source: window,
      })
    );
  });
}

// Setup / teardown ────────────────────────────────────────────────────────────

let originalPushState;
let originalReplaceState;

beforeEach(() => {
  vi.useFakeTimers();
  originalPushState = history.pushState;
  originalReplaceState = history.replaceState;
  // The content script has no teardown, so swap in a fresh body to orphan the
  // MutationObservers left behind by modules loaded in earlier tests.
  document.body = document.createElement("body");
  document.head.innerHTML = "";
  window.WatchPartyChat = {
    mountChatOverlay: vi.fn(),
    unmountChatOverlay: vi.fn(),
    receiveMessage: vi.fn(),
  };
  vi.spyOn(window, "postMessage").mockImplementation(() => {});
  global.chrome = makeChrome();
});

afterEach(() => {
  history.pushState = originalPushState;
  history.replaceState = originalReplaceState;
  vi.useRealTimers();
  vi.resetModules();
  vi.restoreAllMocks();
  delete window.WatchPartyChat;
  delete global.chrome;
});

// ─── Player bridge ───────────────────────────────────────────────────────────

describe("player bridge", () => {
  test("injects the page-world bridge from a web-accessible URL", async () => {
    makeVideo();
    await loadNetflix();

    const script = document.querySelector("script");
    expect(script?.src).toBe("chrome-extension://picnic/dynamic/netflix-player-bridge.js");
  });

  test("a remote seek goes through the bridge and never writes currentTime", async () => {
    const video = makeVideo({ currentTime: 10 });
    const listener = await loadNetflix();

    listener({ type: "APPLY_SYNC", action: { type: "seek", currentTime: 120 } });

    expect(video.currentTime).toBe(10);
    expect(bridgeCommands()).toContainEqual(
      expect.objectContaining({ command: "seek", timeMs: 120000 })
    );
  });

  test("a seek is dropped rather than applied to the element when the bridge is unreachable", async () => {
    const video = makeVideo({ currentTime: 10 });
    const listener = await loadNetflix();

    listener({ type: "APPLY_SYNC", action: { type: "seek", currentTime: 120 } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.currentTime).toBe(10);
  });

  test("play and pause fall back to the element when the bridge cannot reach a player", async () => {
    const video = makeVideo({ currentTime: 10 });
    const listener = await loadNetflix();

    listener({ type: "APPLY_SYNC", action: { type: "pause", currentTime: 10 } });
    ackBridgeCommands(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(video.pause).toHaveBeenCalledOnce();
  });

  test("no element fallback runs once the bridge acks the command", async () => {
    const video = makeVideo({ currentTime: 10 });
    const listener = await loadNetflix();

    listener({ type: "APPLY_SYNC", action: { type: "play", currentTime: 10 } });
    ackBridgeCommands(true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.play).not.toHaveBeenCalled();
  });
});

// ─── Echo suppression ────────────────────────────────────────────────────────

describe("echo suppression", () => {
  test("a remotely applied pause does not echo back as a local event", async () => {
    const video = makeVideo({ currentTime: 30 });
    const listener = await loadNetflix();

    listener({ type: "APPLY_SYNC", action: { type: "pause", currentTime: 30 } });
    video.dispatchEvent(new Event("pause"));

    expect(localEventCalls()).toEqual([]);
  });

  test("a short pause window does not unmask a seek that is still in flight", async () => {
    const video = makeVideo({ currentTime: 5 });
    const listener = await loadNetflix();

    // Drift beyond tolerance, so this pause carries a seek correction too.
    listener({ type: "APPLY_SYNC", action: { type: "pause", currentTime: 300 } });
    await vi.advanceTimersByTimeAsync(500);
    video.dispatchEvent(new Event("seeked"));

    expect(localEventCalls()).toEqual([]);
  });

  test("local events resume once the suppression window expires", async () => {
    const video = makeVideo({ currentTime: 30 });
    const listener = await loadNetflix();

    listener({ type: "APPLY_SYNC", action: { type: "pause", currentTime: 30 } });
    await vi.advanceTimersByTimeAsync(1500);
    video.dispatchEvent(new Event("pause"));

    expect(localEventCalls()).toEqual([
      { type: "LOCAL_EVENT", action: { type: "pause", currentTime: 30 } },
    ]);
  });
});

// ─── Navigation hardening ────────────────────────────────────────────────────

describe("navigation hardening", () => {
  test("a failing navigation handler does not throw into the host page's router", async () => {
    makeVideo();
    await loadNetflix();

    global.chrome.runtime.sendMessage.mockImplementation(() => {
      throw new Error("Extension context invalidated");
    });

    expect(() => history.pushState({}, "", "/watch/12345")).not.toThrow();
  });
});
