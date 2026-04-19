/**
 * CFFBRW Browser Bridge — Popup (v2)
 *
 * Two modes:
 *   1. Quick Compile — single page snapshot → ToolSchema
 *   2. Record & Compile — event-driven multi-page recording → ToolSchema
 */

const gatewayInput = document.getElementById("gateway");
const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// ── Settings ────────────────────────────────────────────────────

chrome.storage.local.get(["gatewayUrl", "workspaceToken"], (result) => {
  gatewayInput.value = result.gatewayUrl || "http://localhost:8787";
  tokenInput.value = result.workspaceToken || "";
});

saveBtn.addEventListener("click", () => {
  const gatewayUrl = gatewayInput.value.trim().replace(/\/$/, "");
  const workspaceToken = tokenInput.value.trim();
  if (!gatewayUrl) { showStatus("Gateway URL required", "err"); return; }
  try { new URL(gatewayUrl); } catch { showStatus("Invalid URL", "err"); return; }

  chrome.storage.local.set({ gatewayUrl, workspaceToken }, () => {
    showStatus("Saved.", "ok");
    pingGateway(gatewayUrl, workspaceToken);
  });
});

function pingGateway(gatewayUrl, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  fetch(`${gatewayUrl}/health`, { headers })
    .then((res) => res.ok ? showStatus("Connected.", "ok") : showStatus(`Gateway ${res.status}`, "err"))
    .catch(() => showStatus("Unreachable (saved anyway).", "err"));
}

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = type || "";
}

// ── Quick Compile (runs in background, survives popup close) ────

document.getElementById("compile").addEventListener("click", async () => {
  const result = document.getElementById("schema-result");
  result.style.display = "none";
  showStatus("Starting compile in background...", "");

  const { gatewayUrl } = await chrome.storage.local.get("gatewayUrl");
  if (!gatewayUrl) { showStatus("Save Gateway URL first", "err"); return; }

  chrome.runtime.sendMessage({ type: "COMPILE_QUICK" }, (reply) => {
    if (!reply?.success) { showStatus("Failed to start: " + (reply?.error || "unknown"), "err"); return; }
    showStatus("Compiling in background. Can close popup.", "ok");
    // Poll compile status (or re-open popup later to see result)
    _startCompileStatusPoller();
  });
});

// ── Last schema display (persists across popup close) ───────────

async function loadLastSchema() {
  const { cffbrw_last_schema } = await chrome.storage.local.get("cffbrw_last_schema");
  if (!cffbrw_last_schema) return;
  const last = document.getElementById("last-schema");
  const lastId = document.getElementById("last-schema-id");
  const lastMeta = document.getElementById("last-schema-meta");
  if (!last) return;
  last.style.display = "block";
  lastId.value = cffbrw_last_schema.id;
  const ageMs = Date.now() - (cffbrw_last_schema.at || 0);
  const ageMin = Math.floor(ageMs / 60000);
  const ageStr = ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`;
  const tools = Array.isArray(cffbrw_last_schema.tools) ? cffbrw_last_schema.tools.length : "?";
  lastMeta.textContent = `${cffbrw_last_schema.mode} · ${tools} tools · ${ageStr}`;
}

// ── Compile status display (live while compile in progress) ─────

let _compileStatusPoller = null;
function _startCompileStatusPoller() {
  _stopCompileStatusPoller();
  _compileStatusPoller = setInterval(async () => {
    const { cffbrw_compile_status } = await chrome.storage.session.get("cffbrw_compile_status");
    if (!cffbrw_compile_status) return;
    const label = {
      stopping: "Stopping...",
      extracting: "Extracting DOM...",
      compiling: "Compiling (AI)...",
      done: "Done",
      error: "Error: " + (cffbrw_compile_status.error || ""),
    }[cffbrw_compile_status.state] || cffbrw_compile_status.state;
    showStatus(label, cffbrw_compile_status.state === "error" ? "err" : "ok");
    if (cffbrw_compile_status.state === "done") {
      document.getElementById("schema-id").value = cffbrw_compile_status.toolSchemaId;
      document.getElementById("schema-result").style.display = "block";
      loadLastSchema();
      _stopCompileStatusPoller();
    } else if (cffbrw_compile_status.state === "error") {
      _stopCompileStatusPoller();
    }
  }, 1000);
}
function _stopCompileStatusPoller() {
  if (_compileStatusPoller) { clearInterval(_compileStatusPoller); _compileStatusPoller = null; }
}

// On popup open, check if compile already in progress or done
(async () => {
  await loadLastSchema();
  const { cffbrw_compile_status } = await chrome.storage.session.get("cffbrw_compile_status");
  if (cffbrw_compile_status && ["stopping", "extracting", "compiling"].includes(cffbrw_compile_status.state)) {
    _startCompileStatusPoller();
  }
})();

// ── Record & Compile ────────────────────────────────────────────

const recordStartBtn = document.getElementById("record-start");
const recordBar = document.getElementById("recording-bar");
const stateCountEl = document.getElementById("state-count");
const actionCountEl = document.getElementById("action-count");
const recordStopBtn = document.getElementById("record-stop");

// Check recording status on popup open
chrome.runtime.sendMessage({ type: "GET_RECORDING_STATUS" }, (status) => {
  if (status?.active) {
    enterRecordingUI(status.stateCount);
  }
});

// (stopped-from-overlay result is now handled via compile status poller
//  since background.js runs the full stop→compile flow directly.)

recordStartBtn.addEventListener("click", async () => {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch (e) { showStatus("Error: " + e.message, "err"); return; }
  if (!tab?.id) { showStatus("No active tab", "err"); return; }

  showStatus("Starting recording...", "");
  chrome.runtime.sendMessage({ type: "START_RECORDING", tabId: tab.id }, (result) => {
    if (result?.success) {
      enterRecordingUI(1);
      showStatus("Recording. Navigate the site.", "ok");
    } else {
      showStatus("Failed: " + (result?.error || "unknown"), "err");
    }
  });
});

recordStopBtn.addEventListener("click", async () => {
  showStatus("Stopping & compiling in background...", "");
  chrome.runtime.sendMessage({ type: "STOP_AND_COMPILE" }, (reply) => {
    exitRecordingUI();
    if (!reply?.success) { showStatus("Failed: " + (reply?.error || "unknown"), "err"); return; }
    showStatus("Compiling in background. Can close popup.", "ok");
    _startCompileStatusPoller();
  });
});

function enterRecordingUI(stateCount) {
  recordStartBtn.disabled = true;
  recordStartBtn.style.display = "none";
  recordBar.classList.add("active");
  stateCountEl.textContent = stateCount || 0;
  actionCountEl.textContent = "0";
  document.getElementById("compile").disabled = true;

  // Poll for live counts
  _startCountPoller();
}

function exitRecordingUI() {
  recordStartBtn.disabled = false;
  recordStartBtn.style.display = "block";
  recordBar.classList.remove("active");
  document.getElementById("compile").disabled = false;
  _stopCountPoller();
}

let _countPoller = null;
function _startCountPoller() {
  _stopCountPoller();
  _countPoller = setInterval(() => {
    chrome.storage.session.get(["cffbrw_meta", "cffbrw_actions"], (result) => {
      const meta = result.cffbrw_meta;
      const actions = result.cffbrw_actions;
      if (meta) stateCountEl.textContent = meta.stateCount || 0;
      if (actions) actionCountEl.textContent = actions.length || 0;
    });
  }, 1000);
}

function _stopCountPoller() {
  if (_countPoller) { clearInterval(_countPoller); _countPoller = null; }
}
