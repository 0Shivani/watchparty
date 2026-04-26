import { io } from "socket.io-client";

let socket = null;
let reconnectManager = null;

function toServiceWorker(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload });
}

function connectSocket(serverUrl) {
  if (socket?.connected) return;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.4,
    timeout: 10000,
  });

  reconnectManager = socket.io;

  socket.on("connect", () => {
    toServiceWorker("SOCKET_STATE", { state: "connected" });
  });

  socket.on("disconnect", () => {
    toServiceWorker("SOCKET_STATE", { state: "disconnected" });
  });

  reconnectManager.on("reconnect_attempt", (attempt) => {
    toServiceWorker("SOCKET_STATE", { state: "reconnecting", attempt });
  });

  reconnectManager.on("reconnect", () => {
    toServiceWorker("SOCKET_STATE", { state: "reconnected" });
  });

  reconnectManager.on("reconnect_failed", () => {
    toServiceWorker("SOCKET_STATE", { state: "failed" });
  });

  socket.on("room-created", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "room-created", payload });
  });

  socket.on("room-joined", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "room-joined", payload });
  });

  socket.on("room-error", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "room-error", payload });
  });

  socket.on("member-update", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "member-update", payload });
  });

  socket.on("sync-event", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "sync-event", payload });
  });

  socket.on("ad-started", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "ad-started", payload });
  });

  socket.on("ad-ended", () => {
    toServiceWorker("SOCKET_EVENT", { event: "ad-ended", payload: {} });
  });

  socket.on("chat-message", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "chat-message", payload });
  });
}

function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    reconnectManager = null;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "OFFSCREEN_CONNECT":
      connectSocket(message.serverUrl);
      break;

    case "OFFSCREEN_DISCONNECT":
      disconnectSocket();
      break;

    case "OFFSCREEN_EMIT":
      if (socket?.connected) {
        socket.emit(message.event, message.payload);
      }
      break;

    case "OFFSCREEN_AUTO_REJOIN":
      if (socket?.connected && message.roomCode) {
        socket.emit("join-room", {
          roomCode: message.roomCode,
          username: message.username,
        });
      }
      break;
  }
});
