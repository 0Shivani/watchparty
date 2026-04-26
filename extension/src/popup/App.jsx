import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./popup.css";

const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
  username: "username",
};

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatAction(action) {
  if (!action) return "Waiting for sync activity";
  const labelByType = {
    play: "play",
    pause: "paused",
    seek: "seeked",
  };
  return `${labelByType[action.type] || action.type} at ${formatTime(action.currentTime)}`;
}

export default function App() {
  const socketRef = useRef(null);
  const connectingRef = useRef(false);
  const autoRejoinInFlightRef = useRef(false);
  const latestSessionRef = useRef({
    serverUrl: "",
    roomCode: "",
    inRoom: false,
    username: "",
  });

  const [serverUrlInput, setServerUrlInput] = useState("");
  const [savedServerUrl, setSavedServerUrl] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [memberCount, setMemberCount] = useState(1);
  const [lastAction, setLastAction] = useState(null);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [expiredBanner, setExpiredBanner] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [adBanner, setAdBanner] = useState(null);

  const uiState = useMemo(() => {
    if (!savedServerUrl) return "setup";
    if (inRoom) return "in-room";
    return "lobby";
  }, [savedServerUrl, inRoom]);

  useEffect(() => {
    latestSessionRef.current = {
      serverUrl: savedServerUrl,
      roomCode,
      inRoom,
      username,
    };
  }, [savedServerUrl, roomCode, inRoom, username]);

  async function persistSession(next) {
    let resolvedUsername = next.username;
    if (resolvedUsername == null) {
      const stored = await chrome.storage.local.get([STORAGE_KEYS.username]);
      resolvedUsername = stored[STORAGE_KEYS.username] ?? latestSessionRef.current.username;
    }

    await chrome.runtime.sendMessage({
      type: "SET_SESSION_STATE",
      payload: {
        serverUrl: next.serverUrl ?? latestSessionRef.current.serverUrl,
        roomCode: next.roomCode ?? latestSessionRef.current.roomCode,
        inRoom: next.inRoom ?? latestSessionRef.current.inRoom,
        username: String(resolvedUsername || "").trim(),
      },
    });
  }

  async function autoRejoinRoom() {
    const socket = socketRef.current;
    if (!socket?.connected) return;

    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.roomCode,
      STORAGE_KEYS.inRoom,
      STORAGE_KEYS.username,
    ]);

    if (!stored[STORAGE_KEYS.inRoom] || !stored[STORAGE_KEYS.roomCode]) {
      setConnectionState("connected");
      return;
    }

    const storedRoomCode = String(stored[STORAGE_KEYS.roomCode] || "")
      .toUpperCase()
      .trim();
    if (!storedRoomCode) {
      setConnectionState("connected");
      return;
    }

    const onRoomJoined = () => {
      autoRejoinInFlightRef.current = false;
      socket.off("room-error", onRoomError);
      setConnectionState("connected");
      setReconnectAttempt(0);
      setExpiredBanner(false);
      setErrorText("");
    };

    const onRoomError = async () => {
      autoRejoinInFlightRef.current = false;
      socket.off("room-joined", onRoomJoined);
      setConnectionState("connected");
      setRoomCode("");
      setInRoom(false);
      setReconnectAttempt(0);
      setErrorText("");
      await chrome.storage.local.set({
        [STORAGE_KEYS.roomCode]: "",
        [STORAGE_KEYS.inRoom]: false,
      });
      setExpiredBanner(true);
      setTimeout(() => setExpiredBanner(false), 5000);
    };

    autoRejoinInFlightRef.current = true;
    socket.emit("join-room", {
      roomCode: storedRoomCode,
      username: String(stored[STORAGE_KEYS.username] || username || "").trim(),
    });
    socket.once("room-joined", onRoomJoined);
    socket.once("room-error", onRoomError);
  }

  function bindSocket(socket) {
    const manager = socket.io;

    socket.on("connect", () => {
      setConnectionState("connected");
      setReconnectAttempt(0);
      setErrorText("");
    });

    socket.on("disconnect", () => {
      setConnectionState("disconnected");
    });

    manager.on("reconnect_attempt", (attempt) => {
      setConnectionState("reconnecting");
      setReconnectAttempt(attempt);
    });
    // In socket.io-client v4, reconnection lifecycle events (reconnect_attempt,
    // reconnect, reconnect_failed) are emitted by the Manager, not the Socket instance.
    manager.on("reconnect", () => {
      setConnectionState("rejoining");
      void autoRejoinRoom();
    });

    manager.on("reconnect_failed", () => {
      setConnectionState("failed");
    });

    socket.on("sync-event", async ({ action }) => {
      setLastAction(action);
      await chrome.runtime.sendMessage({ type: "APPLY_SYNC", action });
    });

    socket.on("room-created", async ({ roomCode: createdRoomCode }) => {
      setRoomCode(createdRoomCode);
      setInRoom(true);
      setMemberCount(1);
      await persistSession({ roomCode: createdRoomCode, inRoom: true });
    });

    socket.on("room-joined", async ({ roomCode: joinedRoomCode, memberCount: count }) => {
      setRoomCode(joinedRoomCode);
      setInRoom(true);
      setMemberCount(count);
      setConnectionState("connected");
      setReconnectAttempt(0);
      setExpiredBanner(false);
      setErrorText("");
      await persistSession({ roomCode: joinedRoomCode, inRoom: true });
    });

    socket.on("member-update", ({ memberCount: count }) => {
      setMemberCount(count);
    });

    socket.on("chat-message", ({ username: fromUser, text, timestamp }) => {
      chrome.runtime.sendMessage({
        type: "INCOMING_CHAT",
        payload: { username: fromUser, text, timestamp },
      });
    });

    socket.on("ad-started", ({ username: eventUsername }) => {
      setAdBanner({ username: eventUsername || "A user" });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: "APPLY_SYNC",
            action: { type: "pause", currentTime: null },
          });
        }
      });
    });

    socket.on("ad-ended", () => {
      setAdBanner(null);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: "APPLY_SYNC",
            action: { type: "play", currentTime: null },
          });
        }
      });
    });

    socket.on("room-error", ({ message }) => {
      if (autoRejoinInFlightRef.current) return;
      setErrorText(message || "Something went wrong.");
    });
  }

  function connectSocket(url) {
    if (!url || connectingRef.current) return;
    if (socketRef.current?.connected || socketRef.current?.active) return;

    connectingRef.current = true;
    const socket = io(url, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.4,
      timeout: 10000,
    });
    socketRef.current = socket;
    bindSocket(socket);
    connectingRef.current = false;
  }

  useEffect(() => {
    let mounted = true;

    chrome.storage.local
      .get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.roomCode, STORAGE_KEYS.inRoom, STORAGE_KEYS.username])
      .then((data) => {
        if (!mounted) return;
        const restoredUrl = String(data[STORAGE_KEYS.serverUrl] || "");
        const restoredRoom = String(data[STORAGE_KEYS.roomCode] || "");
        const restoredInRoom = Boolean(data[STORAGE_KEYS.inRoom]);
        const restoredUsername = String(data[STORAGE_KEYS.username] || "");
        setSavedServerUrl(restoredUrl);
        setServerUrlInput(restoredUrl);
        setRoomCode(restoredRoom);
        setInRoom(restoredInRoom);
        setUsername(restoredUsername);
        if (restoredUrl) connectSocket(restoredUrl);
      });

    const onMessage = (message) => {
      if (message.type === "LOCAL_EVENT") {
        if (!socketRef.current || !inRoom || !roomCode) return;

        socketRef.current.emit("sync-event", {
          roomCode,
          action: message.action,
        });
        setLastAction(message.action);
        return;
      }

      if (message.type === "AD_STARTED") {
        if (!socketRef.current?.connected || !inRoom || !roomCode) return;
        chrome.storage.local.get([STORAGE_KEYS.roomCode]).then((stored) => {
          socketRef.current?.emit("ad-started", { roomCode: stored[STORAGE_KEYS.roomCode] });
        });
        return;
      }

      if (message.type === "AD_ENDED") {
        if (!socketRef.current?.connected || !inRoom || !roomCode) return;
        chrome.storage.local.get([STORAGE_KEYS.roomCode]).then((stored) => {
          socketRef.current?.emit("ad-ended", { roomCode: stored[STORAGE_KEYS.roomCode] });
        });
        return;
      }

      if (message.type === "CHAT_SEND") {
        if (!socketRef.current?.connected || !inRoom || !roomCode) return;
        chrome.storage.local.get([STORAGE_KEYS.roomCode], (stored) => {
          socketRef.current?.emit("chat-message", {
            roomCode: stored[STORAGE_KEYS.roomCode],
            text: message.payload?.text,
          });
        });
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [inRoom, roomCode]);

  async function saveAndConnect() {
    const normalized = serverUrlInput.trim();
    if (!normalized) {
      setErrorText("Please enter a server URL.");
      return;
    }

    setSavedServerUrl(normalized);
    setErrorText("");
    await chrome.storage.local.set({ [STORAGE_KEYS.serverUrl]: normalized });
    await persistSession({ serverUrl: normalized });
    connectSocket(normalized);
  }

  function validateUsername() {
    const normalized = String(username || "").trim();
    if (!normalized || normalized.length < 1) {
      setUsernameError("Please enter a display name.");
      return false;
    }
    if (normalized.length > 20) {
      setUsernameError("Max 20 characters.");
      return false;
    }
    return true;
  }

  async function createRoom() {
    if (!socketRef.current?.connected) {
      setErrorText("Not connected to server.");
      return;
    }
    if (!validateUsername()) return;
    setErrorText("");
    const normalizedUsername = username.trim();
    await chrome.storage.local.set({ [STORAGE_KEYS.username]: normalizedUsername });
    socketRef.current.emit("create-room", { username: normalizedUsername });
  }

  async function joinRoom() {
    const normalized = joinCodeInput.trim().toUpperCase();
    if (normalized.length !== 6) {
      setErrorText("Room code must be 6 characters.");
      return;
    }
    if (!socketRef.current?.connected) {
      setErrorText("Not connected to server.");
      return;
    }
    if (!validateUsername()) return;

    setErrorText("");
    const normalizedUsername = username.trim();
    await chrome.storage.local.set({ [STORAGE_KEYS.username]: normalizedUsername });
    socketRef.current.emit("join-room", { roomCode: normalized, username: normalizedUsername });
  }

  async function leaveRoom() {
    if (socketRef.current?.connected && roomCode) {
      socketRef.current.emit("leave-room", { roomCode });
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setConnectionState("disconnected");
    setReconnectAttempt(0);
    setInRoom(false);
    setRoomCode("");
    setJoinCodeInput("");
    setMemberCount(1);
    setAdBanner(null);
    await chrome.runtime.sendMessage({ type: "CLEAR_ROOM_STATE" });
    if (savedServerUrl) connectSocket(savedServerUrl);
  }

  async function changeServer() {
    if (socketRef.current?.connected) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setSavedServerUrl("");
    setServerUrlInput("");
    setInRoom(false);
    setRoomCode("");
    setJoinCodeInput("");
    setMemberCount(1);
    setLastAction(null);
    setErrorText("");
    setConnectionState("disconnected");
    setReconnectAttempt(0);
    setExpiredBanner(false);
    setAdBanner(null);
    await chrome.storage.local.set({
      [STORAGE_KEYS.serverUrl]: "",
      [STORAGE_KEYS.roomCode]: "",
      [STORAGE_KEYS.inRoom]: false,
    });
    await chrome.runtime.sendMessage({ type: "CLEAR_ROOM_STATE" });
  }

  async function copyCode() {
    if (!roomCode) return;
    await navigator.clipboard.writeText(roomCode);
  }

  return (
    <div className="popup-root">
      <header className="popup-header">
        <h1>WatchParty</h1>
      </header>

      {uiState === "in-room" && adBanner && (
        <div className="banner banner--ad">
          <span>📺</span>
          <span>
            <strong>{adBanner.username}</strong>
            {"'s account is playing an ad. Playback paused."}
          </span>
        </div>
      )}

      {connectionState === "reconnecting" && (
        <div className="banner banner--warning">
          <span className="spinner" />
          Reconnecting... (attempt {reconnectAttempt})
        </div>
      )}

      {connectionState === "rejoining" && (
        <div className="banner banner--warning">
          <span className="spinner" />
          Back online - rejoining room...
        </div>
      )}

      {expiredBanner && (
        <div className="banner banner--error">
          Your room expired while offline. Create or join a new room.
          <button onClick={() => setExpiredBanner(false)}>X</button>
        </div>
      )}

      {!!errorText && <div className="banner banner--error">{errorText}</div>}

      {uiState === "setup" && (
        <section className="card">
          <label htmlFor="server-url">Server URL</label>
          <input
            id="server-url"
            placeholder="http://localhost:3001"
            value={serverUrlInput}
            onChange={(e) => setServerUrlInput(e.target.value)}
          />
          <button className="btn primary" onClick={saveAndConnect}>
            Save & Connect
          </button>
          <p className="helper">Run the server locally or paste your ngrok URL.</p>
        </section>
      )}

      {uiState === "lobby" && (
        <section className="card">
          <div className="status-row">
            <span className={`dot ${connectionState === "connected" ? "online" : "offline"}`} />
            <span>{connectionState === "connected" ? "Connected" : "Disconnected"}</span>
          </div>
          <div className="field">
            <label htmlFor="username-input">Your display name</label>
            <input
              id="username-input"
              type="text"
              maxLength={20}
              placeholder="e.g. Shivani"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value.trim());
                setUsernameError("");
              }}
            />
            {usernameError && <span className="field__error">{usernameError}</span>}
          </div>
          <button className="btn primary" onClick={createRoom}>
            Create Room
          </button>

          <div className="divider">or</div>

          <input
            placeholder="ROOM12"
            maxLength={6}
            value={joinCodeInput}
            onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
          />
          <button className="btn" onClick={joinRoom}>
            Join Room
          </button>

          <button className="link-btn" onClick={changeServer}>
            Change server
          </button>
        </section>
      )}

      {uiState === "in-room" && (
        <section className="card">
          <div className="room-code-row">
            <div className="room-code">{roomCode}</div>
            <button className="icon-btn" onClick={copyCode} title="Copy room code">
              📋
            </button>
          </div>
          <p className="room__username">
            Watching as <strong>{username}</strong>
          </p>
          <div className="meta">👥 {memberCount} in room</div>
          <div className="sync-pill">{formatAction(lastAction)}</div>
          <button className="btn danger-outline" onClick={leaveRoom}>
            Leave Room
          </button>
        </section>
      )}
    </div>
  );
}
