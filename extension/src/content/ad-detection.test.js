import { describe, test, expect, vi, afterEach } from "vitest";
import { isAdPlaying, createAdWatcher } from "./ad-detection.js";

afterEach(() => {
  document.body.innerHTML = "";
});

// ─── isAdPlaying selector coverage ───────────────────────────────────────────

describe("isAdPlaying — DOM selectors", () => {
  test("returns false when no ad elements are present", () => {
    document.body.innerHTML = '<div class="player-container"></div>';
    expect(isAdPlaying()).toBe(false);
  });

  test("detects adContainer class fragment", () => {
    document.body.innerHTML = '<div class="adContainer"></div>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects AdContainer (capital A and C)", () => {
    document.body.innerHTML = '<div class="AdContainer--main"></div>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects ad-container class fragment", () => {
    document.body.innerHTML = '<div class="ad-container"></div>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects ad-overlay class fragment", () => {
    document.body.innerHTML = '<div class="player__ad-overlay"></div>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects ad-indicator class fragment", () => {
    document.body.innerHTML = '<div class="ad-indicator"></div>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects ad-badge class fragment", () => {
    document.body.innerHTML = '<span class="ad-badge">AD</span>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects skip-ad class fragment", () => {
    document.body.innerHTML = '<button class="skip-ad-btn">Skip Ad</button>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects SkipAd (camel case) class fragment", () => {
    document.body.innerHTML = '<button class="SkipAdButton">Skip</button>';
    expect(isAdPlaying()).toBe(true);
  });

  test("detects preroll class fragment", () => {
    document.body.innerHTML = '<div class="preroll-container"></div>';
    expect(isAdPlaying()).toBe(true);
  });
});

describe("isAdPlaying — video currentSrc CDN check", () => {
  function videoWithSrc(src) {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentSrc", { value: src, writable: false });
    document.body.appendChild(video);
    return video;
  }

  test("detects ad when video src contains googleads", () => {
    videoWithSrc("https://googleads.g.doubleclick.net/pagead/id");
    expect(isAdPlaying()).toBe(true);
  });

  test("detects ad when video src contains doubleclick", () => {
    videoWithSrc("https://ad.doubleclick.net/ddm/ad/content.mp4");
    expect(isAdPlaying()).toBe(true);
  });

  test("detects ad when video src contains imasdk", () => {
    videoWithSrc("https://imasdk.googleapis.com/js/sdkloader/stream.m3u8");
    expect(isAdPlaying()).toBe(true);
  });

  test("does not flag regular content CDN as an ad", () => {
    videoWithSrc("https://cdn.hotstar.com/content/episode-1.mp4");
    expect(isAdPlaying()).toBe(false);
  });

  test("does not flag empty currentSrc as an ad", () => {
    videoWithSrc("");
    expect(isAdPlaying()).toBe(false);
  });
});

// ─── createAdWatcher state-machine transitions ────────────────────────────────

describe("createAdWatcher — AD_STARTED / AD_ENDED transitions", () => {
  test("fires onAdStarted when an ad element appears in the DOM", async () => {
    const onAdStarted = vi.fn();
    const onAdEnded = vi.fn();
    const watcher = createAdWatcher(onAdStarted, onAdEnded);

    const adEl = document.createElement("div");
    adEl.className = "adContainer";
    document.body.appendChild(adEl);
    await new Promise((r) => setTimeout(r, 0));

    expect(onAdStarted).toHaveBeenCalledTimes(1);
    expect(onAdEnded).not.toHaveBeenCalled();
    watcher.disconnect();
  });

  test("fires onAdEnded when the ad element is removed", async () => {
    const adEl = document.createElement("div");
    adEl.className = "adContainer";
    document.body.appendChild(adEl);

    const onAdStarted = vi.fn();
    const onAdEnded = vi.fn();
    const watcher = createAdWatcher(onAdStarted, onAdEnded);

    adEl.remove();
    await new Promise((r) => setTimeout(r, 0));

    expect(onAdEnded).toHaveBeenCalledTimes(1);
    expect(onAdStarted).not.toHaveBeenCalled();
    watcher.disconnect();
  });

  test("fires both callbacks across a full ad cycle", async () => {
    const onAdStarted = vi.fn();
    const onAdEnded = vi.fn();
    const watcher = createAdWatcher(onAdStarted, onAdEnded);

    const adEl = document.createElement("div");
    adEl.className = "adContainer";

    document.body.appendChild(adEl);
    await new Promise((r) => setTimeout(r, 0));
    expect(onAdStarted).toHaveBeenCalledTimes(1);

    adEl.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(onAdEnded).toHaveBeenCalledTimes(1);

    watcher.disconnect();
  });

  test("does not fire callbacks for unrelated DOM mutations", async () => {
    const onAdStarted = vi.fn();
    const onAdEnded = vi.fn();
    const watcher = createAdWatcher(onAdStarted, onAdEnded);

    const el = document.createElement("div");
    el.className = "player-wrapper";
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 0));

    expect(onAdStarted).not.toHaveBeenCalled();
    expect(onAdEnded).not.toHaveBeenCalled();
    watcher.disconnect();
  });

  test("does not fire onAdStarted again if ad is already in progress", async () => {
    const adEl = document.createElement("div");
    adEl.className = "adContainer";
    document.body.appendChild(adEl);

    const onAdStarted = vi.fn();
    const onAdEnded = vi.fn();
    const watcher = createAdWatcher(onAdStarted, onAdEnded);

    // Add a second ad element while first ad is already active
    const adEl2 = document.createElement("div");
    adEl2.className = "ad-badge";
    document.body.appendChild(adEl2);
    await new Promise((r) => setTimeout(r, 0));

    expect(onAdStarted).not.toHaveBeenCalled();
    expect(onAdEnded).not.toHaveBeenCalled();
    watcher.disconnect();
  });

  test("isAdActive() reflects current ad state", async () => {
    const watcher = createAdWatcher(() => {}, () => {});
    expect(watcher.isAdActive()).toBe(false);

    const adEl = document.createElement("div");
    adEl.className = "adContainer";
    document.body.appendChild(adEl);
    await new Promise((r) => setTimeout(r, 0));
    expect(watcher.isAdActive()).toBe(true);

    adEl.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(watcher.isAdActive()).toBe(false);

    watcher.disconnect();
  });
});
