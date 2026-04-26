const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
  username: "username",
};

const ALARM_NAME = "keepAlive";
const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

let sessionState = {
  serverUrl: "",
  roomCode: "",
  inRoom: false,
  username: "",
  connectionState: "disconnected",
  reconnectAttempt: 0,
  memberCount: 0,
};

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"],
    justification: "Maintain persistent Socket.io connection for watch party sync",
  });
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed.
  }
}

function toOffscreen(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Offscreen not ready.
  });
}

function toPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup not open.
  });
}

function isSupportedPlatformUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname.includes("youtube.com") ||
      hostname.includes("netflix.com") ||
      hostname.includes("primevideo.com") ||
      hostname.includes("hotstar.com")
    );
  } catch {
    return false;
  }
}

function toSupportedTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab?.id || !isSupportedPlatformUrl(tab.url)) return;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

async function persistSession(updates) {
  Object.assign(sessionState, updates);
  await chrome.storage.local.set({
    [STORAGE_KEYS.serverUrl]: sessionState.serverUrl,
    [STORAGE_KEYS.roomCode]: sessionState.roomCode,
    [STORAGE_KEYS.inRoom]: sessionState.inRoom,
    [STORAGE_KEYS.username]: sessionState.username,
  });
}

async function restoreSessionState() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  sessionState.serverUrl = stored[STORAGE_KEYS.serverUrl] || "";
  sessionState.roomCode = stored[STORAGE_KEYS.roomCode] || "";
  sessionState.inRoom = Boolean(stored[STORAGE_KEYS.inRoom]);
  sessionState.username = stored[STORAGE_KEYS.username] || "";
}

async function restoreAlarmIfNeeded() {
  const { inRoom } = await chrome.storage.local.get([STORAGE_KEYS.inRoom]);
  if (!inRoom) return;
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // Keep-alive no-op.
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.serverUrl]: "",
    [STORAGE_KEYS.roomCode]: "",
    [STORAGE_KEYS.inRoom]: false,
    [STORAGE_KEYS.username]: "",
  });
});

restoreSessionState().then(restoreAlarmIfNeeded);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "POPUP_CONNECT") {
    persistSession({ serverUrl: message.serverUrl }).then(async () => {
      await ensureOffscreenDocument();
      toOffscreen({ type: "OFFSCREEN_CONNECT", serverUrl: message.serverUrl });
    });
    return;
  }

  if (message.type === "POPUP_GET_STATE") {
    sendResponse({ sessionState });
    return true;
  }

  if (message.type === "POPUP_EMIT") {
    toOffscreen({ type: "OFFSCREEN_EMIT", event: message.event, payload: message.payload });
    return;
  }

  if (message.type === "POPUP_JOINED_ROOM") {
    persistSession({
      roomCode: message.roomCode,
      inRoom: true,
      username: message.username,
    }).then(() => {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
      toSupportedTabs({ type: "ROOM_JOINED", username: message.username });
    });
    return;
  }

  if (message.type === "POPUP_LEFT_ROOM") {
    persistSession({ roomCode: "", inRoom: false }).then(() => {
      chrome.alarms.clear(ALARM_NAME);
      toSupportedTabs({ type: "ROOM_LEFT" });
    });
    return;
  }

  if (message.type === "POPUP_DISCONNECT") {
    persistSession({ serverUrl: "", roomCode: "", inRoom: false }).then(async () => {
      chrome.alarms.clear(ALARM_NAME);
      toOffscreen({ type: "OFFSCREEN_DISCONNECT" });
      await closeOffscreenDocument();
      toSupportedTabs({ type: "ROOM_LEFT" });
    });
    return;
  }

  if (message.type === "LOCAL_EVENT" && sender.tab) {
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "sync-event",
      payload: { roomCode: sessionState.roomCode, action: message.action },
    });
    return;
  }

  if (message.type === "AD_STARTED" && sender.tab) {
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "ad-started",
      payload: { roomCode: sessionState.roomCode },
    });
    return;
  }

  if (message.type === "AD_ENDED" && sender.tab) {
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "ad-ended",
      payload: { roomCode: sessionState.roomCode },
    });
    return;
  }

  if (message.type === "CHAT_SEND" && sender.tab) {
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "chat-message",
      payload: { roomCode: sessionState.roomCode, text: message.payload.text },
    });
    return;
  }

  if (message.type === "SOCKET_STATE") {
    sessionState.connectionState = message.state;
    if (message.attempt) sessionState.reconnectAttempt = message.attempt;

    if (message.state === "reconnected") {
      if (sessionState.inRoom && sessionState.roomCode) {
        toOffscreen({
          type: "OFFSCREEN_AUTO_REJOIN",
          roomCode: sessionState.roomCode,
          username: sessionState.username,
        });
      }
    }

    toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState } });
    return;
  }

  if (message.type === "SOCKET_EVENT") {
    const { event, payload } = message;

    if (event === "member-update") {
      sessionState.memberCount = payload.memberCount;
    }

    if (event === "sync-event") {
      toSupportedTabs({ type: "APPLY_SYNC", action: payload.action });
    }

    if (event === "ad-started") {
      toSupportedTabs({ type: "AD_STARTED_REMOTE", username: payload.username });
      toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState }, socketEvent: { event, payload } });
      return;
    }

    if (event === "ad-ended") {
      toSupportedTabs({ type: "AD_ENDED_REMOTE" });
      toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState }, socketEvent: { event, payload } });
      return;
    }

    if (event === "chat-message") {
      toSupportedTabs({ type: "INCOMING_CHAT", payload });
    }

    toPopup({
      type: "STATE_UPDATE",
      sessionState: { ...sessionState },
      socketEvent: { event, payload },
    });
    return;
  }
});
