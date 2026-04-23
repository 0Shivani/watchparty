let isSyncing = false;
let attachedVideo = null;

function findVideo() {
  return document.querySelector(".html5-video-container video") || document.querySelector("video");
}

function attachPlayerListeners(video) {
  if (!video || attachedVideo === video) return;
  attachedVideo = video;

  const sendEvent = (type) => {
    if (isSyncing) return;
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
  if (message.type !== "APPLY_SYNC") return;
  const video = findVideo();
  if (!video) return;

  const { action } = message;
  isSyncing = true;

  if (Math.abs(video.currentTime - action.currentTime) > 2) {
    video.currentTime = action.currentTime;
  }

  if (action.type === "play") video.play().catch(() => {});
  if (action.type === "pause") video.pause();
  if (action.type === "seek") {
    // Time already corrected above.
  }

  setTimeout(() => {
    isSyncing = false;
  }, 500);
});

function init() {
  const video = findVideo();
  if (video) {
    attachPlayerListeners(video);
    return;
  }

  const observer = new MutationObserver(() => {
    const v = findVideo();
    if (v) {
      observer.disconnect();
      attachPlayerListeners(v);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

init();
