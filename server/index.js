import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";

const MAX_MEMBERS = 10;

const app = express();
// Dev-only CORS policy; lock this down to trusted origins in production.
app.use(cors({ origin: "*" }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

const rooms = new Map();
const disconnectTimers = new Map(); // socketId -> timeoutId

function safePayload(data) {
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function sanitizeUsername(raw) {
  if (!raw || typeof raw !== "string") return "A user";
  return raw.trim().slice(0, 20) || "A user";
}

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createUniqueRoomCode() {
  let code = generateRoomCode();
  while (rooms.has(code)) {
    code = generateRoomCode();
  }
  return code;
}

function getRoomAndValidate(roomCode, socket) {
  const room = rooms.get(roomCode);
  if (!room) {
    socket.emit("room-error", { message: "Room not found" });
    return null;
  }
  return room;
}

function emitMemberUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("member-update", { memberCount: room.members.size });
}

function leaveCurrentRoom(socket, roomsMap) {
  const currentRoomCode = socket.data.roomCode;
  if (!currentRoomCode) return;

  const pendingTimer = disconnectTimers.get(socket.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    disconnectTimers.delete(socket.id);
  }

  const room = roomsMap.get(currentRoomCode);
  if (room) {
    room.members.delete(socket.id);
    room.usernames?.delete(socket.id);
    socket.leave(currentRoomCode);

    if (room.members.size === 0) {
      roomsMap.delete(currentRoomCode);
    } else {
      if (room.hostId === socket.id) {
        room.hostId = room.members.values().next().value;
      }
      emitMemberUpdate(currentRoomCode);
    }
  }

  socket.data.roomCode = null;
  socket.data.username = null;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.username = null;

  socket.on("create-room", (rawData) => {
    leaveCurrentRoom(socket, rooms);
    const { username } = safePayload(rawData);
    const displayName = sanitizeUsername(username);
    const roomCode = createUniqueRoomCode();
    rooms.set(roomCode, {
      hostId: socket.id,
      members: new Set([socket.id]),
      usernames: new Map([[socket.id, displayName]]),
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = displayName;
    socket.emit("room-created", { roomCode });
    socket.emit("room-joined", { roomCode, memberCount: 1 });
    emitMemberUpdate(roomCode);
  });

  socket.on("join-room", (rawData) => {
    const { roomCode, username } = safePayload(rawData);
    const displayName = sanitizeUsername(username);
    if (!roomCode) {
      socket.emit("room-error", { message: "Room code is required." });
      return;
    }
    const normalizedCode = String(roomCode || "").toUpperCase().trim();
    const room = getRoomAndValidate(normalizedCode, socket);
    if (!room) return;

    if (room.members.size >= MAX_MEMBERS) {
      socket.emit("room-error", { message: "Room full" });
      return;
    }

    leaveCurrentRoom(socket, rooms);
    room.members.add(socket.id);
    room.usernames = room.usernames || new Map();
    room.usernames.set(socket.id, displayName);
    socket.join(normalizedCode);
    socket.data.roomCode = normalizedCode;
    socket.data.username = displayName;

    socket.emit("room-joined", {
      roomCode: normalizedCode,
      memberCount: room.members.size,
    });
    emitMemberUpdate(normalizedCode);
  });

  socket.on("sync-event", (rawData) => {
    const { roomCode, action } = safePayload(rawData);
    if (!roomCode || !action || typeof action.type !== "string") return;
    const normalizedCode = String(roomCode || "").toUpperCase().trim();
    const room = rooms.get(normalizedCode);
    if (!room || !room.members.has(socket.id)) return;

    socket.to(normalizedCode).emit("sync-event", { action });
  });

  socket.on("chat-message", (rawData) => {
    const { roomCode, text } = safePayload(rawData);
    const normalizedCode = String(roomCode || socket.data.roomCode || "")
      .toUpperCase()
      .trim();
    if (!normalizedCode || !rooms.has(normalizedCode)) return;

    const room = rooms.get(normalizedCode);
    if (!room || !room.members.has(socket.id)) return;

    if (!text || typeof text !== "string") return;
    const sanitizedText = text.trim().slice(0, 200);
    if (!sanitizedText) return;

    const username = socket.data.username || "A user";
    const timestamp = Date.now();

    socket.to(normalizedCode).emit("chat-message", {
      username,
      text: sanitizedText,
      timestamp,
    });
  });

  socket.on("leave-room", (rawData) => {
    const { roomCode } = safePayload(rawData);
    const normalizedCode = String(roomCode || socket.data.roomCode || "")
      .toUpperCase()
      .trim();
    if (!normalizedCode) return;
    leaveCurrentRoom(socket, rooms);
  });

  socket.on("ad-started", (rawData) => {
    const { roomCode } = safePayload(rawData);
    const normalizedCode = String(roomCode || socket.data.roomCode || "")
      .toUpperCase()
      .trim();
    if (!normalizedCode || !rooms.has(normalizedCode)) return;
    const room = rooms.get(normalizedCode);
    if (!room || !room.members.has(socket.id)) return;

    const username = socket.data.username || room.usernames?.get(socket.id) || "A user";
    socket.to(normalizedCode).emit("ad-started", { username });
  });

  socket.on("ad-ended", (rawData) => {
    const { roomCode } = safePayload(rawData);
    const normalizedCode = String(roomCode || socket.data.roomCode || "")
      .toUpperCase()
      .trim();
    if (!normalizedCode || !rooms.has(normalizedCode)) return;
    const room = rooms.get(normalizedCode);
    if (!room || !room.members.has(socket.id)) return;

    socket.to(normalizedCode).emit("ad-ended");
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    room.members.delete(socket.id);
    room.usernames?.delete(socket.id);
    socket.leave(roomCode);

    if (room.hostId === socket.id && room.members.size > 0) {
      room.hostId = room.members.values().next().value;
    }

    io.to(roomCode).emit("member-update", { memberCount: room.members.size });

    if (room.members.size === 0) {
      const timer = setTimeout(() => {
        const r = rooms.get(roomCode);
        if (r && r.members.size === 0) {
          rooms.delete(roomCode);
        }
        disconnectTimers.delete(socket.id);
      }, 45000);

      disconnectTimers.set(socket.id, timer);
    }

    socket.data.roomCode = null;
    socket.data.username = null;
  });
});

// Only start listening when run directly, not when imported by tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    console.log(`WatchParty server running on port ${PORT}`);
  });
}

export { httpServer };
