# WatchParty

> Synchronized OTT video playback for you and your friends — no account, no subscription,
> just clone, run, and share a room code.

![Chrome](https://img.shields.io/badge/Chrome-109%2B-4285F4?logo=googlechrome&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-4.x-010101?logo=socketdotio&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-28%20passing-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## Supported Platforms

| Platform | Playback Sync | Ad Detection | Chat |
|---|---|---|---|
| YouTube | ✅ | ✅ | ✅ |
| Netflix | ✅ | ✅ | ✅ |
| Amazon Prime Video | ✅ | ✅ | ✅ |
| JioHotstar | ✅ | ✅ | ✅ |

---

## Features

- **Bidirectional playback sync** — play, pause, and seek stay frame-locked across all members
- **Ad detection** — when one user's account plays an ad, everyone else's player pauses automatically and resumes when the ad ends
- **Real-time chat** — page-injected chat overlay with toast previews, no popup required
- **Session resilience** — exponential backoff reconnection, auto-rejoin on reconnect, 45-second server grace period for brief disconnects
- **Persistent socket** — uses Chrome Offscreen Document API so closing the popup never drops the connection
- **Room codes** — 6-character codes to create and share sessions instantly

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Chrome Extension                     │
│                                                             │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────┐ │
│  │   Popup     │    │  Service Worker  │    │  Offscreen │ │
│  │  (UI only)  │◄──►│  (message router)│◄──►│  Document  │ │
│  └─────────────┘    └────────┬─────────┘    │ (socket.io)│ │
│                              │              └────────────┘ │
│                    ┌─────────▼─────────┐                   │
│                    │  Content Scripts  │                   │
│                    │ (player + chat UI)│                   │
│                    └───────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Node.js Server  │
                    │ Express + Socket.io│
                    └───────────────────┘
```

**Key architectural decisions:**

- The Socket.io connection lives in a **Chrome Offscreen Document** — a hidden persistent
  page that survives popup closes. This is the correct MV3 solution to the transient popup
  lifecycle problem.
- The **Service Worker** acts as a pure message router between all four layers (popup,
  offscreen, content scripts, storage) — it owns no business logic itself.
- **Content scripts** are injected per-platform and handle two concerns: hooking the native
  video player for sync events, and mounting the chat UI overlay directly into the page DOM.
- The popup is **pure UI** — it requests state snapshots from the service worker on open
  and sends named command messages for all actions.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Extension popup | React 18 + Vite | Component model for multi-state UI; Vite for fast MV3-compatible bundling |
| Extension background | Service Worker (MV3) | Required by Manifest V3; acts as message router |
| Socket connection | Offscreen Document API | Persistent WebSocket independent of popup lifecycle (Chrome 109+) |
| Content scripts | Vanilla JS | No bundler access in page context; must be dependency-free |
| Real-time sync | Socket.io v4 | Bidirectional events, built-in reconnection, room-based broadcasting |
| Server | Node.js + Express | Lightweight, widely understood at SDE 1/2 level |
| Build tooling | @crxjs/vite-plugin | Handles MV3 manifest bundling and content script entry points |
| Tests | Vitest | Vite-native, Jest-compatible API, runs in Node environment |

---

## Project Structure

```
watchparty/
├── server/
│   ├── index.js              # Express + Socket.io server
│   ├── index.test.js         # 28 Vitest tests
│   └── package.json
│
├── extension/
│   ├── src/
│   │   ├── popup/            # React UI (App.jsx, popup.css)
│   │   ├── offscreen/        # Persistent socket (offscreen.js, offscreen.html)
│   │   ├── background/       # Service worker message router
│   │   └── content/          # Platform scripts + chat overlay
│   │       ├── youtube.js
│   │       ├── netflix.js
│   │       ├── prime.js
│   │       ├── hotstar.js
│   │       └── chat-overlay.js
│   ├── manifest.json
│   └── vite.config.js
│
└── README.md
```

---

## Setup

### Requirements

- Node.js 18+
- Chrome 109+
- [ngrok](https://ngrok.com) (free account, for sharing your local server)

### 1. Run the server

```bash
cd server
npm install
npm run dev        # starts on http://localhost:3001
```

In a second terminal:

```bash
ngrok http 3001
# Copy the https://xxxx.ngrok-free.app URL — you'll need it in step 3
```

### 2. Build the extension

```bash
cd extension
npm install
npm run build      # outputs to extension/dist/
```

### 3. Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/dist/` folder

### 4. Watch together

1. Host shares the ngrok URL with friends
2. All users open the WatchParty popup, paste the URL, click **Save & Connect**
3. Host clicks **Create Room** and shares the 6-character room code
4. Friends paste the code and click **Join Room**
5. Everyone navigates to the same video — press play and sync begins automatically

---

## Running Tests

```bash
cd server
npm test           # runs all 28 tests with Vitest
npm test -- --reporter=verbose   # see individual test names
```

Test coverage includes: room lifecycle, malformed payload handling, sync event relay,
member count accuracy, reconnection grace period, ad event broadcasting, and chat message
validation.

---

## Known Limitations

- **Ad detection** relies on platform DOM structure which can change without notice.
  YouTube's `.ad-showing` class is the most stable signal. Netflix, Prime, and Hotstar
  selectors may need updating if platforms redesign their player UI.
- **Chat overlay** is mounted per-tab on room join. If the user navigates to the platform
  tab after joining, a page refresh may be needed to mount the overlay.
- **Netflix and Prime Video** update their player DOM periodically — if sync stops working
  on a specific platform, the content script's video selector likely needs updating.
- **Manual re-anchor may be needed** — if playback drifts, use a manual seek to trigger a
  fresh sync event and realign viewers.
- **Strict CSP styling constraints** — chat UI is injected into the page DOM, and on strict
  CSP platforms (notably Netflix), `backdrop-filter` can be ignored while chat remains usable.
- **The extension cannot suppress ads** — it only coordinates pause/resume across members
  during ad breaks.
- **Messages are not persisted** — chat history resets if a user rejoins the room.
- **Bundling assumptions for content imports** — content-script `import` paths require
  module-compatible bundling (for example, ensuring `chat-overlay.js` is bundled per
  platform script via `@crxjs/vite-plugin`).

---

## Future Improvements

- Docker Compose setup for one-command local deployment
- WebRTC P2P data channel to eliminate server relay for sync messages
- In-room text chat panel improvements
- Emoji reactions
- Persistent chat history via Redis
- Firefox support (requires MV3 differences)

---

## License

MIT
