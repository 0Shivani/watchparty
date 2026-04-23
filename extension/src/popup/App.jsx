import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./popup.css";

const STORAGE_KEYS = {
  serverUrl: "serverUrl",
  roomCode: "roomCode",
  inRoom: "inRoom",
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

  const [serverUrlInput, setServerUrlInput] = useState("");
  const [savedServerUrl, setSavedServerUrl] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [memberCount, setMemberCount] = useState(1);
  const [lastAction, setLastAction] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [inRoom, setInRoom] = useState(false);

  const uiState = useMemo(() => {
    if (!savedServerUrl) return "setup";
    if (isReconnecting) return "error";
    if (inRoom) return "in-room";
    return "lobby";
  }, [savedServerUrl, isReconnecting, inRoom]);

  async function persistSession(next) {
    await chrome.runtime.sendMessage({
      type: "SET_SESSION_STATE",
      payload: {
        serverUrl: next.serverUrl ?? savedServerUrl,
        roomCode: next.roomCode ?? roomCode,
        inRoom: next.inRoom ?? inRoom,
      },
    });
  }

  function bindSocket(socket) {
    socket.on("connect", () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setErrorText("");
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
      if (savedServerUrl) {
        setIsReconnecting(true);
      }
    });

    socket.on("reconnect", () => {
      setIsConnected(true);
      setIsReconnecting(false);
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
      setErrorText("");
      await persistSession({ roomCode: joinedRoomCode, inRoom: true });
    });

    socket.on("member-update", ({ memberCount: count }) => {
      setMemberCount(count);
    });

    socket.on("room-error", ({ message }) => {
      setErrorText(message || "Something went wrong.");
    });
  }

  function connectSocket(url) {
    if (!url || connectingRef.current) return;
    if (socketRef.current?.connected || socketRef.current?.active) return;

    connectingRef.current = true;
    const socket = io(url, {
      transports: ["websocket"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;
    bindSocket(socket);
    connectingRef.current = false;
  }

  useEffect(() => {
    let mounted = true;

    chrome.storage.local
      .get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.roomCode, STORAGE_KEYS.inRoom])
      .then((data) => {
        if (!mounted) return;
        const restoredUrl = String(data[STORAGE_KEYS.serverUrl] || "");
        const restoredRoom = String(data[STORAGE_KEYS.roomCode] || "");
        const restoredInRoom = Boolean(data[STORAGE_KEYS.inRoom]);
        setSavedServerUrl(restoredUrl);
        setServerUrlInput(restoredUrl);
        setRoomCode(restoredRoom);
        setInRoom(restoredInRoom);
        if (restoredUrl) connectSocket(restoredUrl);
      });

    const onMessage = (message) => {
      if (message.type !== "LOCAL_EVENT") return;
      if (!socketRef.current || !inRoom || !roomCode) return;

      socketRef.current.emit("sync-event", {
        roomCode,
        action: message.action,
      });
      setLastAction(message.action);
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

  function createRoom() {
    if (!socketRef.current?.connected) {
      setErrorText("Not connected to server.");
      return;
    }
    setErrorText("");
    socketRef.current.emit("create-room");
  }

  function joinRoom() {
    const normalized = joinCodeInput.trim().toUpperCase();
    if (normalized.length !== 6) {
      setErrorText("Room code must be 6 characters.");
      return;
    }
    if (!socketRef.current?.connected) {
      setErrorText("Not connected to server.");
      return;
    }

    setErrorText("");
    socketRef.current.emit("join-room", { roomCode: normalized });
  }

  async function leaveRoom() {
    if (socketRef.current?.connected && roomCode) {
      socketRef.current.emit("leave-room", { roomCode });
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setInRoom(false);
    setRoomCode("");
    setJoinCodeInput("");
    setMemberCount(1);
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
    setIsConnected(false);
    setIsReconnecting(false);
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

      {uiState === "error" ? (
        <div className="banner warning">
          <div className="spinner" />
          <span>Connection lost. Reconnecting...</span>
        </div>
      ) : null}

      {!!errorText && <div className="banner error">{errorText}</div>}

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
            <span className={`dot ${isConnected ? "online" : "offline"}`} />
            <span>{isConnected ? "Connected" : "Disconnected"}</span>
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
