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
});

const rooms = new Map();

function safePayload(data) {
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
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

function removeSocketFromRoom(socketId, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.members.delete(socketId);

  if (room.members.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (room.hostId === socketId) {
    room.hostId = room.members.values().next().value;
  }

  emitMemberUpdate(roomCode);
}

function leaveCurrentRoom(socket, roomsMap) {
  const currentRoomCode = socket.data.roomCode;
  if (!currentRoomCode) return;

  const room = roomsMap.get(currentRoomCode);
  if (room) {
    socket.leave(currentRoomCode);
    removeSocketFromRoom(socket.id, currentRoomCode);
  }

  socket.data.roomCode = null;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});

io.on("connection", (socket) => {
  socket.data.roomCode = null;

  socket.on("create-room", () => {
    leaveCurrentRoom(socket, rooms);
    const roomCode = createUniqueRoomCode();
    rooms.set(roomCode, { hostId: socket.id, members: new Set([socket.id]) });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.emit("room-created", { roomCode });
    socket.emit("room-joined", { roomCode, memberCount: 1 });
    emitMemberUpdate(roomCode);
  });

  socket.on("join-room", (rawData) => {
    const { roomCode } = safePayload(rawData);
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
    socket.join(normalizedCode);
    socket.data.roomCode = normalizedCode;

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

  socket.on("leave-room", (rawData) => {
    const { roomCode } = safePayload(rawData);
    const normalizedCode = String(roomCode || socket.data.roomCode || "")
      .toUpperCase()
      .trim();
    if (!normalizedCode) return;

    socket.leave(normalizedCode);
    removeSocketFromRoom(socket.id, normalizedCode);
    if (socket.data.roomCode === normalizedCode) {
      socket.data.roomCode = null;
    }
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket, rooms);
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
