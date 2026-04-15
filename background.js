/**
 * CFFBRW Browser Bridge — Background Service Worker
 *
 * Polls GET /v1/browser/pending-actions every 2s for browser_action steps
 * that are paused in active workflow runs. When found, dispatches to content
 * script for execution, then POSTs result back to resume the workflow.
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

  // Send to content script for execution
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_TOOL",
      toolSchema,
      toolName,
      params,
    });
  } catch (err) {
    // Try injecting content script first
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

  // POST result back to resume the workflow step
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
