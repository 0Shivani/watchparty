import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

async function loadChatOverlay() {
  vi.resetModules();
  await import("./chat-overlay.js");
  return window.WatchPartyChat;
}

beforeEach(() => {
  document.body.innerHTML = "";
  global.chrome = {
    runtime: {
      sendMessage: vi.fn(),
    },
  };
});

afterEach(() => {
  if (window.WatchPartyChat?.unmountChatOverlay) {
    window.WatchPartyChat.unmountChatOverlay();
  }
  delete window.WatchPartyChat;
  delete global.chrome;
  vi.restoreAllMocks();
});

describe("chat overlay keyboard shielding", () => {
  test("blocks host playback shortcuts while chat input is focused", async () => {
    const chat = await loadChatOverlay();
    chat.mountChatOverlay("alice");

    const input = document.getElementById("wp-chat-input");
    expect(input).toBeTruthy();
    input.focus();

    const hostBubbleKeydown = vi.fn();
    const hostBubbleKeypress = vi.fn();
    const hostBubbleKeyup = vi.fn();
    const hostCaptureKeydown = vi.fn();
    document.addEventListener("keydown", hostBubbleKeydown);
    document.addEventListener("keypress", hostBubbleKeypress);
    document.addEventListener("keyup", hostBubbleKeyup);
    document.addEventListener("keydown", hostCaptureKeydown, true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "m", bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "m", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));

    expect(hostBubbleKeydown).not.toHaveBeenCalled();
    expect(hostBubbleKeypress).not.toHaveBeenCalled();
    expect(hostBubbleKeyup).not.toHaveBeenCalled();
    expect(hostCaptureKeydown).not.toHaveBeenCalled();

    document.removeEventListener("keydown", hostBubbleKeydown);
    document.removeEventListener("keypress", hostBubbleKeypress);
    document.removeEventListener("keyup", hostBubbleKeyup);
    document.removeEventListener("keydown", hostCaptureKeydown, true);
  });

  test("pressing enter sends chat message without leaking key handling", async () => {
    const chat = await loadChatOverlay();
    chat.mountChatOverlay("alice");

    const input = document.getElementById("wp-chat-input");
    expect(input).toBeTruthy();
    input.focus();
    input.value = "hello room";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CHAT_SEND",
      payload: { text: "hello room" },
    });
    expect(input.value).toBe("");
  });

  test("removes keyboard shielding listeners on unmount", async () => {
    const chat = await loadChatOverlay();
    chat.mountChatOverlay("alice");
    chat.unmountChatOverlay();

    const hostCaptureKeydown = vi.fn();
    const hostBubbleKeydown = vi.fn();
    document.addEventListener("keydown", hostCaptureKeydown, true);
    document.addEventListener("keydown", hostBubbleKeydown);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true }));

    expect(hostCaptureKeydown).toHaveBeenCalledTimes(1);
    expect(hostBubbleKeydown).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", hostCaptureKeydown, true);
    document.removeEventListener("keydown", hostBubbleKeydown);
  });
});
