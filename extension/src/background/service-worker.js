const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
  username: "username",
  platform: "platform",
  watchUrl: "watchUrl",
};

const ALARM_NAME = "keepAlive";
const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

let sessionState = {
  serverUrl: "",
  roomCode: "",
  inRoom: false,
  username: "",
  platform: "",
  watchUrl: "",
  connectionState: "disconnected",
  reconnectAttempt: 0,
  memberCount: 0,
};
let pendingAutoJoin = null;
let lastHandledInviteKey = "";
let ackRequestCounter = 0;
const pendingAckRequests = new Map();

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

function normalizeServerUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function normalizeRoomCode(raw) {
  return String(raw || "").toUpperCase().trim();
}

function normalizeWatchUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.searchParams.delete("wp_room");
    parsed.searchParams.delete("wp_server");
    parsed.searchParams.delete("wp_platform");
    return parsed.toString();
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
    [STORAGE_KEYS.watchUrl]: sessionState.watchUrl,
  });
}

async function restoreSessionState() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  sessionState.serverUrl = stored[STORAGE_KEYS.serverUrl] || "";
  sessionState.roomCode = stored[STORAGE_KEYS.roomCode] || "";
  sessionState.inRoom = Boolean(stored[STORAGE_KEYS.inRoom]);
  sessionState.username = stored[STORAGE_KEYS.username] || "";
  sessionState.platform = stored[STORAGE_KEYS.platform] || "";
  sessionState.watchUrl = stored[STORAGE_KEYS.watchUrl] || "";
}

async function restoreAlarmIfNeeded() {
  const { inRoom } = await chrome.storage.local.get([STORAGE_KEYS.inRoom]);
  if (!inRoom) return;
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
  }
}

function resolvePendingAck(requestId, response) {
  const pending = pendingAckRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingAckRequests.delete(requestId);
  pending.resolve(response || { ok: false, message: "No response from server." });
}

function emitWithAck(event, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const requestId = `ack_${Date.now()}_${ackRequestCounter++}`;
    const timeoutId = setTimeout(() => {
      pendingAckRequests.delete(requestId);
      resolve({ ok: false, message: "Request timed out." });
    }, timeoutMs);

    pendingAckRequests.set(requestId, { resolve, timeoutId });
    toOffscreen({
      type: "OFFSCREEN_EMIT_WITH_ACK",
      event,
      payload,
      requestId,
    });
  });
}

async function getWatchUrlFromTabs(targetPlatform = "") {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs[0];
  const activePlatform = getPlatformFromUrl(activeTab?.url);
  if ((!targetPlatform || activePlatform === targetPlatform) && activeTab?.url) {
    const normalized = normalizeWatchUrl(activeTab.url);
    if (normalized) return normalized;
  }

  const allTabs = await chrome.tabs.query({});
  const match = allTabs.find((tab) => {
    const platform = getPlatformFromUrl(tab?.url);
    if (!platform) return false;
    if (targetPlatform && platform !== targetPlatform) return false;
    return true;
  });
  return normalizeWatchUrl(match?.url);
}

function triggerPendingAutoJoin() {
  if (!pendingAutoJoin) return;
  toOffscreen({
    type: "OFFSCREEN_AUTO_REJOIN",
    roomCode: pendingAutoJoin.roomCode,
    username: pendingAutoJoin.username,
    platform: pendingAutoJoin.platform,
  });
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
    [STORAGE_KEYS.watchUrl]: "",
  });
});

restoreSessionState().then(restoreAlarmIfNeeded);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "POPUP_CONNECT") {
    const serverUrl = normalizeServerUrl(message.serverUrl);
    if (!serverUrl) return;
    persistSession({ serverUrl }).then(async () => {
      await ensureOffscreenDocument();
      toOffscreen({ type: "OFFSCREEN_CONNECT", serverUrl });
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

  if (message.type === "POPUP_CREATE_INVITE") {
    (async () => {
      if (!sessionState.serverUrl || !sessionState.roomCode) {
        sendResponse({ ok: false, message: "Join a room before creating an invite link." });
        return;
      }

      await ensureOffscreenDocument();
      toOffscreen({ type: "OFFSCREEN_CONNECT", serverUrl: sessionState.serverUrl });

      const platform = sessionState.platform || (await getCurrentPlatformFromTabs()) || "";
      const watchUrl =
        normalizeWatchUrl(sessionState.watchUrl) || (await getWatchUrlFromTabs(platform || ""));

      if (!watchUrl) {
        sendResponse({ ok: false, message: "Could not detect a valid watch URL from open tabs." });
        return;
      }

      const watchAck = await emitWithAck("set-room-watch-target", {
        roomCode: sessionState.roomCode,
        watchUrl,
        platform,
      });
      if (!watchAck?.ok) {
        sendResponse({ ok: false, message: watchAck?.message || "Failed to set watch target." });
        return;
      }

      const inviteAck = await emitWithAck("create-invite", {
        roomCode: sessionState.roomCode,
        watchUrl,
        platform,
        serverUrl: sessionState.serverUrl,
      });
      if (!inviteAck?.ok || !inviteAck?.invitePath) {
        sendResponse({ ok: false, message: inviteAck?.message || "Failed to create invite link." });
        return;
      }

      await persistSession({ watchUrl });
      sendResponse({
        ok: true,
        inviteUrl: `${sessionState.serverUrl}${inviteAck.invitePath}`,
        expiresAt: inviteAck.expiresAt || null,
      });
    })();
    return true;
  }

  if (message.type === "POPUP_JOINED_ROOM") {
    persistSession({
      roomCode: message.roomCode,
      inRoom: true,
      username: message.username,
      platform: message.platform || sessionState.platform || "",
      watchUrl: sessionState.watchUrl || "",
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
    pendingAutoJoin = null;
    persistSession({ roomCode: "", inRoom: false, platform: "", watchUrl: "" }).then(() => {
      chrome.alarms.clear(ALARM_NAME);
      toSupportedTabs({ type: "ROOM_LEFT" });
    });
    return;
  }

  if (message.type === "POPUP_DISCONNECT") {
    pendingAutoJoin = null;
    persistSession({ serverUrl: "", roomCode: "", inRoom: false, platform: "", watchUrl: "" }).then(async () => {
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

  if (message.type === "WATCH_URL_CHANGED" && sender.tab) {
    const tabPlatform = getPlatformFromUrl(sender.tab.url);
    const platform = message.platform || tabPlatform;
    const watchUrl = normalizeWatchUrl(message.watchUrl || sender.tab.url || "");
    if (!watchUrl) return;

    if (sessionState.watchUrl !== watchUrl) {
      persistSession({ watchUrl });
    }

    if (!sessionState.inRoom || !sessionState.roomCode) return;
    if (platform && sessionState.platform && platform !== sessionState.platform) return;

    toOffscreen({
      type: "OFFSCREEN_EMIT",
      event: "set-room-watch-target",
      payload: {
        roomCode: sessionState.roomCode,
        watchUrl,
        platform: sessionState.platform || platform || "",
      },
    });
    return;
  }

  if (message.type === "INVITE_CONTEXT_DETECTED") {
    const inviteContext = message.inviteContext || {};
    const serverUrl = normalizeServerUrl(inviteContext.serverUrl || "");
    const roomCode = normalizeRoomCode(inviteContext.roomCode || "");
    const platform = String(inviteContext.platform || "").toLowerCase().trim();
    if (!serverUrl || !roomCode) return;

    const inviteKey = `${serverUrl}|${roomCode}|${platform}`;
    if (inviteKey === lastHandledInviteKey && sessionState.inRoom && sessionState.roomCode === roomCode) {
      return;
    }
    lastHandledInviteKey = inviteKey;

    pendingAutoJoin = {
      serverUrl,
      roomCode,
      username: sessionState.username || "Guest",
      platform: platform || sessionState.platform || "",
    };

    persistSession({
      serverUrl,
      roomCode,
      inRoom: false,
      platform: pendingAutoJoin.platform,
    }).then(async () => {
      await ensureOffscreenDocument();
      toOffscreen({ type: "OFFSCREEN_CONNECT", serverUrl });
      if (sessionState.connectionState === "connected" || sessionState.connectionState === "reconnected") {
        triggerPendingAutoJoin();
      }
      toPopup({ type: "STATE_UPDATE", sessionState: { ...sessionState } });
    });
    return;
  }

  if (message.type === "OFFSCREEN_ACK") {
    resolvePendingAck(message.requestId, message.response);
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
      triggerPendingAutoJoin();
    }

    if (message.state === "connected") {
      triggerPendingAutoJoin();
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

    if (event === "room-joined" && pendingAutoJoin) {
      const autoJoinContext = { ...pendingAutoJoin };
      persistSession({
        roomCode: payload?.roomCode || autoJoinContext.roomCode,
        inRoom: true,
        username: autoJoinContext.username,
        platform: payload?.platform || autoJoinContext.platform || sessionState.platform || "",
      }).then(() => {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
        toSupportedTabs(
          { type: "ROOM_JOINED", username: autoJoinContext.username || sessionState.username || "Guest" },
          payload?.platform || autoJoinContext.platform || ""
        );
      });
      pendingAutoJoin = null;
    }

    if (event === "room-error" && pendingAutoJoin) {
      pendingAutoJoin = null;
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
