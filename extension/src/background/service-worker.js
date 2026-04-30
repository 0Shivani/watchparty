const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
  username: "username",
  platform: "platform",
};

const ALARM_NAME = "keepAlive";
const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

let sessionState = {
  serverUrl: "",
  roomCode: "",
  inRoom: false,
  username: "",
  platform: "",
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
  return Boolean(getPlatformFromUrl(url));
}

function getPlatformFromUrl(url) {
  if (!url) return "";
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("youtube.com")) return "youtube";
    if (hostname.includes("netflix.com")) return "netflix";
    if (hostname.includes("primevideo.com")) return "primevideo";
    if (hostname.includes("hotstar.com")) return "hotstar";
    return "";
  } catch {
    return "";
  }
}

function toSupportedTabs(message, platform = "") {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab?.id) return;
      const tabPlatform = getPlatformFromUrl(tab.url);
      if (!tabPlatform) return;
      if (platform && tabPlatform !== platform) return;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

async function getCurrentPlatformFromTabs() {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activePlatform = getPlatformFromUrl(activeTabs[0]?.url);
  if (activePlatform) return activePlatform;

  const allTabs = await chrome.tabs.query({});
  const firstSupported = allTabs.find((tab) => getPlatformFromUrl(tab?.url));
  return getPlatformFromUrl(firstSupported?.url) || "";
}

async function persistSession(updates) {
  Object.assign(sessionState, updates);
  await chrome.storage.local.set({
    [STORAGE_KEYS.serverUrl]: sessionState.serverUrl,
    [STORAGE_KEYS.roomCode]: sessionState.roomCode,
    [STORAGE_KEYS.inRoom]: sessionState.inRoom,
    [STORAGE_KEYS.username]: sessionState.username,
    [STORAGE_KEYS.platform]: sessionState.platform,
  });
}

async function restoreSessionState() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  sessionState.serverUrl = stored[STORAGE_KEYS.serverUrl] || "";
  sessionState.roomCode = stored[STORAGE_KEYS.roomCode] || "";
  sessionState.inRoom = Boolean(stored[STORAGE_KEYS.inRoom]);
  sessionState.username = stored[STORAGE_KEYS.username] || "";
  sessionState.platform = stored[STORAGE_KEYS.platform] || "";
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
    [STORAGE_KEYS.platform]: "",
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
    if (message.event === "create-room" || message.event === "join-room") {
      getCurrentPlatformFromTabs()
        .then((platform) => {
          const payload = { ...(message.payload || {}) };
          if (platform) payload.platform = platform;
          toOffscreen({ type: "OFFSCREEN_EMIT", event: message.event, payload });
        })
        .catch(() => {
          toOffscreen({ type: "OFFSCREEN_EMIT", event: message.event, payload: message.payload });
        });
      return;
    }

    toOffscreen({ type: "OFFSCREEN_EMIT", event: message.event, payload: message.payload });
    return;
  }

  if (message.type === "POPUP_JOINED_ROOM") {
    persistSession({
      roomCode: message.roomCode,
      inRoom: true,
      username: message.username,
      platform: message.platform || sessionState.platform || "",
    }).then(() => {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
      toSupportedTabs(
        { type: "ROOM_JOINED", username: message.username },
        message.platform || sessionState.platform || ""
      );
    });
    return;
  }

  if (message.type === "POPUP_LEFT_ROOM") {
    persistSession({ roomCode: "", inRoom: false, platform: "" }).then(() => {
      chrome.alarms.clear(ALARM_NAME);
      toSupportedTabs({ type: "ROOM_LEFT" });
    });
    return;
  }

  if (message.type === "POPUP_DISCONNECT") {
    persistSession({ serverUrl: "", roomCode: "", inRoom: false, platform: "" }).then(async () => {
      chrome.alarms.clear(ALARM_NAME);
      toOffscreen({ type: "OFFSCREEN_DISCONNECT" });
      await closeOffscreenDocument();
      toSupportedTabs({ type: "ROOM_LEFT" });
    });
    return;
  }

  if (message.type === "LOCAL_EVENT" && sender.tab) {
    const platform = getPlatformFromUrl(sender.tab.url);
    if (!platform) return;
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "sync-event",
      payload: { roomCode: sessionState.roomCode, action: message.action, platform },
    });
    return;
  }

  if (message.type === "AD_STARTED" && sender.tab) {
    const platform = getPlatformFromUrl(sender.tab.url);
    if (!platform) return;
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "ad-started",
      payload: { roomCode: sessionState.roomCode, platform },
    });
    return;
  }

  if (message.type === "AD_ENDED" && sender.tab) {
    const platform = getPlatformFromUrl(sender.tab.url);
    if (!platform) return;
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "ad-ended",
      payload: { roomCode: sessionState.roomCode, platform },
    });
    return;
  }

  if (message.type === "CHAT_SEND" && sender.tab) {
    const platform = getPlatformFromUrl(sender.tab.url);
    if (!platform) return;
    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "chat-message",
      payload: { roomCode: sessionState.roomCode, text: message.payload.text, platform },
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
          platform: sessionState.platform || "",
        });
      }
    }

    toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState } });
    return;
  }

  if (message.type === "SOCKET_EVENT") {
    const { event, payload } = message;

    if (event === "room-created" || event === "room-joined") {
      if (payload?.platform) {
        sessionState.platform = payload.platform;
      }
    }

    if (event === "member-update") {
      sessionState.memberCount = payload.memberCount;
    }

    if (event === "sync-event") {
      toSupportedTabs(
        { type: "APPLY_SYNC", action: payload.action },
        payload?.platform || sessionState.platform || ""
      );
    }

    if (event === "ad-started") {
      toSupportedTabs(
        { type: "AD_STARTED_REMOTE", username: payload.username },
        payload?.platform || sessionState.platform || ""
      );
      toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState }, socketEvent: { event, payload } });
      return;
    }

    if (event === "ad-ended") {
      toSupportedTabs(
        { type: "AD_ENDED_REMOTE" },
        payload?.platform || sessionState.platform || ""
      );
      toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState }, socketEvent: { event, payload } });
      return;
    }

    if (event === "chat-message") {
      toSupportedTabs(
        { type: "INCOMING_CHAT", payload },
        payload?.platform || sessionState.platform || ""
      );
    }

    toPopup({
      type: "STATE_UPDATE",
      sessionState: { ...sessionState },
      socketEvent: { event, payload },
    });
    return;
  }
});
