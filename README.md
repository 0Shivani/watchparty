# WatchParty

## Quick Start

```bash
# 1) Start backend
cd server
npm install
npm run dev

# 2) Expose backend for friends (new terminal)
ngrok http 3001

# 3) Build extension (new terminal)
cd ../extension
npm install
npm run build

# 4) Load extension in Chrome
# chrome://extensions -> Developer Mode -> Load unpacked -> extension/dist
```

## What is WatchParty

WatchParty is a self-hosted Chrome extension for synchronized video playback across supported OTT platforms. It is inspired by Teleparty's core idea: play, pause, and seek actions from one viewer are relayed in real time to everyone else in the same room. This project is designed for local development and portfolio use, not managed cloud deployment.

## Architecture

```text
Browser Tab (YouTube/Netflix/Prime/Hotstar)
        ↕
  Content Script
        ↕
 Service Worker (MV3 bridge + storage)
        ↕
   Popup (React + socket.io-client)
        ↕
 Socket.io Server (Express + in-memory rooms)
        ↕
 Other User's identical stack
```

## Tech Stack

| Technology | Why it was chosen |
|---|---|
| Chrome Extension Manifest V3 | Required modern extension model; service worker architecture is MV3 standard |
| React 18 + Vite | Fast popup UI development with lightweight bundling |
| `@crxjs/vite-plugin` | Builds extension assets cleanly from Vite with MV3 support |
| Node.js + Express | Simple local backend for room APIs and health endpoint |
| Socket.io v4 | Reliable bidirectional real-time events with reconnect support |
| Vanilla JS content scripts | CSP-friendly, no page-context dependency issues |
| `chrome.storage.local` | Works across popup/service-worker contexts unlike `localStorage` in workers |
| ngrok | Quick HTTPS tunnel so remote friends can reach local server |

## Setup - Server

```bash
cd server
npm install
npm run dev
```

Then install ngrok (`npm install -g ngrok` or download from [ngrok.com](https://ngrok.com)) and run:

```bash
ngrok http 3001
# Copy the https://xxxx.ngrok-free.app URL
```

## Setup - Extension

```bash
cd extension
npm install
npm run build
```

Then in Chrome:
- Open `chrome://extensions`
- Enable Developer Mode
- Click **Load unpacked**
- Select `extension/dist/`

## How to Watch Together

- Host runs the server and ngrok, then shares the ngrok URL.
- Everyone installs the extension, pastes the URL, and clicks **Save & Connect**.
- Host clicks **Create Room** and shares the 6-character room code.
- Friend enters the code and clicks **Join Room**.
- Both navigate to the same video on YouTube/Netflix/Prime/Hotstar.
- Any play/pause/seek action syncs across room members.

## Known Limitations

- The popup must remain open during the watch session due to MV3 lifecycle constraints; if it closes, the socket disconnects.
- Netflix and Prime Video may update player DOM structure, which can require selector updates.
- If playback drifts, use a manual seek to re-anchor both viewers via a fresh sync event.

## Future Improvements

- WebRTC-based peer sync to reduce server relay dependency
- In-room text chat panel
- Emoji reactions and lightweight social signals
- Persistent rooms via Redis
- Firefox extension support
