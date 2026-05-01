import { createAdWatcher } from "./ad-detection.js";

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
let adWatcher = null;

function startAdWatcher() {
  adWatcher = createAdWatcher(
    () => chrome.runtime.sendMessage({ type: "AD_STARTED" }),
    () => chrome.runtime.sendMessage({ type: "AD_ENDED" })
  );
}

function findVideo() {
  return document.querySelector(".hotstar-player video") || document.querySelector("video");
}

function attachPlayerListeners(video) {
  if (!video || attachedVideos.has(video)) return;
  attachedVideos.add(video);

  const sendEvent = (type) => {
    if (isSyncing) return;
    if (adWatcher?.isAdActive()) return;
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
  if (!adWatcher) {
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
  waitForVideo();

  chrome.storage.local.get(["inRoom", "username", "platform"], (stored) => {
    if (stored.inRoom && stored.username && stored.platform === "hotstar") {
      mountChatOverlay(stored.username);
    }
  });
}

watchNavigation();
waitForVideo();

chrome.storage.local.get(["inRoom", "username", "platform"], (stored) => {
  if (stored.inRoom && stored.username && stored.platform === "hotstar") {
    mountChatOverlay(stored.username);
  }
});
