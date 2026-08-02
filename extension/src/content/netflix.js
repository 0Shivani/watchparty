const {
  mountChatOverlay = () => {},
  unmountChatOverlay = () => {},
  receiveMessage = () => {},
} =
  window.WatchPartyChat || {};

let currentVideo = null;
let lastUrl = location.href;
const attachedVideos = new WeakSet();
let adInProgress = false;
let adWatcherStarted = false;
const PLATFORM = "netflix";
let lastReportedWatchUrl = "";
let lastInviteContextKey = "";

const BRIDGE_COMMAND_SOURCE = "wp-netflix";
const BRIDGE_ACK_SOURCE = "wp-netflix-bridge";
const BRIDGE_TIMEOUT_MS = 300;
const SEEK_TOLERANCE_SECONDS = 2;
const SEEK_SUPPRESS_MS = 1000;
const PLAYBACK_SUPPRESS_MS = 400;

// Applying a remote command makes the player emit the very events we listen
// for. Suppressing by deadline rather than a boolean means a short pause window
// can never unmask a seek that is still in flight, and the guard always expires
// instead of wedging sync shut when an expected event never arrives.
let syncSuppressUntil = 0;

function suppressLocalEvents(ms) {
  syncSuppressUntil = Math.max(syncSuppressUntil, Date.now() + ms);
}

function isSuppressed() {
  return Date.now() < syncSuppressUntil;
}

function isAdPlaying() {
  return !!(
    document.querySelector("[class*='PlayerControlsNpm__ad']") ||
    document.querySelector("[data-uia='player-ad-ui']")
  );
}

function startAdWatcher() {
  if (!document.body) return;
  adInProgress = isAdPlaying();
  const observer = new MutationObserver(() => {
    const adNow = isAdPlaying();

    if (adNow && !adInProgress) {
      adInProgress = true;
      chrome.runtime.sendMessage({ type: "AD_STARTED" });
    } else if (!adNow && adInProgress) {
      adInProgress = false;
      chrome.runtime.sendMessage({ type: "AD_ENDED" });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
}

function findVideo() {
  return document.querySelector(".VideoContainer video") || document.querySelector("video");
}

let bridgeInjected = false;
let bridgeRequestCounter = 0;
const pendingBridgeCommands = new Map();

// Netflix's player rejects external writes to currentTime with a full-page
// error, so playback is driven from the page world through its own player API.
function injectPlayerBridge() {
  if (bridgeInjected) return;
  const target = document.head || document.documentElement;
  if (!target) return;
  bridgeInjected = true;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("dynamic/netflix-player-bridge.js");
  script.addEventListener("load", () => script.remove());
  target.appendChild(script);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== BRIDGE_ACK_SOURCE || !data.requestId) return;

  const pending = pendingBridgeCommands.get(data.requestId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingBridgeCommands.delete(data.requestId);
  pending.resolve(Boolean(data.ok));
});

// Resolves false when the bridge is missing or could not reach a player, which
// lets callers fall back to the raw element for the commands Netflix tolerates.
function sendBridgeCommand(command, timeMs) {
  injectPlayerBridge();

  return new Promise((resolve) => {
    const requestId = `wp_${Date.now()}_${bridgeRequestCounter++}`;
    const timeoutId = setTimeout(() => {
      pendingBridgeCommands.delete(requestId);
      resolve(false);
    }, BRIDGE_TIMEOUT_MS);

    pendingBridgeCommands.set(requestId, { resolve, timeoutId });
    window.postMessage({ source: BRIDGE_COMMAND_SOURCE, requestId, command, timeMs }, "*");
  });
}

function remotePlay() {
  suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
  sendBridgeCommand("play").then((ok) => {
    if (ok) return;
    suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
    findVideo()
      ?.play()
      .catch(() => {});
  });
}

function remotePause() {
  suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
  sendBridgeCommand("pause").then((ok) => {
    if (ok) return;
    suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
    findVideo()?.pause();
  });
}

function normalizeWatchUrl(rawUrl = location.href) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.searchParams.delete("wp_room");
    url.searchParams.delete("wp_server");
    url.searchParams.delete("wp_platform");
    return url.toString();
  } catch {
    return "";
  }
}

function sendWatchUrlChanged() {
  const watchUrl = normalizeWatchUrl();
  if (!watchUrl || watchUrl === lastReportedWatchUrl) return;
  lastReportedWatchUrl = watchUrl;
  chrome.runtime.sendMessage({
    type: "WATCH_URL_CHANGED",
    watchUrl,
    platform: PLATFORM,
  });
}

function parseInviteContextFromLocation() {
  try {
    const url = new URL(location.href);
    const roomCode = String(url.searchParams.get("wp_room") || "")
      .toUpperCase()
      .trim();
    const rawServerUrl = String(url.searchParams.get("wp_server") || "").trim();
    const incomingPlatform = String(url.searchParams.get("wp_platform") || PLATFORM)
      .toLowerCase()
      .trim();
    if (!roomCode || !rawServerUrl) return null;

    const serverUrl = new URL(rawServerUrl);
    if (!["http:", "https:"].includes(serverUrl.protocol)) return null;

    return {
      roomCode,
      serverUrl: serverUrl.origin,
      platform: incomingPlatform || PLATFORM,
    };
  } catch {
    return null;
  }
}

function sendInviteContextIfPresent() {
  const inviteContext = parseInviteContextFromLocation();
  if (!inviteContext) return;
  const contextKey = `${inviteContext.serverUrl}|${inviteContext.roomCode}|${inviteContext.platform}`;
  if (contextKey === lastInviteContextKey) return;
  lastInviteContextKey = contextKey;
  chrome.runtime.sendMessage({
    type: "INVITE_CONTEXT_DETECTED",
    inviteContext,
  });
}

function syncChatOverlayFromSession() {
  chrome.runtime.sendMessage({ type: "CONTENT_GET_SESSION" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.shouldMountChat && response.username) {
      mountChatOverlay(response.username);
    }
  });
}

function attachPlayerListeners(video) {
  if (!video || attachedVideos.has(video)) return;
  attachedVideos.add(video);

  const sendEvent = (type) => {
    if (isSuppressed()) return;
    if (adInProgress) return;
    chrome.runtime.sendMessage({
      type: "LOCAL_EVENT",
      action: { type, currentTime: video.currentTime },
    });
  };

  video.addEventListener("play", () => sendEvent("play"));
  video.addEventListener("pause", () => sendEvent("pause"));
  video.addEventListener("seeked", () => sendEvent("seek"));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "APPLY_SYNC") {
    const video = findVideo();
    if (!video) return;

    const { action } = message;
    if (!action || typeof action.type !== "string") return;

    const hasCurrentTime = typeof action.currentTime === "number" && Number.isFinite(action.currentTime);
    const drift = hasCurrentTime ? Math.abs(video.currentTime - action.currentTime) : 0;
    if (hasCurrentTime && (action.type === "seek" || drift > SEEK_TOLERANCE_SECONDS)) {
      suppressLocalEvents(SEEK_SUPPRESS_MS);
      // No raw-element fallback: assigning currentTime is exactly what breaks
      // Netflix, so a dropped seek is preferable to an error screen.
      sendBridgeCommand("seek", action.currentTime * 1000);
    }

    if (action.type === "play") {
      remotePlay();
    }

    if (action.type === "pause") {
      remotePause();
    }
    return;
  }

  if (message.type === "AD_STARTED_REMOTE") {
    remotePause();
    return;
  }

  if (message.type === "AD_ENDED_REMOTE") {
    remotePlay();
    return;
  }

  if (message.type === "ROOM_JOINED") {
    mountChatOverlay(message.username);
    return;
  }

  if (message.type === "ROOM_LEFT") {
    unmountChatOverlay();
    return;
  }

  if (message.type === "INCOMING_CHAT") {
    receiveMessage(message.payload || {});
  }
});

function attachToPlayer() {
  const video = findVideo();
  if (!video || video === currentVideo) return;
  currentVideo = video;
  attachPlayerListeners(video);
  sendWatchUrlChanged();
  if (!adWatcherStarted) {
    adWatcherStarted = true;
    startAdWatcher();
  }

  const observedVideo = video;
  const videoRemovalObserver = new MutationObserver(() => {
    if (!document.contains(observedVideo)) {
      if (currentVideo === observedVideo) {
        currentVideo = null;
      }
      videoRemovalObserver.disconnect();
      waitForVideo();
    }
  });
  videoRemovalObserver.observe(document.body, { childList: true, subtree: true });
}

function waitForVideo() {
  const video = findVideo();
  if (video && video !== currentVideo) {
    attachToPlayer();
    return;
  }
  const observer = new MutationObserver(() => {
    const v = findVideo();
    if (v && v !== currentVideo) {
      observer.disconnect();
      attachToPlayer();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function watchNavigation() {
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);

  // A throw here would propagate into Netflix's own router and can trip its
  // error boundary, so extension failures must never escape the override.
  const safeOnNavigate = () => {
    try {
      onNavigate();
    } catch {
      // Extension context invalidated or the page is tearing down.
    }
  };

  history.pushState = (...args) => {
    _push(...args);
    safeOnNavigate();
  };
  history.replaceState = (...args) => {
    _replace(...args);
    safeOnNavigate();
  };

  window.addEventListener("popstate", safeOnNavigate);
}

function onNavigate() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  currentVideo = null;
  sendInviteContextIfPresent();
  sendWatchUrlChanged();
  waitForVideo();
  syncChatOverlayFromSession();
}

injectPlayerBridge();
watchNavigation();
sendInviteContextIfPresent();
sendWatchUrlChanged();
waitForVideo();
syncChatOverlayFromSession();
