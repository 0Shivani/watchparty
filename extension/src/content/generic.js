// Adapter for sites the user has explicitly granted access to. Unlike the
// per-platform scripts it knows nothing about the page's markup, so it picks the
// primary <video> heuristically and skips ad detection entirely.
(function () {
  // The service worker re-injects into already-open tabs when a site is
  // approved, so replace any earlier instance instead of stacking listeners.
  const previousInstance = window.__watchPartyGeneric;
  if (previousInstance && typeof previousInstance.teardown === "function") {
    previousInstance.teardown();
  }

  const {
    mountChatOverlay = () => {},
    unmountChatOverlay = () => {},
    receiveMessage = () => {},
  } = window.WatchPartyChat || {};

  const IS_TOP_FRAME = window.top === window;
  const PLATFORM = `generic:${location.hostname.toLowerCase()}`;

  const abortController = new AbortController();
  const listenerOptions = { signal: abortController.signal };
  const observers = new Set();
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  let isSyncing = false;
  let currentVideo = null;
  let lastUrl = location.href;
  let lastReportedWatchUrl = "";
  let lastInviteContextKey = "";
  const attachedVideos = new WeakSet();

  function startObserver(target, callback) {
    if (!target) return null;
    const observer = new MutationObserver(callback);
    observers.add(observer);
    observer.observe(target, { childList: true, subtree: true });
    return observer;
  }

  function stopObserver(observer) {
    if (!observer) return;
    observer.disconnect();
    observers.delete(observer);
  }

  // Ranks a candidate so a hero player outranks thumbnail previews, autoplaying
  // banners, and hidden preload elements.
  function scoreVideo(video) {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area <= 0) return 0;

    let score = area;
    if (!video.paused && !video.ended) score *= 4;
    if (Number.isFinite(video.duration) && video.duration > 0) score *= 2;
    if (video.muted && video.paused) score *= 0.5;
    return score;
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;

    let best = null;
    let bestScore = 0;
    videos.forEach((video) => {
      const score = scoreVideo(video);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    });

    // Every candidate is still zero-sized (player not laid out yet); fall back to
    // the first one so playback events are not missed during startup.
    return best || videos[0];
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
    if (!IS_TOP_FRAME) return;
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
    if (!IS_TOP_FRAME) return;
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
    if (!IS_TOP_FRAME) return;
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
      if (isSyncing) return;
      if (video !== currentVideo) return;
      chrome.runtime.sendMessage({
        type: "LOCAL_EVENT",
        action: { type, currentTime: video.currentTime },
      });
    };

    video.addEventListener("play", () => sendEvent("play"), listenerOptions);
    video.addEventListener("pause", () => sendEvent("pause"), listenerOptions);
    video.addEventListener("seeked", () => sendEvent("seek"), listenerOptions);
  }

  function attachToPlayer(video = findVideo()) {
    if (!video || video === currentVideo) return;
    currentVideo = video;
    attachPlayerListeners(video);
    sendWatchUrlChanged();

    const observedVideo = video;
    const removalObserver = startObserver(document.body, () => {
      if (document.contains(observedVideo)) return;
      if (currentVideo === observedVideo) currentVideo = null;
      stopObserver(removalObserver);
      waitForVideo();
    });
  }

  function waitForVideo() {
    const video = findVideo();
    if (video && video !== currentVideo) {
      attachToPlayer(video);
      return;
    }

    const observer = startObserver(document.body, () => {
      const candidate = findVideo();
      if (!candidate || candidate === currentVideo) return;
      stopObserver(observer);
      attachToPlayer(candidate);
    });
  }

  // Players are frequently swapped out without a DOM mutation we can observe, so
  // treat any video that starts playing as the new primary.
  function watchForPlayerSwap() {
    document.addEventListener(
      "play",
      (event) => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        if (video === currentVideo) return;
        if (currentVideo && scoreVideo(currentVideo) > scoreVideo(video)) return;
        attachToPlayer(video);
      },
      { capture: true, signal: abortController.signal }
    );
  }

  function handleRuntimeMessage(message) {
    if (message.type === "APPLY_SYNC") {
      const video = currentVideo || findVideo();
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

    if (message.type === "ROOM_JOINED") {
      if (IS_TOP_FRAME) mountChatOverlay(message.username);
      return;
    }

    if (message.type === "ROOM_LEFT") {
      if (IS_TOP_FRAME) unmountChatOverlay();
      return;
    }

    if (message.type === "INCOMING_CHAT") {
      if (IS_TOP_FRAME) receiveMessage(message.payload || {});
    }
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

  function watchNavigation() {
    history.pushState = function pushState(...args) {
      originalPushState.apply(history, args);
      onNavigate();
    };
    history.replaceState = function replaceState(...args) {
      originalReplaceState.apply(history, args);
      onNavigate();
    };
    window.addEventListener("popstate", onNavigate, listenerOptions);
  }

  function teardown() {
    abortController.abort();
    observers.forEach((observer) => observer.disconnect());
    observers.clear();
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    chrome.runtime.onMessage.removeListener?.(handleRuntimeMessage);
    if (window.__watchPartyGeneric === instance) {
      delete window.__watchPartyGeneric;
    }
  }

  const instance = { teardown };
  window.__watchPartyGeneric = instance;

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  watchNavigation();
  watchForPlayerSwap();
  sendInviteContextIfPresent();
  sendWatchUrlChanged();
  waitForVideo();
  syncChatOverlayFromSession();
})();
