export function parseInviteLink(raw) {
  const trimmed = raw.trim();
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
