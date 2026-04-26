const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
  username: "username",
};

const ALARM_NAME = "keepAlive";

async function restoreAlarmIfNeeded() {
  const { inRoom } = await chrome.storage.local.get([STORAGE_KEYS.inRoom]);
  if (!inRoom) return;

  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
  }
}

restoreAlarmIfNeeded();

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function setSessionState(partialState) {
  await chrome.storage.local.set(partialState);
}

async function maybeToggleKeepAlive(inRoom) {
  if (inRoom) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const initial = await chrome.storage.local.get([
    STORAGE_KEYS.serverUrl,
    STORAGE_KEYS.roomCode,
    STORAGE_KEYS.inRoom,
    STORAGE_KEYS.username,
  ]);
  await chrome.storage.local.set({
    [STORAGE_KEYS.serverUrl]: initial[STORAGE_KEYS.serverUrl] || "",
    [STORAGE_KEYS.roomCode]: initial[STORAGE_KEYS.roomCode] || "",
    [STORAGE_KEYS.inRoom]: Boolean(initial[STORAGE_KEYS.inRoom]),
    [STORAGE_KEYS.username]: initial[STORAGE_KEYS.username] || "",
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "APPLY_SYNC") {
    getActiveTabId()
      .then((tabId) => {
        if (!tabId) {
          sendResponse({ ok: false, error: "No active tab" });
          return;
        }
        chrome.tabs.sendMessage(tabId, {
          type: "APPLY_SYNC",
          action: message.action,
        });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOCAL_EVENT") {
    // Only relay user player actions originating from tab content scripts.
    if (!sender.tab) {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    chrome.runtime.sendMessage({
      type: "LOCAL_EVENT",
      action: message.action,
    });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "AD_STARTED") {
    if (!sender.tab) {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    chrome.runtime.sendMessage({ type: "AD_STARTED" });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "AD_ENDED") {
    if (!sender.tab) {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    chrome.runtime.sendMessage({ type: "AD_ENDED" });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "SET_SESSION_STATE") {
    const { serverUrl = "", roomCode = "", inRoom = false, username = "" } = message.payload || {};
    setSessionState({
      [STORAGE_KEYS.serverUrl]: serverUrl,
      [STORAGE_KEYS.roomCode]: roomCode,
      [STORAGE_KEYS.inRoom]: Boolean(inRoom),
      [STORAGE_KEYS.username]: username,
    })
      .then(() => maybeToggleKeepAlive(Boolean(inRoom)))
      .then(async () => {
        if (inRoom) {
          const tabId = await getActiveTabId();
          if (tabId) {
            chrome.tabs.sendMessage(tabId, {
              type: "ROOM_JOINED",
              username,
            });
          }
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "CLEAR_ROOM_STATE") {
    setSessionState({
      [STORAGE_KEYS.roomCode]: "",
      [STORAGE_KEYS.inRoom]: false,
    })
      .then(() => maybeToggleKeepAlive(false))
      .then(async () => {
        const tabId = await getActiveTabId();
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "ROOM_LEFT" });
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "CHAT_SEND") {
    // Relay only tab-originated chat sends to popup; ignore extension-originated echoes.
    if (!sender.tab) {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    chrome.runtime.sendMessage({
      type: "CHAT_SEND",
      payload: message.payload,
    });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "INCOMING_CHAT") {
    getActiveTabId()
      .then((tabId) => {
        if (!tabId) {
          sendResponse({ ok: false, error: "No active tab" });
          return;
        }
        chrome.tabs.sendMessage(tabId, {
          type: "INCOMING_CHAT",
          payload: message.payload,
        });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "GET_SESSION_STATE") {
    chrome.storage.local
      .get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.roomCode, STORAGE_KEYS.inRoom, STORAGE_KEYS.username])
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
  }
});
