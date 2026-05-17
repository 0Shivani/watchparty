const {
  mountChatOverlay = () => {},
  unmountChatOverlay = () => {},
  receiveMessage = () => {},
} =
  window.WatchPartyChat || {};

let isSyncing = false;
let currentVideo = null;
let lastUrl = location.href;
const attachedVideos = new WeakSet();
let adInProgress = false;
let adWatcherStarted = false;
const PLATFORM = "netflix";
let lastReportedWatchUrl = "";
let lastInviteContextKey = "";

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

function attachPlayerListeners(video) {
  if (!video || attachedVideos.has(video)) return;
  attachedVideos.add(video);

  const sendEvent = (type) => {
    if (isSyncing) return;
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

    const hasCurrentTime = typeof action.currentTime === "number" && action.currentTime !== null;
    if (hasCurrentTime && (action.type === "seek" || Math.abs(video.currentTime - action.currentTime) > 2)) {
      isSyncing = true;
      video.currentTime = action.currentTime;
      video.addEventListener(
        "seeked",
        () => {
          isSyncing = false;
        },
        { once: true }
      );
    }

    if (action.type === "play") {
      isSyncing = true;
      video
        .play()
        .catch(() => {})
        .finally(() => {
          setTimeout(() => {
            isSyncing = false;
          }, 300);
        });
    }

    if (action.type === "pause") {
      isSyncing = true;
      video.pause();
      setTimeout(() => {
        isSyncing = false;
      }, 100);
    }
    return;
  }

  if (message.type === "AD_STARTED_REMOTE") {
    isSyncing = true;
    const video = findVideo();
    if (video) video.pause();
    setTimeout(() => {
      isSyncing = false;
    }, 300);
    return;
  }

  if (message.type === "AD_ENDED_REMOTE") {
    isSyncing = true;
    const video = findVideo();
    if (video) {
      video.play().catch(() => {});
    }
    setTimeout(() => {
      isSyncing = false;
    }, 300);
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

  history.pushState = (...args) => {
    _push(...args);
    onNavigate();
  };
  history.replaceState = (...args) => {
    _replace(...args);
    onNavigate();
  };

  window.addEventListener("popstate", onNavigate);
}

function onNavigate() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  currentVideo = null;
  sendInviteContextIfPresent();
  sendWatchUrlChanged();
  waitForVideo();

  chrome.storage.local.get(["inRoom", "username", "platform"], (stored) => {
    if (stored.inRoom && stored.username && stored.platform === "netflix") {
      mountChatOverlay(stored.username);
    }
  });
}

watchNavigation();
sendInviteContextIfPresent();
sendWatchUrlChanged();
waitForVideo();

chrome.storage.local.get(["inRoom", "username", "platform"], (stored) => {
  if (stored.inRoom && stored.username && stored.platform === "netflix") {
    mountChatOverlay(stored.username);
  }
});
