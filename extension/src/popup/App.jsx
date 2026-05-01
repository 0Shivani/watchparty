import { useEffect, useMemo, useState } from "react";
import "./popup.css";
import { parseInviteLink } from "../lib/parseInviteLink.js";

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

function getPlatformFromUrl(url) {
  if (!url) return "";
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("youtube.com")) return "youtube";
    if (hostname.includes("netflix.com")) return "netflix";
    if (hostname.includes("primevideo.com")) return "primevideo";
    if (hostname.includes("hotstar.com")) return "hotstar";
    return "";
  } catch {
    return "";
  }
}

function detectPlatformFromActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve("");
          return;
        }
        resolve(getPlatformFromUrl(tabs?.[0]?.url));
      });
    } catch {
      resolve("");
    }
  });
}

function formatPlatform(platform) {
  const labels = {
    youtube: "YouTube",
    netflix: "Netflix",
    primevideo: "Prime Video",
    hotstar: "JioHotstar",
  };
  return labels[String(platform || "").toLowerCase()] || "Unknown";
}


export default function App() {
  const [connectionState, setConnectionState] = useState("disconnected");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const [serverUrl, setServerUrl] = useState("");
  const [serverUrlInput, setServerUrlInput] = useState("");

  const [roomCode, setRoomCode] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [pendingRoomCode, setPendingRoomCode] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [memberCount, setMemberCount] = useState(0);
  const [platform, setPlatform] = useState("");

  const [username, setUsername] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [usernameError, setUsernameError] = useState("");

  const [errorText, setErrorText] = useState("");
  const [expiredBanner, setExpiredBanner] = useState(false);
  const [adBanner, setAdBanner] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  const uiState = useMemo(() => {
    if (!serverUrl) return "setup";
    if (inRoom) return "in-room";
    return "lobby";
  }, [serverUrl, inRoom]);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "POPUP_GET_STATE" }, (response) => {
      if (response?.sessionState) {
        applyStateSnapshot(response.sessionState);
      }
    });

    const listener = (message) => {
      if (message.type === "STATE_UPDATE") {
        applyStateSnapshot(message.sessionState || {});
        if (message.socketEvent) {
          handleSocketEvent(message.socketEvent);
        }
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (uiState === "lobby" && pendingRoomCode) {
      setRoomCodeInput(pendingRoomCode);
    }
  }, [uiState]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyStateSnapshot(snapshot) {
    if (snapshot.serverUrl != null) {
      setServerUrl(snapshot.serverUrl);
      setServerUrlInput(snapshot.serverUrl);
    }
    if (snapshot.connectionState != null) setConnectionState(snapshot.connectionState);
    if (snapshot.reconnectAttempt != null) setReconnectAttempt(snapshot.reconnectAttempt);
    if (snapshot.roomCode != null) {
      setRoomCode(snapshot.roomCode);
    }
    if (snapshot.inRoom != null) setInRoom(Boolean(snapshot.inRoom));
    if (snapshot.memberCount != null) setMemberCount(snapshot.memberCount);
    if (snapshot.platform != null) setPlatform(snapshot.platform);
    if (snapshot.username != null) {
      setUsername(snapshot.username);
    }
  }

  function handleSocketEvent({ event, payload }) {
    if (event === "room-created") {
      const createdCode = payload?.roomCode || "";
      const activeUsername = usernameInput.trim() || username.trim();
      setRoomCode(createdCode);
      setRoomCodeInput(createdCode);
      setUsername(activeUsername);
      setInRoom(true);
      setPlatform(payload?.platform || "");
      setErrorText("");
      chrome.runtime.sendMessage({
        type: "POPUP_JOINED_ROOM",
        roomCode: createdCode,
        username: activeUsername,
        platform: payload?.platform || "",
      });
      return;
    }

    if (event === "room-joined") {
      const joinedCode = payload?.roomCode || "";
      const activeUsername = usernameInput.trim() || username.trim();
      setRoomCode(joinedCode);
      setRoomCodeInput(joinedCode);
      setUsername(activeUsername);
      setInRoom(true);
      setMemberCount(payload?.memberCount || 0);
      setPlatform(payload?.platform || "");
      setErrorText("");
      chrome.runtime.sendMessage({
        type: "POPUP_JOINED_ROOM",
        roomCode: joinedCode,
        username: activeUsername,
        platform: payload?.platform || "",
      });
      return;
    }

    if (event === "room-error") {
      const lower = String(payload?.message || "").toLowerCase();
      if (lower.includes("not found") || lower.includes("expired")) {
        setExpiredBanner(true);
        setTimeout(() => setExpiredBanner(false), 5000);
        setInRoom(false);
        setRoomCode("");
        setRoomCodeInput("");
        setPlatform("");
      } else {
        setErrorText(payload?.message || "An error occurred.");
      }
      return;
    }

    if (event === "member-update") {
      setMemberCount(payload?.memberCount || 0);
      return;
    }

    if (event === "sync-event") {
      setLastSync(payload?.action || null);
      return;
    }

    if (event === "ad-started") {
      setAdBanner({ username: payload?.username || "A user" });
      return;
    }

    if (event === "ad-ended") {
      setAdBanner(null);
    }
  }

  function validateUsername() {
    const normalized = String(usernameInput || "").trim();
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

  function handleSaveServer() {
    if (!serverUrlInput.trim()) return;
    const normalizedServerUrl = serverUrlInput.trim();
    chrome.runtime.sendMessage({
      type: "POPUP_CONNECT",
      serverUrl: normalizedServerUrl,
    });
    setServerUrl(normalizedServerUrl);
    setConnectionState("connecting");
    setErrorText("");
  }

  async function handleCreateRoom() {
    if (!validateUsername()) return;
    const normalizedUsername = usernameInput.trim();
    const detectedPlatform = await detectPlatformFromActiveTab();
    setUsername(normalizedUsername);
    setUsernameError("");
    setErrorText("");
    chrome.runtime.sendMessage({
      type: "POPUP_EMIT",
      event: "create-room",
      payload: {
        username: normalizedUsername,
        ...(detectedPlatform ? { platform: detectedPlatform } : {}),
      },
    });
  }

  async function handleJoinRoom() {
    if (!validateUsername()) return;
    if (!roomCodeInput.trim()) return;
    const normalizedUsername = usernameInput.trim();
    const detectedPlatform = await detectPlatformFromActiveTab();
    setUsername(normalizedUsername);
    setUsernameError("");
    setErrorText("");
    chrome.runtime.sendMessage({
      type: "POPUP_EMIT",
      event: "join-room",
      payload: {
        roomCode: roomCodeInput.toUpperCase().trim(),
        username: normalizedUsername,
        ...(detectedPlatform ? { platform: detectedPlatform } : {}),
      },
    });
  }

  function handleLeaveRoom() {
    chrome.runtime.sendMessage({
      type: "POPUP_EMIT",
      event: "leave-room",
      payload: { roomCode },
    });
    chrome.runtime.sendMessage({ type: "POPUP_LEFT_ROOM" });
    setInRoom(false);
    setRoomCode("");
    setRoomCodeInput("");
    setMemberCount(0);
    setPlatform("");
    setAdBanner(null);
    setLastSync(null);
  }

  function handleChangeServer() {
    chrome.runtime.sendMessage({ type: "POPUP_DISCONNECT" });
    setServerUrl("");
    setServerUrlInput("");
    setConnectionState("disconnected");
    setReconnectAttempt(0);
    setInRoom(false);
    setRoomCode("");
    setRoomCodeInput("");
    setMemberCount(0);
    setPlatform("");
    setLastSync(null);
    setErrorText("");
    setExpiredBanner(false);
    setAdBanner(null);
    setUsernameError("");
  }

  async function copyCode() {
    if (!roomCode) return;
    await navigator.clipboard.writeText(roomCode);
  }

  async function copyInviteLink() {
    if (!roomCode || !serverUrl) return;
    await navigator.clipboard.writeText(`${serverUrl}?room=${roomCode}`);
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

      {connectionState === "reconnected" && (
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
          <label htmlFor="server-url">Invite Link</label>
          <input
            id="server-url"
            placeholder="https://your-server.ngrok-free.app?room=ABC123"
            value={serverUrlInput}
            onChange={(e) => {
              const raw = e.target.value;
              const parsed = parseInviteLink(raw);
              if (parsed) {
                setServerUrlInput(parsed.serverUrl);
                setPendingRoomCode(parsed.roomCode);
              } else {
                setServerUrlInput(raw);
                setPendingRoomCode("");
              }
            }}
          />
          <button className="btn primary" onClick={handleSaveServer}>
            Save & Connect
          </button>
          <p className="helper">Hosts: paste just your server URL. Guests: paste the full invite link.</p>
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
              value={usernameInput}
              onChange={(e) => {
                setUsernameInput(e.target.value);
                setUsernameError("");
              }}
            />
            {usernameError && <span className="field__error">{usernameError}</span>}
          </div>
          <button className="btn primary" onClick={handleCreateRoom}>
            Create Room
          </button>
          {pendingRoomCode && (
            <>
              <div className="divider">or</div>
              <button className="btn" onClick={handleJoinRoom}>
                Join Room
              </button>
            </>
          )}
          <button className="link-btn" onClick={handleChangeServer}>
            Change server
          </button>
        </section>
      )}

      {uiState === "in-room" && (
        <section className="card">
          <button className="btn" onClick={copyInviteLink}>
            Copy Invite Link
          </button>
          <p className="room__username">
            Watching as <strong>{username}</strong>
          </p>
          <div className="meta">🌐 Room platform: {formatPlatform(platform)}</div>
          <div className="meta">👥 {memberCount} in room</div>
          <div className="sync-pill">{formatAction(lastSync)}</div>
          <button className="btn danger-outline" onClick={handleLeaveRoom}>
            Leave Room
          </button>
        </section>
      )}
    </div>
  );
}
