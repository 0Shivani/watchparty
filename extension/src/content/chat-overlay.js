const OVERLAY_ID = "wp-chat-root";
const STYLE_ID = "wp-chat-styles";
const MAX_HISTORY = 20;
const TOAST_DURATION = 5000;

let overlayMounted = false;
let inputBarPosition = "bottom";
let messageHistory = [];
let currentUsername = "";
let outsideClickHandler = null;
let openPanelHandler = null;

function mountChatOverlay(username) {
  if (overlayMounted && document.getElementById(OVERLAY_ID)) return;
  if (document.getElementById(OVERLAY_ID)) {
    overlayMounted = true;
    currentUsername = username || currentUsername;
    return;
  }

  currentUsername = username || currentUsername;
  if (!document.body) return;
  overlayMounted = true;
  injectStyles();

  const root = createElement("div", { id: OVERLAY_ID });

  const inputBar = createElement("div", { id: "wp-chat-input-bar" });
  const input = createElement("input", {
    id: "wp-chat-input",
    type: "text",
    placeholder: "Message...",
    maxLength: "200",
    autocomplete: "off",
  });
  const sendBtn = createElement("button", { id: "wp-chat-send-btn" }, "Send");
  const posBtn = createElement("button", { id: "wp-chat-position-btn" }, "⬆");

  inputBar.appendChild(input);
  inputBar.appendChild(sendBtn);
  inputBar.appendChild(posBtn);

  const toasts = createElement("div", { id: "wp-chat-toasts" });

  const panel = createElement("div", { id: "wp-chat-panel", class: "wp-hidden" });
  const panelMessages = createElement("div", { id: "wp-chat-panel-messages" });
  const closeBtn = createElement("button", { id: "wp-chat-panel-close" }, "✕");
  panel.appendChild(closeBtn);
  panel.appendChild(panelMessages);

  root.appendChild(inputBar);
  root.appendChild(toasts);
  root.appendChild(panel);

  document.body.appendChild(root);

  applyInputBarPosition();
  bindChatEvents(input, sendBtn, posBtn, closeBtn, panel, panelMessages);
}

function unmountChatOverlay() {
  const root = document.getElementById(OVERLAY_ID);
  if (root) root.remove();
  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler);
    outsideClickHandler = null;
  }
  if (openPanelHandler) {
    window.removeEventListener("wp-open-chat-panel", openPanelHandler);
    openPanelHandler = null;
  }
  overlayMounted = false;
  messageHistory = [];
}

function receiveMessage({ username, text, timestamp }) {
  const msg = { username, text, timestamp: timestamp || Date.now() };
  messageHistory = [...messageHistory, msg].slice(-MAX_HISTORY);
  showToast(msg);
  const panelMessages = document.getElementById("wp-chat-panel-messages");
  const panel = document.getElementById("wp-chat-panel");
  if (panelMessages && panel && !panel.classList.contains("wp-hidden")) {
    renderMessages(panelMessages);
    panelMessages.scrollTop = panelMessages.scrollHeight;
  }
}

function bindChatEvents(input, sendBtn, posBtn, closeBtn, panel, panelMessages) {
  const sendMessage = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    chrome.runtime.sendMessage({
      type: "CHAT_SEND",
      payload: { text },
    });

    const msg = { username: currentUsername || "You", text, timestamp: Date.now() };
    messageHistory = [...messageHistory, msg].slice(-MAX_HISTORY);
    if (!panel.classList.contains("wp-hidden")) {
      renderMessages(panelMessages);
      panelMessages.scrollTop = panelMessages.scrollHeight;
    }
  };

  input.addEventListener("keydown", (event) => {
    // Prevent host page keyboard shortcuts (play/pause/seek/fullscreen) while typing in chat.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener("click", sendMessage);

  posBtn.addEventListener("click", () => {
    inputBarPosition = inputBarPosition === "bottom" ? "top" : "bottom";
    posBtn.textContent = inputBarPosition === "bottom" ? "⬆" : "⬇";
    applyInputBarPosition();
  });

  closeBtn.addEventListener("click", () => panel.classList.add("wp-hidden"));

  outsideClickHandler = (event) => {
    if (
      !panel.classList.contains("wp-hidden") &&
      !panel.contains(event.target) &&
      !event.target.classList.contains("wp-toast")
    ) {
      panel.classList.add("wp-hidden");
    }
  };
  document.addEventListener("click", outsideClickHandler);

  openPanelHandler = () => {
    panel.classList.remove("wp-hidden");
    renderMessages(panelMessages);
    panelMessages.scrollTop = panelMessages.scrollHeight;
  };
  window.addEventListener("wp-open-chat-panel", openPanelHandler);
}

function showToast({ username, text }) {
  const toastContainer = document.getElementById("wp-chat-toasts");
  if (!toastContainer) return;

  const toast = createElement("div", { class: "wp-toast" });
  toast.innerHTML = `<span class="wp-toast-user">${escapeHtml(username)}</span>
                     <span class="wp-toast-text">${escapeHtml(text)}</span>`;

  toast.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("wp-open-chat-panel"));
  });

  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("wp-toast--visible"));

  setTimeout(() => {
    toast.classList.remove("wp-toast--visible");
    setTimeout(() => toast.remove(), 300);
  }, TOAST_DURATION);
}

function renderMessages(panelMessages) {
  panelMessages.innerHTML = "";
  messageHistory.forEach(({ username, text, timestamp }) => {
    const el = createElement("div", { class: "wp-msg" });
    const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.innerHTML = `
      <span class="wp-msg-user">${escapeHtml(username)}</span>
      <span class="wp-msg-time">${time}</span>
      <span class="wp-msg-text">${escapeHtml(text)}</span>
    `;
    panelMessages.appendChild(el);
  });
}

function applyInputBarPosition() {
  const bar = document.getElementById("wp-chat-input-bar");
  if (!bar) return;
  if (inputBarPosition === "bottom") {
    bar.style.bottom = "0";
    bar.style.top = "auto";
  } else {
    bar.style.top = "0";
    bar.style.bottom = "auto";
  }
}

function createElement(tag, attrs = {}, textContent = null) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  if (textContent !== null) el.textContent = textContent;
  return el;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #wp-chat-root {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      font-family: 'Inter', system-ui, sans-serif;
    }
    #wp-chat-input-bar {
      position: fixed;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      background: rgba(10, 10, 10, 0.82);
      backdrop-filter: blur(8px);
      pointer-events: all;
      z-index: 2147483647;
      transition: top 0.2s ease, bottom 0.2s ease;
    }
    #wp-chat-input {
      flex: 1;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      color: #fff;
      font-size: 13px;
      padding: 6px 10px;
      outline: none;
    }
    #wp-chat-input:focus {
      border-color: #f5a623;
    }
    #wp-chat-send-btn,
    #wp-chat-position-btn {
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      color: #ccc;
      cursor: pointer;
      font-size: 12px;
      padding: 6px 10px;
      white-space: nowrap;
      pointer-events: all;
      transition: border-color 0.15s;
    }
    #wp-chat-send-btn:hover {
      border-color: #f5a623;
      color: #f5a623;
    }
    #wp-chat-position-btn:hover {
      border-color: #fff;
      color: #fff;
    }
    #wp-chat-toasts {
      position: fixed;
      right: 14px;
      bottom: 60px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
      pointer-events: none;
      z-index: 2147483647;
    }
    .wp-toast {
      background: rgba(10, 10, 10, 0.88);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      font-size: 12px;
      max-width: 240px;
      opacity: 0;
      padding: 8px 12px;
      pointer-events: all;
      transform: translateX(10px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      word-break: break-word;
    }
    .wp-toast--visible {
      opacity: 1;
      transform: translateX(0);
    }
    .wp-toast-user {
      color: #f5a623;
      font-weight: 600;
      margin-right: 6px;
    }
    .wp-toast-text {
      color: #e0e0e0;
    }
    #wp-chat-panel {
      position: fixed;
      right: 14px;
      bottom: 60px;
      width: 260px;
      max-height: 320px;
      background: rgba(10, 10, 10, 0.92);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      pointer-events: all;
      z-index: 2147483647;
      overflow: hidden;
    }
    #wp-chat-panel.wp-hidden {
      display: none;
    }
    #wp-chat-panel-close {
      align-self: flex-end;
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      font-size: 14px;
      padding: 8px 10px 4px;
      line-height: 1;
    }
    #wp-chat-panel-close:hover {
      color: #fff;
    }
    #wp-chat-panel-messages {
      flex: 1;
      overflow-y: auto;
      padding: 4px 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #wp-chat-panel-messages::-webkit-scrollbar {
      width: 4px;
    }
    #wp-chat-panel-messages::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 2px;
    }
    .wp-msg {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .wp-msg-user {
      color: #f5a623;
      font-size: 11px;
      font-weight: 600;
    }
    .wp-msg-time {
      color: #555;
      font-size: 10px;
    }
    .wp-msg-text {
      color: #e0e0e0;
      font-size: 12px;
      word-break: break-word;
    }
  `;
  if (document.head) {
    document.head.appendChild(style);
  }
}

if (typeof window !== "undefined") {
  window.WatchPartyChat = {
    mountChatOverlay,
    unmountChatOverlay,
    receiveMessage,
  };
}
