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
const PLATFORM = "youtube";
let lastReportedWatchUrl = "";
let lastInviteContextKey = "";

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
  return !!document.querySelector(".html5-video-player.ad-showing");
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
  return document.querySelector(".html5-video-container video") || document.querySelector("video");
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
      video.currentTime = action.currentTime;
    }

    if (action.type === "play") {
      suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
      video.play().catch(() => {});
    }

    if (action.type === "pause") {
      suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
      video.pause();
    }
    return;
  }

  if (message.type === "AD_STARTED_REMOTE") {
    suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
    findVideo()?.pause();
    return;
  }

  if (message.type === "AD_ENDED_REMOTE") {
    suppressLocalEvents(PLAYBACK_SUPPRESS_MS);
    findVideo()
      ?.play()
      .catch(() => {});
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

  // A throw here would propagate into the host page's own router and can trip
  // its error boundary, so extension failures must never escape the override.
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

if (typeof window !== "undefined") {
  window.addEventListener("yt-navigate-finish", () => {
    currentVideo = null;
    sendInviteContextIfPresent();
    sendWatchUrlChanged();
    waitForVideo();
    syncChatOverlayFromSession();
  });
}

watchNavigation();
sendInviteContextIfPresent();
sendWatchUrlChanged();
waitForVideo();
syncChatOverlayFromSession();
