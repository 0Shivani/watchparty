const SUPPORTED_PLATFORMS = new Set(["youtube", "netflix", "primevideo", "hotstar"]);
// Sites without a dedicated adapter are keyed by hostname so a room still locks
// to exactly one site.
const GENERIC_PLATFORM_PATTERN = /^generic:[a-z0-9.-]{1,253}$/;

export function isSupportedPlatform(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return false;
  return SUPPORTED_PLATFORMS.has(normalized) || GENERIC_PLATFORM_PATTERN.test(normalized);
}

export function formatPlatformLabel(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (!normalized) return "Unknown";
  if (normalized.startsWith("generic:")) return normalized.slice("generic:".length);
  const labels = {
    youtube: "YouTube",
    netflix: "Netflix",
    primevideo: "Prime Video",
    hotstar: "JioHotstar",
  };
  return labels[normalized] || "Unknown";
}

export function parseInviteLink(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null;
  try {
    const url = new URL(trimmed);
    const room = url.searchParams.get("room");
    if (!room) return null;
    return { serverUrl: url.origin, roomCode: room.toUpperCase().trim() };
  } catch {
    return null;
  }
}

export function parseInviteContextFromUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null;
  try {
    const url = new URL(trimmed);
    const roomCode = String(url.searchParams.get("wp_room") || "")
      .toUpperCase()
      .trim();
    const rawServerUrl = String(url.searchParams.get("wp_server") || "").trim();
    const incomingPlatform = String(url.searchParams.get("wp_platform") || "")
      .toLowerCase()
      .trim();
    if (!roomCode || !rawServerUrl) return null;

    const serverUrl = new URL(rawServerUrl);
    if (!["http:", "https:"].includes(serverUrl.protocol)) return null;
    if (incomingPlatform && !isSupportedPlatform(incomingPlatform)) return null;

    return {
      roomCode,
      serverUrl: serverUrl.origin,
      platform: incomingPlatform || "",
    };
  } catch {
    return null;
  }
}
