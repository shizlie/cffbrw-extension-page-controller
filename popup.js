/**
 * CFFBRW Browser Bridge — Popup script (v2)
 *
 * Two compilation modes:
 *   1. Quick Compile — single page DOM snapshot (backward compat)
 *   2. Record & Compile — multi-page recording with state capture
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

  if (!gatewayUrl) {
    showStatus("Gateway URL is required", "err");
    return;
  }

  try { new URL(gatewayUrl); } catch {
    showStatus("Invalid URL format", "err");
    return;
  }

  chrome.storage.local.set({ gatewayUrl, workspaceToken }, () => {
    showStatus("Saved.", "ok");
    pingGateway(gatewayUrl, workspaceToken);
  });
});

function pingGateway(gatewayUrl, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  fetch(`${gatewayUrl}/health`, { headers })
    .then((res) => {
      if (res.ok) showStatus("Connected to gateway.", "ok");
      else showStatus(`Gateway returned ${res.status}`, "err");
    })
    .catch(() => showStatus("Gateway unreachable (saved anyway).", "err"));
}

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = type || "";
}

// ── Quick Compile (single page) ─────────────────────────────────

document.getElementById("compile").addEventListener("click", async () => {
  const result = document.getElementById("schema-result");
  result.style.display = "none";
  showStatus("Extracting DOM...", "");

  const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
  if (!gatewayUrl) { showStatus("Save a Gateway URL first", "err"); return; }

  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch (e) { showStatus("Error: " + e.message, "err"); return; }

  if (!tab?.id) { showStatus("No active tab found", "err"); return; }

  let domResponse;
  try {
    domResponse = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" });
  } catch (e) {
    showStatus("DOM extract error: " + e.message, "err");
    return;
  }

  if (!domResponse?.success) {
    showStatus("DOM error: " + (domResponse?.error ?? "unknown"), "err");
    return;
  }

  showStatus("Compiling (AI)...", "");

  const headers = { "Content-Type": "application/json" };
  if (workspaceToken) headers["Authorization"] = "Bearer " + workspaceToken;

  try {
    const res = await fetch(gatewayUrl + "/v1/browser/compile", {
      method: "POST",
      headers,
      body: JSON.stringify({
        siteUrl: tab.url,
        domSnapshots: { main: domResponse.flatTree },
        selectorLookup: domResponse.selectorLookup || {},
        selectorStrategies: domResponse.selectorStrategies || undefined,
        verifyProps: domResponse.verifyProps || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showStatus("Compile error: " + (data.error ?? res.status), "err");
      return;
    }
    document.getElementById("schema-id").value = data.toolSchemaId;
    result.style.display = "block";
    showStatus("Compiled successfully", "ok");
  } catch (e) {
    showStatus("Fetch error: " + e.message, "err");
  }
});

// ── Record & Compile (multi-page) ───────────────────────────────

const recordStartBtn = document.getElementById("record-start");
const recordBar = document.getElementById("recording-bar");
const stateCountEl = document.getElementById("state-count");
const recordCaptureBtn = document.getElementById("record-capture");
const recordStopBtn = document.getElementById("record-stop");

// Check if already recording on popup open
chrome.runtime.sendMessage({ type: "GET_RECORDING_STATUS" }, (status) => {
  if (status?.active) {
    enterRecordingUI(status.stateCount);
  }
});

recordStartBtn.addEventListener("click", async () => {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch (e) { showStatus("Error: " + e.message, "err"); return; }

  if (!tab?.id) { showStatus("No active tab found", "err"); return; }

  showStatus("Starting recording...", "");

  chrome.runtime.sendMessage({ type: "START_RECORDING", tabId: tab.id }, (result) => {
    if (result?.success) {
      enterRecordingUI(result.stateCount);
      showStatus("Recording started. Navigate the site, then capture states.", "ok");
    } else {
      showStatus("Failed to start recording", "err");
    }
  });
});

recordCaptureBtn.addEventListener("click", () => {
  showStatus("Capturing state...", "");

  chrome.runtime.sendMessage({
    type: "CAPTURE_CLICK",
    trigger: { type: "manual_capture" },
  }, (result) => {
    if (result?.success) {
      stateCountEl.textContent = result.stateCount;
      showStatus(`State captured (${result.stateCount} total)`, "ok");
    } else {
      showStatus("Capture failed: " + (result?.error || "unknown"), "err");
    }
  });
});

recordStopBtn.addEventListener("click", async () => {
  showStatus("Stopping recording...", "");

  chrome.runtime.sendMessage({ type: "STOP_RECORDING" }, async (result) => {
    exitRecordingUI();

    if (!result?.success || !result.states?.length) {
      showStatus("No states recorded", "err");
      return;
    }

    const states = result.states;
    showStatus(`Compiling ${states.length} states (AI)...`, "");

    const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
    if (!gatewayUrl) { showStatus("Save a Gateway URL first", "err"); return; }

    const headers = { "Content-Type": "application/json" };
    if (workspaceToken) headers["Authorization"] = "Bearer " + workspaceToken;

    const siteUrl = states[0]?.url || "unknown";

    try {
      const res = await fetch(gatewayUrl + "/v1/browser/compile", {
        method: "POST",
        headers,
        body: JSON.stringify({
          siteUrl,
          recording: true,
          states,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showStatus("Compile error: " + (data.error ?? res.status), "err");
        return;
      }
      document.getElementById("schema-id").value = data.toolSchemaId;
      document.getElementById("schema-result").style.display = "block";
      showStatus(`Compiled ${states.length} states successfully`, "ok");
    } catch (e) {
      showStatus("Fetch error: " + e.message, "err");
    }
  });
});

function enterRecordingUI(stateCount) {
  recordStartBtn.disabled = true;
  recordStartBtn.style.display = "none";
  recordBar.classList.add("active");
  stateCountEl.textContent = stateCount || 0;
  document.getElementById("compile").disabled = true;
}

function exitRecordingUI() {
  recordStartBtn.disabled = false;
  recordStartBtn.style.display = "block";
  recordBar.classList.remove("active");
  document.getElementById("compile").disabled = false;
}
