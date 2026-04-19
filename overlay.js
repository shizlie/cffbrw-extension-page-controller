/**
 * CFFBRW Browser Bridge — Overlay (v2)
 *
 * Shadow DOM floating panel for recording mode.
 * Shows: state/action count, live action log, focus highlight, toasts.
 * CSS-isolated from host page via Shadow DOM.
 */

const OVERLAY_ID = "cffbrw-recording-overlay";
const MAX_LOG_ENTRIES = 50;

let _shadowRoot = null;
let _panel = null;
let _logEl = null;
let _countEl = null;
let _liveEntry = null;
let _toastTimer = null;

window.CffbrwOverlay = {
  show() {
    if (_panel) return;
    _createPanel();
  },

  hide() {
    const host = document.getElementById(OVERLAY_ID);
    if (host) host.remove();
    _panel = null;
    _shadowRoot = null;
    _logEl = null;
    _countEl = null;
    _liveEntry = null;
  },

  updateCount(states, actions) {
    if (!_countEl) return;
    _countEl.textContent = `${states} states · ${actions} actions`;
  },

  logEntry(text) {
    if (!_logEl) return;
    // Remove live entry if exists
    if (_liveEntry) { _liveEntry.remove(); _liveEntry = null; }

    const entry = document.createElement("div");
    entry.className = "cffbrw-log-entry";
    entry.textContent = text;
    _logEl.appendChild(entry);

    // Trim old entries
    while (_logEl.children.length > MAX_LOG_ENTRIES) {
      _logEl.removeChild(_logEl.firstChild);
    }
    _logEl.scrollTop = _logEl.scrollHeight;
  },

  logEntryLive(text) {
    if (!_logEl) return;
    if (!_liveEntry) {
      _liveEntry = document.createElement("div");
      _liveEntry.className = "cffbrw-log-entry cffbrw-live";
      _logEl.appendChild(_liveEntry);
    }
    _liveEntry.textContent = text;
    _logEl.scrollTop = _logEl.scrollHeight;
  },

  highlightFocus(index, label) {
    // PageController already highlights elements, we just update the log
    if (!_logEl) return;
    // Show subtle focus indicator (don't add to permanent log)
  },

  toast(message) {
    if (!_shadowRoot) return;
    let toastEl = _shadowRoot.querySelector(".cffbrw-toast");
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "cffbrw-toast";
      _shadowRoot.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.opacity = "1";

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toastEl.style.opacity = "0";
    }, 2000);
  },

  // Show compile lifecycle: extracting → compiling → done / error.
  // Keeps overlay visible throughout so user sees progress even with popup closed.
  setCompileStatus(update) {
    // Auto-create overlay if not yet shown (quick compile from closed popup)
    if (!_panel) _createPanel();
    if (!_panel) return;

    const header = _shadowRoot.querySelector(".cffbrw-title");
    const dot = _shadowRoot.querySelector(".cffbrw-dot");
    const buttons = _shadowRoot.querySelector(".cffbrw-buttons");

    if (update.state === "stopping") {
      if (header) header.textContent = "Stopping...";
      if (buttons) buttons.style.display = "none";
    } else if (update.state === "extracting") {
      if (header) header.textContent = "Extracting DOM...";
      if (dot) dot.style.background = "#f59e0b";
      if (buttons) buttons.style.display = "none";
    } else if (update.state === "compiling") {
      if (header) header.textContent = "Compiling (AI)...";
      if (dot) dot.style.background = "#f59e0b";
      if (buttons) buttons.style.display = "none";
      this.logEntry(`→ Sent ${update.stateCount || "?"} states, ${update.actionCount || "?"} actions to compiler`);
    } else if (update.state === "done") {
      if (header) header.textContent = "Compiled ✓";
      if (dot) dot.style.background = "#22c55e";
      if (buttons) buttons.style.display = "none";
      this.logEntry(`✓ Schema: ${update.toolSchemaId} (${update.toolCount || 0} tools)`);
      // Auto-hide after 10s
      setTimeout(() => this.hide(), 10000);
    } else if (update.state === "error") {
      if (header) header.textContent = "Compile failed";
      if (dot) dot.style.background = "#ef4444";
      if (buttons) buttons.style.display = "none";
      this.logEntry(`✗ Error: ${update.error}`);
      setTimeout(() => this.hide(), 15000);
    }
  },
};

function _createPanel() {
  // Remove existing
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  // Host element
  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483647;pointer-events:none;";
  document.body.appendChild(host);

  // Shadow DOM
  _shadowRoot = host.attachShadow({ mode: "closed" });

  // Styles
  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .cffbrw-panel {
      width: 280px;
      max-height: 320px;
      background: #0a0a0aee;
      border: 1px solid #ef4444;
      border-radius: 6px;
      font-family: "IBM Plex Mono", monospace, monospace;
      font-size: 11px;
      color: #e5e5e5;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      backdrop-filter: blur(8px);
    }
    .cffbrw-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid #222;
      flex-shrink: 0;
    }
    .cffbrw-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
      animation: cffbrw-pulse 1s infinite;
    }
    @keyframes cffbrw-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .cffbrw-title { color: #ef4444; font-weight: 600; }
    .cffbrw-count { color: #888; margin-left: auto; font-size: 10px; }
    .cffbrw-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 10px;
      max-height: 200px;
    }
    .cffbrw-log::-webkit-scrollbar { width: 4px; }
    .cffbrw-log::-webkit-scrollbar-track { background: transparent; }
    .cffbrw-log::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
    .cffbrw-log-entry {
      padding: 2px 0;
      color: #aaa;
      border-bottom: 1px solid #1a1a1a;
      word-break: break-word;
    }
    .cffbrw-log-entry.cffbrw-live {
      color: #666;
      font-style: italic;
    }
    .cffbrw-buttons {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid #222;
      flex-shrink: 0;
    }
    .cffbrw-btn {
      flex: 1;
      padding: 5px 8px;
      border-radius: 3px;
      border: none;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .cffbrw-btn-capture {
      background: #1a1a1a;
      color: #22c55e;
      border: 1px solid #22c55e;
    }
    .cffbrw-btn-capture:hover { background: #22c55e22; }
    .cffbrw-btn-stop {
      background: #ef4444;
      color: #fff;
    }
    .cffbrw-btn-stop:hover { background: #dc2626; }
    .cffbrw-toast {
      position: fixed;
      top: 12px;
      right: 12px;
      background: #22c55ecc;
      color: #0a0a0a;
      padding: 6px 12px;
      border-radius: 4px;
      font-family: "IBM Plex Mono", monospace;
      font-size: 11px;
      font-weight: 600;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }
  `;
  _shadowRoot.appendChild(style);

  // Panel
  _panel = document.createElement("div");
  _panel.className = "cffbrw-panel";

  // Header
  const header = document.createElement("div");
  header.className = "cffbrw-header";
  header.innerHTML = `<span class="cffbrw-dot"></span><span class="cffbrw-title">Recording</span>`;
  _countEl = document.createElement("span");
  _countEl.className = "cffbrw-count";
  _countEl.textContent = "0 states · 0 actions";
  header.appendChild(_countEl);
  _panel.appendChild(header);

  // Log
  _logEl = document.createElement("div");
  _logEl.className = "cffbrw-log";
  _panel.appendChild(_logEl);

  // Buttons
  const buttons = document.createElement("div");
  buttons.className = "cffbrw-buttons";

  const captureBtn = document.createElement("button");
  captureBtn.className = "cffbrw-btn cffbrw-btn-capture";
  captureBtn.textContent = "Capture";
  captureBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "CAPTURE_MANUAL" });
  });

  const stopBtn = document.createElement("button");
  stopBtn.className = "cffbrw-btn cffbrw-btn-stop";
  stopBtn.textContent = "Stop";
  stopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "STOP_FROM_OVERLAY" });
  });

  buttons.appendChild(captureBtn);
  buttons.appendChild(stopBtn);
  _panel.appendChild(buttons);

  _shadowRoot.appendChild(_panel);
}
