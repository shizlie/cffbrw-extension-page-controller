/**
 * CFFBRW Browser Bridge — Background Service Worker (v2)
 *
 * Two modes:
 *   1. Polling: GET /v1/browser/pending-actions every 2s
 *   2. Recording relay: forwards messages between popup ↔ content script
 *
 * Recording state lives in chrome.storage.session (survives SW restart).
 * This file is a thin relay — recorder.js in content script owns the logic.
 */

const ALARM_NAME = "cffbrw-poll";
const POLL_INTERVAL_MINUTES = 2 / 60; // ~2s in dev

// ── Install ─────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["gatewayUrl", "workspaceToken"], (result) => {
    if (!result.gatewayUrl) {
      chrome.storage.local.set({ gatewayUrl: "http://localhost:8787" });
    }
  });
  // Unlock full 10MB session storage (default is 1MB per item)
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
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

// ── Message relay ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Recording: relay popup commands to active tab's content script
  if (message.type === "START_RECORDING") {
    relayToTab(message.tabId, { type: "START_RECORDING" }, sendResponse);
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    getRecordingTabId().then((tabId) => {
      if (!tabId) { sendResponse({ success: false, error: "No recording tab" }); return; }
      relayToTab(tabId, { type: "STOP_RECORDING" }, sendResponse);
    });
    return true;
  }

  if (message.type === "CAPTURE_MANUAL") {
    getRecordingTabId().then((tabId) => {
      if (!tabId) { sendResponse({ success: false, error: "No recording tab" }); return; }
      relayToTab(tabId, { type: "CAPTURE_MANUAL" }, sendResponse);
    });
    return true;
  }

  if (message.type === "STOP_FROM_OVERLAY") {
    // Overlay stop button — stop + compile via background (survives popup close)
    getRecordingTabId().then((tabId) => {
      if (!tabId) return;
      stopAndCompileRecording(tabId);
    });
    return false;
  }

  if (message.type === "STOP_AND_COMPILE") {
    // Popup stop button — same flow, but can optionally wait
    getRecordingTabId().then((tabId) => {
      if (!tabId) { sendResponse({ success: false, error: "No recording tab" }); return; }
      stopAndCompileRecording(tabId);
      sendResponse({ success: true, started: true }); // returns immediately
    });
    return true;
  }

  if (message.type === "COMPILE_QUICK") {
    // Popup "Compile current page" — run via background
    getActiveTabId().then((tabId) => {
      if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }
      compileQuick(tabId);
      sendResponse({ success: true, started: true });
    });
    return true;
  }

  if (message.type === "GET_RECORDING_STATUS") {
    chrome.storage.session.get("cffbrw_meta", (result) => {
      const meta = result.cffbrw_meta;
      sendResponse({
        active: meta?.active || false,
        stateCount: meta?.stateCount || 0,
        tabId: meta?.tabId || null,
      });
    });
    return true;
  }

  if (message.type === "RECORDING_STATE_CAPTURED") {
    // Content script notifying us of state capture — update meta with tabId
    if (sender.tab?.id) {
      chrome.storage.session.get("cffbrw_meta", (result) => {
        const meta = result.cffbrw_meta || {};
        meta.tabId = sender.tab.id;
        chrome.storage.session.set({ cffbrw_meta: meta });
      });
    }
    return false;
  }

  return false;
});

// ── Compile orchestration (survives popup close) ────────────────

async function stopAndCompileRecording(tabId) {
  await setCompileStatus({ state: "stopping", mode: "recording" });
  let stopped;
  try {
    stopped = await chrome.tabs.sendMessage(tabId, { type: "STOP_RECORDING" });
  } catch (e) {
    await setCompileStatus({ state: "error", error: "Stop failed: " + e.message });
    notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "error", error: "Stop failed" });
    return;
  }
  if (!stopped?.success || !stopped.states?.length) {
    await setCompileStatus({ state: "error", error: "No states recorded" });
    notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "error", error: "No states" });
    return;
  }

  await setCompileStatus({
    state: "compiling",
    mode: "recording",
    stateCount: stopped.states.length,
    actionCount: stopped.actions?.length || 0,
  });
  notifyOverlay(tabId, {
    type: "COMPILE_UPDATE", state: "compiling",
    stateCount: stopped.states.length, actionCount: stopped.actions?.length || 0,
  });

  const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
  const headers = { "Content-Type": "application/json" };
  if (workspaceToken) headers["Authorization"] = "Bearer " + workspaceToken;
  const siteUrl = stopped.states[0]?.url || "unknown";

  try {
    const res = await fetch(gatewayUrl + "/v1/browser/compile", {
      method: "POST", headers,
      body: JSON.stringify({ siteUrl, recording: true, states: stopped.states, actions: stopped.actions }),
    });
    const data = await res.json();
    if (!res.ok) {
      await setCompileStatus({ state: "error", error: data.error || ("HTTP " + res.status) });
      notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "error", error: data.error || "HTTP " + res.status });
      return;
    }
    await persistLastSchema({ id: data.toolSchemaId, recordingId: data.recordingId, siteUrl, mode: "recording", compiledAt: data.compiledAt, tools: data.tools });
    await setCompileStatus({ state: "done", toolSchemaId: data.toolSchemaId });
    notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "done", toolSchemaId: data.toolSchemaId, toolCount: (data.tools || []).length });
  } catch (e) {
    await setCompileStatus({ state: "error", error: e.message });
    notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "error", error: e.message });
  }
}

async function compileQuick(tabId) {
  await setCompileStatus({ state: "extracting", mode: "quick" });
  notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "extracting" });

  let dom;
  try {
    dom = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-controller.bundle.js", "overlay.js", "recorder.js", "content.js"],
      });
      dom = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
    } catch (retryErr) {
      await setCompileStatus({ state: "error", error: "DOM extract: " + retryErr.message });
      return;
    }
  }
  if (!dom?.success) {
    await setCompileStatus({ state: "error", error: dom?.error || "DOM extract failed" });
    return;
  }

  await setCompileStatus({ state: "compiling", mode: "quick" });
  notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "compiling" });

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);
  const headers = { "Content-Type": "application/json" };
  if (workspaceToken) headers["Authorization"] = "Bearer " + workspaceToken;

  try {
    const res = await fetch(gatewayUrl + "/v1/browser/compile", {
      method: "POST", headers,
      body: JSON.stringify({
        siteUrl: tab?.url || dom.url,
        domSnapshots: { main: dom.flatTree },
        selectorLookup: dom.selectorLookup || {},
        selectorStrategies: dom.selectorStrategies,
        verifyProps: dom.verifyProps,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      await setCompileStatus({ state: "error", error: data.error || ("HTTP " + res.status) });
      return;
    }
    await persistLastSchema({ id: data.toolSchemaId, recordingId: data.recordingId || null, siteUrl: data.siteUrl, mode: "quick", compiledAt: data.compiledAt, tools: data.tools });
    await setCompileStatus({ state: "done", toolSchemaId: data.toolSchemaId });
    notifyOverlay(tabId, { type: "COMPILE_UPDATE", state: "done", toolSchemaId: data.toolSchemaId, toolCount: (data.tools || []).length });
  } catch (e) {
    await setCompileStatus({ state: "error", error: e.message });
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id || null;
}

async function setCompileStatus(status) {
  await chrome.storage.session.set({
    cffbrw_compile_status: { ...status, at: Date.now() },
  });
}

async function persistLastSchema(info) {
  await chrome.storage.local.set({
    cffbrw_last_schema: { ...info, at: Date.now() },
  });
}

function notifyOverlay(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── Message relay ─────────────────────────────────────────────

async function relayToTab(tabId, message, sendResponse) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    sendResponse(response);
  } catch (err) {
    // Try injecting content scripts first
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-controller.bundle.js", "overlay.js", "recorder.js", "content.js"],
      });
      const response = await chrome.tabs.sendMessage(tabId, message);
      sendResponse(response);
    } catch (retryErr) {
      sendResponse({ success: false, error: `Content script error: ${retryErr.message}` });
    }
  }
}

async function getRecordingTabId() {
  const result = await chrome.storage.session.get("cffbrw_meta");
  const meta = result.cffbrw_meta;
  if (meta?.tabId) return meta.tabId;
  // Fallback: active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id || null;
}

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
  try { tabs = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch { return; }

  const activeTab = tabs[0];
  if (!activeTab?.id) return;

  for (const action of actions) {
    await dispatchAction(action, activeTab.id, gatewayUrl, workspaceToken);
  }
}

async function dispatchAction(action, tabId, gatewayUrl, workspaceToken) {
  const { runId, stepIndex, toolSchema, toolName, params } = action;

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_TOOL", toolSchema, toolName, params,
    });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-controller.bundle.js", "overlay.js", "recorder.js", "content.js"],
      });
      response = await chrome.tabs.sendMessage(tabId, {
        type: "EXECUTE_TOOL", toolSchema, toolName, params,
      });
    } catch (retryErr) {
      response = { success: false, error: `Content script error: ${retryErr.message}` };
    }
  }

  if (!response) response = { success: false, error: "No response from content script" };

  await postBrowserResult(gatewayUrl, workspaceToken, runId, stepIndex, response);
}

async function postBrowserResult(gatewayUrl, workspaceToken, runId, stepIndex, result) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (workspaceToken) headers["Authorization"] = `Bearer ${workspaceToken}`;
    const res = await fetch(`${gatewayUrl}/v1/runs/${runId}/browser-result/${stepIndex}`, {
      method: "POST", headers,
      body: JSON.stringify({
        success: result.success ?? false,
        output: result.output ?? null,
        error: result.error ?? undefined,
      }),
    });
    if (!res.ok) console.warn(`[cffbrw] browser result POST failed: ${res.status}`);
    else console.log(`[cffbrw] action done: run=${runId} step=${stepIndex} ok=${result.success}`);
  } catch (err) {
    console.warn(`[cffbrw] failed to post browser result:`, err);
  }
}
