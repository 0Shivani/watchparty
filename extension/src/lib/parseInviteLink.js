const SUPPORTED_PLATFORMS = new Set(["youtube", "netflix", "primevideo", "hotstar"]);

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
    if (incomingPlatform && !SUPPORTED_PLATFORMS.has(incomingPlatform)) return null;

    return {
      roomCode,
      serverUrl: serverUrl.origin,
      platform: incomingPlatform || "",
    };
  } catch {
    return null;
  }
}
