# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Extension (Chrome MV3 + React + Vite)
```bash
cd extension
npm run dev      # watch-mode dev build
npm run build    # production build → extension/dist/
npm test         # Vitest unit tests (jsdom environment)
```
Load the unpacked extension from `extension/dist/` in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

### Server (Node.js + Express + Socket.io)
```bash
cd server
npm run dev      # node --watch auto-reload, port 3001
npm start        # standard start
npm test         # Vitest tests (Node environment)
```

## Architecture

### Four-Layer Extension Design

```
Popup (React)
  ↕ runtime messages
Service Worker  ←→  Content Scripts (per-platform)
  ↕ runtime messages
Offscreen Document (Socket.io client)
  ↕ WebSocket
Node.js Server (Express + Socket.io)
```

**Service Worker** (`extension/src/background/service-worker.js`): Pure message router — no business logic. Owns session state (serverUrl, roomCode, username, platform, connectionState) and persists it to `chrome.storage.local`. Routes messages between all layers. Creates/manages the Offscreen Document lifecycle. Fires a Chrome alarm every 24 s to keep itself alive while in a room.

**Offscreen Document** (`extension/src/offscreen/offscreen.js`): Holds the persistent Socket.io connection. Survives popup close (Chrome 109+ feature). Handles Socket.io reconnection, auto-rejoins the room on reconnect, and detects ngrok URLs to force WebSocket-only transport (avoids ngrok polling errors).

**Popup** (`extension/src/popup/App.jsx`): Purely UI — three states: Setup (server URL input), Lobby (create/join room), In-Room (invite link, member count, chat feed). Requests state snapshots from the service worker; never touches Socket.io directly.

**Content Scripts** (`extension/src/content/`): One file per platform (youtube.js, netflix.js, prime.js, hotstar.js). Each hooks the platform's video element, detects ads, and mounts/unmounts the chat overlay (`chat-overlay.js`). Vanilla JS only — no bundler runs on content scripts. `ad-detection.js` is a shared utility used by Hotstar.

### Message Types

| Direction | Message | Purpose |
|---|---|---|
| Popup → SW | `POPUP_CONNECT`, `POPUP_EMIT`, `POPUP_DISCONNECT` | User-initiated actions |
| SW → Offscreen | `OFFSCREEN_CONNECT`, `OFFSCREEN_EMIT`, `OFFSCREEN_AUTO_REJOIN` | Socket control |
| Offscreen → SW | `SOCKET_STATE`, `SOCKET_EVENT` | Connection state + server events |
| SW → Content | `APPLY_SYNC`, `AD_STARTED_REMOTE`, `AD_ENDED_REMOTE`, `ROOM_JOINED`, `ROOM_LEFT`, `INCOMING_CHAT` | Sync commands |
| Content → SW | `LOCAL_EVENT`, `AD_STARTED`, `AD_ENDED`, `CHAT_SEND` | Player events + chat |

### Server Room Model

In-memory only (no database). Each room:
- 6-character alphanumeric code, max 10 members
- Locks to the first platform that joins (prevents cross-platform rooms)
- 45-second grace period before deletion when all members disconnect

### Sync Mechanism

Content scripts attach `play`, `pause`, `seeked` listeners to the video element. An `isSyncing` flag prevents feedback loops when applying a remote command. Seeks < 2 s apart are ignored to avoid noise. Ad detection pauses all other members while one user watches an ad.

## Key Files

| File | Role |
|---|---|
| `extension/src/background/service-worker.js` | Message router + session state |
| `extension/src/offscreen/offscreen.js` | Persistent Socket.io connection |
| `extension/src/popup/App.jsx` | React UI (popup) |
| `extension/src/content/youtube.js` | YouTube player hook |
| `extension/src/content/netflix.js` | Netflix player hook |
| `extension/src/content/prime.js` | Prime Video player hook |
| `extension/src/content/hotstar.js` | Hotstar player hook |
| `extension/src/content/chat-overlay.js` | Injected chat UI |
| `extension/src/content/ad-detection.js` | Shared ad detection utility |
| `extension/src/lib/parseInviteLink.js` | Invite URL parser |
| `server/index.js` | Express + Socket.io server |
| `extension/manifest.json` | MV3 manifest |
| `extension/vite.config.js` | Vite + CRXJS build config |
