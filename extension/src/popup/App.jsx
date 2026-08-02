import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./popup.css";
import { formatPlatformLabel, parseInviteLink } from "../lib/parseInviteLink.js";
import { DEFAULT_SERVER_URL } from "../lib/config.js";

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

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

// The service worker owns the list of user-approved sites, so platform
// resolution has to round-trip through it rather than parsing the URL here.
async function detectPlatformFromActiveTab() {
  const response = await sendMessage({ type: "POPUP_DETECT_PLATFORM" });
  return response?.platform || "";
}

function toServerOrigin(raw) {
  try {
    const parsed = new URL(String(raw || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function requestSitePermission(matchPattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: [matchPattern] }, (granted) => {
        resolve(!chrome.runtime.lastError && Boolean(granted));
      });
    } catch {
      resolve(false);
    }
  });
}


export default function App() {
  const [connectionState, setConnectionState] = useState("disconnected");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [offline, setOffline] = useState(false);

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [serverUrlInput, setServerUrlInput] = useState(DEFAULT_SERVER_URL);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const hasRequestedConnect = useRef(false);

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
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [isResyncing, setIsResyncing] = useState(false);
  const [resyncNotice, setResyncNotice] = useState("");

  const [siteAccess, setSiteAccess] = useState(null);
  const [isUpdatingSiteAccess, setIsUpdatingSiteAccess] = useState(false);

  const uiState = useMemo(() => {
    if (showServerSettings) return "setup";
    if (inRoom) return "in-room";
    return "lobby";
  }, [showServerSettings, inRoom]);

  const connectionStatusLabel = useMemo(() => {
    if (offline || connectionState === "offline") {
      return "Disconnected — creating or joining a room will reconnect";
    }
    if (connectionState === "connected" || connectionState === "reconnected") return "Connected";
    if (connectionState === "failed") return "Could not reach server";
    if (connectionState === "disconnected") return "Disconnected";
    return "Connecting...";
  }, [connectionState, offline]);

  const serverHostLabel = useMemo(() => {
    try {
      return new URL(serverUrl).hostname;
    } catch {
      return serverUrl;
    }
  }, [serverUrl]);

  const refreshSiteAccess = useCallback(async () => {
    const response = await sendMessage({ type: "POPUP_GET_SITE_ACCESS" });
    setSiteAccess(response);
  }, []);

  useEffect(() => {
    refreshSiteAccess();
  }, [refreshSiteAccess]);

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

  // No setup step: bring the stored (or hosted default) server online as soon as
  // the popup opens — unless the user previously disconnected on purpose.
  useEffect(() => {
    if (hasRequestedConnect.current) return;
    hasRequestedConnect.current = true;

    sendMessage({ type: "POPUP_ENSURE_CONNECTED" }).then((response) => {
      if (response?.serverUrl) {
        setServerUrl(response.serverUrl);
        setServerUrlInput(response.serverUrl);
      }
      if (response?.offline || response?.connectionState === "offline") {
        setOffline(true);
        setConnectionState("offline");
        return;
      }
      setOffline(false);
      setConnectionState((current) => (current === "connected" ? current : "connecting"));
    });
  }, []);

  useEffect(() => {
    if (uiState === "lobby" && pendingRoomCode) {
      setRoomCodeInput(pendingRoomCode);
    }
  }, [uiState]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyStateSnapshot(snapshot) {
    // serverUrlInput is deliberately left alone here so background state pushes
    // cannot overwrite what the user is typing in the server settings panel.
    if (snapshot.serverUrl) {
      setServerUrl(snapshot.serverUrl);
    }
    if (snapshot.offline != null) setOffline(Boolean(snapshot.offline));
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
    if (snapshot.pendingInvite?.roomCode && !snapshot.inRoom) {
      setPendingRoomCode(snapshot.pendingInvite.roomCode);
      setRoomCodeInput((current) => current || snapshot.pendingInvite.roomCode);
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

  function connectToServer(nextServerUrl) {
    chrome.runtime.sendMessage({ type: "POPUP_CONNECT", serverUrl: nextServerUrl });
    setServerUrl(nextServerUrl);
    setServerUrlInput(nextServerUrl);
    setConnectionState("connecting");
    setErrorText("");
  }

  function handleSaveServer() {
    const origin = toServerOrigin(serverUrlInput);
    if (!origin) {
      setErrorText("Enter a valid server URL, e.g. https://my-server.example.com");
      return;
    }
    connectToServer(origin);
    setShowServerSettings(false);
  }

  function handleUseDefaultServer() {
    connectToServer(DEFAULT_SERVER_URL);
    setShowServerSettings(false);
  }

  function handleRoomCodeInputChange(raw) {
    const parsed = parseInviteLink(raw);
    if (!parsed) {
      setRoomCodeInput(raw);
      return;
    }
    setRoomCodeInput(parsed.roomCode);
    if (parsed.serverUrl !== serverUrl) {
      connectToServer(parsed.serverUrl);
    }
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
    setResyncNotice("");
  }

  function handleDisconnect() {
    chrome.runtime.sendMessage({ type: "POPUP_DISCONNECT" });
    setOffline(true);
    setConnectionState("offline");
    setInRoom(false);
    setRoomCode("");
    setRoomCodeInput("");
    setMemberCount(0);
    setPlatform("");
    setAdBanner(null);
    setLastSync(null);
    setResyncNotice("");
    setErrorText("");
  }

  function handleOpenServerSettings() {
    setServerUrlInput(serverUrl || DEFAULT_SERVER_URL);
    setErrorText("");
    setShowServerSettings(true);
  }

  async function copyCode() {
    if (!roomCode) return;
    await navigator.clipboard.writeText(roomCode);
  }

  async function copyInviteLink() {
    if (!roomCode || !serverUrl) return;
    setIsCreatingInvite(true);
    setErrorText("");
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "POPUP_CREATE_INVITE" }, (result) => {
          resolve(result || {});
        });
      });
      if (!response?.ok || !response?.inviteUrl) {
        setErrorText(response?.message || "Could not create invite link right now.");
        return;
      }
      await navigator.clipboard.writeText(response.inviteUrl);
    } finally {
      setIsCreatingInvite(false);
    }
  }

  async function handleToggleSiteAccess() {
    if (!siteAccess?.canApprove || !siteAccess.origin) return;
    setIsUpdatingSiteAccess(true);
    setErrorText("");
    try {
      const enabling = !siteAccess.approved;
      if (enabling) {
        const granted = await requestSitePermission(siteAccess.matchPattern);
        if (!granted) {
          setErrorText("Chrome did not grant access to this site.");
          return;
        }
      }

      const result = await sendMessage({
        type: "POPUP_SET_SITE_ACCESS",
        origin: siteAccess.origin,
        enabled: enabling,
      });
      if (!result?.ok) {
        setErrorText(result?.message || "Could not update site access.");
        return;
      }
      await refreshSiteAccess();
    } finally {
      setIsUpdatingSiteAccess(false);
    }
  }

  async function handleResync() {
    setIsResyncing(true);
    setResyncNotice("");
    setErrorText("");
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "POPUP_RESYNC" }, (result) => {
          resolve(result || {});
        });
      });
      if (!response?.ok) {
        setErrorText(response?.message || "Could not re-establish sync right now.");
        return;
      }
      setResyncNotice("Resync requested. Refresh only if playback still does not sync.");
    } finally {
      setIsResyncing(false);
    }
  }

  return (
    <div className="popup-root">
      <header className="popup-header">
        <h1>Picnic</h1>
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
      {!!resyncNotice && <div className="banner banner--info">{resyncNotice}</div>}

      {uiState !== "in-room" && siteAccess?.canApprove && (
        <section className="site-card">
          {siteAccess.pendingInvite && !siteAccess.approved && (
            <p className="site-card__invite">
              Invite to room <strong>{siteAccess.pendingInvite.roomCode}</strong> on this site. Enable
              it to join.
            </p>
          )}
          <div className="site-card__row">
            <span className="site-card__host" title={siteAccess.hostname}>
              {siteAccess.hostname}
            </span>
            <span className={`site-card__badge ${siteAccess.approved ? "is-on" : ""}`}>
              {siteAccess.approved ? "Enabled" : "Not enabled"}
            </span>
          </div>
          <button className="btn" onClick={handleToggleSiteAccess} disabled={isUpdatingSiteAccess}>
            {isUpdatingSiteAccess
              ? "Updating..."
              : siteAccess.approved
                ? "Disable on this site"
                : "Enable on this site"}
          </button>
          <p className="helper">
            {siteAccess.approved
              ? "Picnic syncs the main video player on this site. Disabling also revokes its access."
              : "Grants Picnic access to this site so it can sync its video player. Use only for content you are allowed to watch."}
          </p>
        </section>
      )}

      {uiState === "setup" && (
        <section className="card">
          <label htmlFor="server-url">Server URL</label>
          <input
            id="server-url"
            placeholder="https://your-server.ngrok-free.app"
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
          {serverUrl !== DEFAULT_SERVER_URL && (
            <button className="btn" onClick={handleUseDefaultServer}>
              Use the Picnic server
            </button>
          )}
          <button className="link-btn" onClick={() => setShowServerSettings(false)}>
            Cancel
          </button>
          <p className="helper">
            Only needed if you run your own Picnic server. Everyone in a room must be on the same
            server.
          </p>
        </section>
      )}

      {uiState === "lobby" && (
        <section className="card">
          <div className="status-row">
            <span
              className={`dot ${
                !offline && (connectionState === "connected" || connectionState === "reconnected")
                  ? "online"
                  : "offline"
              }`}
            />
            <span>{connectionStatusLabel}</span>
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
          <div className="divider">or</div>
          <div className="field">
            <label htmlFor="room-code-input">Room code or invite link</label>
            <input
              id="room-code-input"
              type="text"
              placeholder="ABC123"
              value={roomCodeInput}
              onChange={(e) => handleRoomCodeInputChange(e.target.value)}
            />
          </div>
          <button className="btn" onClick={handleJoinRoom} disabled={!roomCodeInput.trim()}>
            Join Room
          </button>
          <button className="link-btn" onClick={handleOpenServerSettings}>
            {serverUrl === DEFAULT_SERVER_URL ? "Use a custom server" : `Server: ${serverHostLabel}`}
          </button>
        </section>
      )}

      {uiState === "in-room" && (
        <section className="card">
          <button className="btn" onClick={copyInviteLink} disabled={isCreatingInvite}>
            {isCreatingInvite ? "Preparing Invite..." : "Copy Invite Link"}
          </button>
          <p className="room__username">
            Watching as <strong>{username}</strong>
          </p>
          <div className="meta">🌐 Room platform: {formatPlatformLabel(platform)}</div>
          <div className="meta">👥 {memberCount} in room</div>
          <div className="sync-pill">{formatAction(lastSync)}</div>
          {memberCount > 1 && (
            <div className="resync-card">
              <p className="resync-card__text">
                If a new member joined but playback/chat did not sync, use this recovery action first.
              </p>
              <button className="btn" onClick={handleResync} disabled={isResyncing}>
                {isResyncing ? "Re-establishing..." : "Re-establish Sync & Chat"}
              </button>
            </div>
          )}
          <button className="btn danger-outline" onClick={handleLeaveRoom}>
            Leave Room
          </button>
          <button className="btn danger-outline" onClick={handleDisconnect}>
            Disconnect
          </button>
          <p className="helper">
            Leave Room returns to the lobby while staying connected. Disconnect goes fully offline
            and disables chat until you create or join again.
          </p>
        </section>
      )}
    </div>
  );
}
