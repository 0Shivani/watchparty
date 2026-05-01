export function isAdPlaying() {
  return !!(
    document.querySelector("[class*='adContainer']") ||
    document.querySelector("[class*='AdContainer']") ||
    document.querySelector("[class*='ad-container']") ||
    document.querySelector("[class*='ad-overlay']") ||
    document.querySelector("[class*='ad-indicator']") ||
    document.querySelector("[class*='ad-badge']") ||
    document.querySelector("[class*='skip-ad']") ||
    document.querySelector("[class*='SkipAd']") ||
    document.querySelector("[class*='preroll']") ||
    (() => {
      const video = document.querySelector("video");
      return video && video.currentSrc && (
        video.currentSrc.includes("googleads") ||
        video.currentSrc.includes("doubleclick") ||
        video.currentSrc.includes("imasdk")
      );
    })()
  );
}

export function createAdWatcher(onAdStarted, onAdEnded) {
  if (!document.body) return { isAdActive: () => false, disconnect: () => {} };
  let adInProgress = isAdPlaying();
  const observer = new MutationObserver(() => {
    const adNow = isAdPlaying();
    if (adNow && !adInProgress) {
      adInProgress = true;
      onAdStarted();
    } else if (!adNow && adInProgress) {
      adInProgress = false;
      onAdEnded();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  return { isAdActive: () => adInProgress, disconnect: () => observer.disconnect() };
}
