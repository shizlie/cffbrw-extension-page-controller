/**
 * CFFBRW Browser Bridge — Background Service Worker (v2)
 *
 * Two modes:
 *   1. Polling: GET /v1/browser/pending-actions every 2s for browser_action steps
 *   2. Recording: captures page states as user navigates for multi-page compilation
 *
 * v2 additions:
 *   - Recording mode: START_RECORDING / STOP_RECORDING / CAPTURE_CLICK messages
 *   - State management in chrome.storage.session for recording states
 *   - Tab navigation listener to auto-capture states during recording
 */

const ALARM_NAME = "cffbrw-poll";
const POLL_INTERVAL_MINUTES = 2 / 60; // ~2s in dev

// ── Install: set defaults + start alarm ─────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["gatewayUrl", "workspaceToken"], (result) => {
    if (!result.gatewayUrl) {
      chrome.storage.local.set({ gatewayUrl: "http://localhost:8787" });
    }
  });
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  console.log("[cffbrw] installed, polling started");
});

// Re-register alarm on SW restart
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollPendingActions();
});

// ── Recording state ─────────────────────────────────────────────

let recordingActive = false;
let recordingStates = [];
let recordingTabId = null;

// ── Message handler (popup + content script) ────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_RECORDING") {
    startRecording(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    const states = stopRecording();
    sendResponse({ success: true, states, count: states.length });
    return false;
  }

  if (message.type === "GET_RECORDING_STATUS") {
    sendResponse({
      active: recordingActive,
      stateCount: recordingStates.length,
      tabId: recordingTabId,
    });
    return false;
  }

  if (message.type === "CAPTURE_CLICK") {
    if (recordingActive) {
      captureRecordingState(message.trigger || { type: "click" }).then(sendResponse);
      return true;
    }
    sendResponse({ success: false, error: "Not recording" });
    return false;
  }

  if (message.type === "ADD_INTENT") {
    if (recordingStates.length > 0 && message.stateIndex < recordingStates.length) {
      recordingStates[message.stateIndex].intent = message.intent;
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "Invalid state index" });
    }
    return false;
  }

  return false;
});

// ── Recording lifecycle ─────────────────────────────────────────

async function startRecording(tabId) {
  recordingActive = true;
  recordingStates = [];
  recordingTabId = tabId;

  // Capture initial state
  const result = await captureRecordingState({ type: "initial" });
  return { success: true, stateCount: recordingStates.length };
}

function stopRecording() {
  recordingActive = false;
  const states = [...recordingStates];
  recordingStates = [];
  const tabId = recordingTabId;
  recordingTabId = null;
  return states;
}

async function captureRecordingState(trigger) {
  if (!recordingTabId) return { success: false, error: "No recording tab" };

  // Cap at 20 states (backend limit)
  if (recordingStates.length >= 20) {
    return { success: false, error: "Max 20 states reached" };
  }

  try {
    const response = await chrome.tabs.sendMessage(recordingTabId, {
      type: "CAPTURE_STATE",
      trigger,
    });

    if (response?.success && response.state) {
      recordingStates.push(response.state);
      return { success: true, stateCount: recordingStates.length, state: response.state };
    }
    return { success: false, error: response?.error || "Capture failed" };
  } catch (err) {
    // Content script might not be loaded — inject and retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId: recordingTabId },
        files: ["page-controller.bundle.js", "content.js"],
      });
      const response = await chrome.tabs.sendMessage(recordingTabId, {
        type: "CAPTURE_STATE",
        trigger,
      });
      if (response?.success && response.state) {
        recordingStates.push(response.state);
        return { success: true, stateCount: recordingStates.length };
      }
      return { success: false, error: response?.error || "Capture failed after inject" };
    } catch (retryErr) {
      return { success: false, error: `Capture error: ${retryErr.message}` };
    }
  }
}

// ── Auto-capture on tab navigation during recording ─────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!recordingActive || tabId !== recordingTabId) return;
  if (changeInfo.status !== "complete") return;

  // Small delay to let content scripts load
  setTimeout(() => {
    captureRecordingState({ type: "navigation" }).then((result) => {
      if (result.success) {
        console.log(`[cffbrw] auto-captured navigation state (${result.stateCount} total)`);
      }
    });
  }, 500);
});

// ── Poll for paused browser_action steps ────────────────────────

async function pollPendingActions() {
  let gatewayUrl, workspaceToken;
  try {
    const result = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
    gatewayUrl = result.gatewayUrl || "http://localhost:8787";
    workspaceToken = result.workspaceToken || "";
  } catch { return; }

  let actions;
  try {
    const headers = {};
    if (workspaceToken) headers["Authorization"] = `Bearer ${workspaceToken}`;
    const res = await fetch(`${gatewayUrl}/v1/browser/pending-actions`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    actions = data.actions ?? [];
  } catch { return; }

  if (actions.length === 0) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { return; }

  const activeTab = tabs[0];
  if (!activeTab?.id) return;

  for (const action of actions) {
    await dispatchAction(action, activeTab.id, gatewayUrl, workspaceToken);
  }
}

// ── Execute a browser action ────────────────────────────────────

async function dispatchAction(action, tabId, gatewayUrl, workspaceToken) {
  const { runId, stepIndex, toolSchema, toolName, params } = action;

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_TOOL",
      toolSchema,
      toolName,
      params,
    });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-controller.bundle.js", "content.js"],
      });
      response = await chrome.tabs.sendMessage(tabId, {
        type: "EXECUTE_TOOL",
        toolSchema,
        toolName,
        params,
      });
    } catch (retryErr) {
      response = { success: false, error: `Content script error: ${retryErr.message}` };
    }
  }

  if (!response) {
    response = { success: false, error: "No response from content script" };
  }

  await postBrowserResult(gatewayUrl, workspaceToken, runId, stepIndex, response);
}

async function postBrowserResult(gatewayUrl, workspaceToken, runId, stepIndex, result) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (workspaceToken) headers["Authorization"] = `Bearer ${workspaceToken}`;

    const res = await fetch(`${gatewayUrl}/v1/runs/${runId}/browser-result/${stepIndex}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        success: result.success ?? false,
        output: result.output ?? null,
        error: result.error ?? undefined,
      }),
    });

    if (!res.ok) {
      console.warn(`[cffbrw] browser result POST failed: ${res.status}`);
    } else {
      console.log(`[cffbrw] browser action completed: run=${runId} step=${stepIndex} success=${result.success}`);
    }
  } catch (err) {
    console.warn(`[cffbrw] failed to post browser result:`, err);
  }
}
