import { io } from "socket.io-client";

let socket = null;
let reconnectManager = null;
let currentServerUrl = "";

function toServiceWorker(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload });
}

function isNgrokUrl(serverUrl) {
  try {
    const { hostname } = new URL(serverUrl);
    return (
      hostname.endsWith(".ngrok-free.app") ||
      hostname.endsWith(".ngrok-free.dev") ||
      hostname.endsWith(".ngrok.app") ||
      hostname.endsWith(".ngrok.io")
    );
  } catch {
    return false;
  }
}

function connectSocket(serverUrl) {
  if (!serverUrl) return;
  if (socket?.connected && currentServerUrl === serverUrl) {
    // The worker may have restarted and lost its view of the connection.
    toServiceWorker("SOCKET_STATE", { state: "connected" });
    return;
  }

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  const socketOptions = {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.4,
    timeout: 10000,
  };

  // ngrok free tunnels can block Socket.IO polling from browser clients.
  // WebSocket-only transport avoids the warning/interstitial path.
  if (isNgrokUrl(serverUrl)) {
    socketOptions.transports = ["websocket"];
  }

  socket = io(serverUrl, socketOptions);
  currentServerUrl = serverUrl;

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

  socket.on("connect_error", (error) => {
    toServiceWorker("SOCKET_STATE", {
      state: "reconnecting",
      error: error?.message || "Connection failed",
    });
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

  socket.on("ad-ended", (payload) => {
    toServiceWorker("SOCKET_EVENT", { event: "ad-ended", payload: payload || {} });
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
    currentServerUrl = "";
  }
}

async function leaveAndDisconnect(roomCode = "") {
  if (socket?.connected && roomCode) {
    socket.emit("leave-room", { roomCode });
    // Brief flush so the leave-room packet can leave before the socket drops.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  disconnectSocket();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "OFFSCREEN_CONNECT":
      connectSocket(message.serverUrl);
      break;

    case "OFFSCREEN_DISCONNECT":
      leaveAndDisconnect(message.roomCode || "")
        .then(() => sendResponse({ ok: true }))
        .catch(() => {
          disconnectSocket();
          sendResponse({ ok: true });
        });
      return true;

    case "OFFSCREEN_EMIT":
      if (socket?.connected) {
        socket.emit(message.event, message.payload);
      }
      break;

    case "OFFSCREEN_EMIT_WITH_ACK":
      if (socket?.connected) {
        socket.emit(message.event, message.payload, (response) => {
          toServiceWorker("OFFSCREEN_ACK", {
            requestId: message.requestId,
            response: response || {},
          });
        });
      } else {
        toServiceWorker("OFFSCREEN_ACK", {
          requestId: message.requestId,
          response: { ok: false, message: "Socket is not connected." },
        });
      }
      break;

    case "OFFSCREEN_AUTO_REJOIN":
      if (socket?.connected && message.roomCode) {
        socket.emit("join-room", {
          roomCode: message.roomCode,
          username: message.username,
          platform: message.platform,
        });
      }
      break;
  }
});
