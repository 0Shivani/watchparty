const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
};

const KEEP_ALIVE_ALARM = "watchparty-keepalive";

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function setSessionState(partialState) {
  await chrome.storage.local.set(partialState);
}

async function maybeToggleKeepAlive(inRoom) {
  if (inRoom) {
    await chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 25 / 60 });
  } else {
    await chrome.alarms.clear(KEEP_ALIVE_ALARM);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const initial = await chrome.storage.local.get([
    STORAGE_KEYS.serverUrl,
    STORAGE_KEYS.roomCode,
    STORAGE_KEYS.inRoom,
  ]);
  await chrome.storage.local.set({
    [STORAGE_KEYS.serverUrl]: initial[STORAGE_KEYS.serverUrl] || "",
    [STORAGE_KEYS.roomCode]: initial[STORAGE_KEYS.roomCode] || "",
    [STORAGE_KEYS.inRoom]: Boolean(initial[STORAGE_KEYS.inRoom]),
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

  if (message.type === "SET_SESSION_STATE") {
    const { serverUrl = "", roomCode = "", inRoom = false } = message.payload || {};
    setSessionState({
      [STORAGE_KEYS.serverUrl]: serverUrl,
      [STORAGE_KEYS.roomCode]: roomCode,
      [STORAGE_KEYS.inRoom]: Boolean(inRoom),
    })
      .then(() => maybeToggleKeepAlive(Boolean(inRoom)))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "CLEAR_ROOM_STATE") {
    setSessionState({
      [STORAGE_KEYS.roomCode]: "",
      [STORAGE_KEYS.inRoom]: false,
    })
      .then(() => maybeToggleKeepAlive(false))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "GET_SESSION_STATE") {
    chrome.storage.local
      .get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.roomCode, STORAGE_KEYS.inRoom])
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEP_ALIVE_ALARM) return;
  chrome.runtime.getPlatformInfo(() => {
    // Touching extension APIs on alarm tick helps keep the worker alive while in-room.
  });
});
