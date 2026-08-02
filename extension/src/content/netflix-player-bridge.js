// Runs in the page (MAIN) world so it can reach window.netflix, which the
// isolated content script cannot see. Netflix's Cadmium player rejects external
// writes to video.currentTime with a full-page error, so every playback command
// has to go through its own player API instead.
(function () {
  const COMMAND_SOURCE = "wp-netflix";
  const ACK_SOURCE = "wp-netflix-bridge";

  if (window.__watchPartyNetflixBridge) return;
  window.__watchPartyNetflixBridge = true;

  // The session id changes with every title, so resolve it per command rather
  // than caching a player that may already be torn down.
  function resolvePlayer() {
    try {
      const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      const sessionId = videoPlayer?.getAllPlayerSessionIds?.()?.[0];
      if (!sessionId) return null;
      return videoPlayer.getVideoPlayerBySessionId(sessionId) || null;
    } catch {
      return null;
    }
  }

  function runCommand(command, timeMs) {
    const player = resolvePlayer();
    if (!player) return false;

    try {
      if (command === "seek") {
        if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) return false;
        player.seek(Math.max(0, Math.round(timeMs)));
        return true;
      }
      if (command === "play") {
        player.play();
        return true;
      }
      if (command === "pause") {
        player.pause();
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== COMMAND_SOURCE) return;

    const ok = runCommand(data.command, data.timeMs);
    window.postMessage({ source: ACK_SOURCE, requestId: data.requestId, ok }, "*");
  });

  window.postMessage({ source: ACK_SOURCE, ready: true }, "*");
})();
