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

// ── Quick Compile ───────────────────────────────────────────────

document.getElementById("compile").addEventListener("click", async () => {
  const result = document.getElementById("schema-result");
  result.style.display = "none";
  showStatus("Extracting DOM...", "");

  const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
  if (!gatewayUrl) { showStatus("Save Gateway URL first", "err"); return; }

  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch (e) { showStatus("Error: " + e.message, "err"); return; }
  if (!tab?.id) { showStatus("No active tab", "err"); return; }

  let domResponse;
  try { domResponse = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" }); }
  catch (e) { showStatus("DOM error: " + e.message, "err"); return; }
  if (!domResponse?.success) { showStatus("DOM error: " + (domResponse?.error ?? "unknown"), "err"); return; }

  showStatus("Compiling (AI)...", "");
  const headers = { "Content-Type": "application/json" };
  if (workspaceToken) headers["Authorization"] = "Bearer " + workspaceToken;

  try {
    const res = await fetch(gatewayUrl + "/v1/browser/compile", {
      method: "POST", headers,
      body: JSON.stringify({
        siteUrl: tab.url,
        domSnapshots: { main: domResponse.flatTree },
        selectorLookup: domResponse.selectorLookup || {},
        selectorStrategies: domResponse.selectorStrategies || undefined,
        verifyProps: domResponse.verifyProps || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showStatus("Compile error: " + (data.error ?? res.status), "err"); return; }
    document.getElementById("schema-id").value = data.toolSchemaId;
    result.style.display = "block";
    showStatus("Compiled successfully", "ok");
  } catch (e) { showStatus("Fetch error: " + e.message, "err"); }
});

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

// Check if recording was stopped from overlay
chrome.runtime.sendMessage({ type: "GET_STOPPED_RESULT" }, async (result) => {
  if (result?.success && result.states?.length > 0) {
    await compileRecording(result.states, result.actions || []);
  }
});

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
  showStatus("Stopping...", "");
  chrome.runtime.sendMessage({ type: "STOP_RECORDING" }, async (result) => {
    exitRecordingUI();
    if (!result?.success || !result.states?.length) {
      showStatus("No states recorded", "err");
      return;
    }
    await compileRecording(result.states, result.actions || []);
  });
});

async function compileRecording(states, actions) {
  showStatus(`Compiling ${states.length} states, ${actions.length} actions (AI)...`, "");

  const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
  if (!gatewayUrl) { showStatus("Save Gateway URL first", "err"); return; }

  const headers = { "Content-Type": "application/json" };
  if (workspaceToken) headers["Authorization"] = "Bearer " + workspaceToken;

  try {
    const res = await fetch(gatewayUrl + "/v1/browser/compile", {
      method: "POST", headers,
      body: JSON.stringify({
        siteUrl: states[0]?.url || "unknown",
        recording: true,
        states,
        actions,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showStatus("Compile error: " + (data.error ?? res.status), "err"); return; }
    document.getElementById("schema-id").value = data.toolSchemaId;
    document.getElementById("schema-result").style.display = "block";
    showStatus(`Compiled ${states.length} states`, "ok");
  } catch (e) { showStatus("Fetch error: " + e.message, "err"); }
}

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
