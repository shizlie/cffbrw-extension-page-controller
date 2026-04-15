/**
 * CFFBRW Browser Bridge — Popup script
 * Loads/saves settings from chrome.storage.local.
 */

const gatewayInput = document.getElementById("gateway");
const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// Load saved values on open
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

  // Basic URL validation
  try {
    new URL(gatewayUrl);
  } catch {
    showStatus("Invalid URL format", "err");
    return;
  }

  chrome.storage.local.set({ gatewayUrl, workspaceToken }, () => {
    showStatus("Saved.", "ok");
    // Ping the gateway to verify connection
    pingGateway(gatewayUrl, workspaceToken);
  });
});

function pingGateway(gatewayUrl, token) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  fetch(`${gatewayUrl}/health`, { headers })
    .then((res) => {
      if (res.ok) {
        showStatus("Connected to gateway.", "ok");
      } else {
        showStatus(`Gateway returned ${res.status}`, "err");
      }
    })
    .catch(() => {
      showStatus("Gateway unreachable (saved anyway).", "err");
    });
}

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = type || "";
}

// ── Compile current page ─────────────────────────────────────────

document.getElementById("compile").addEventListener("click", async () => {
  const result = document.getElementById("schema-result");
  result.style.display = "none";
  showStatus("Extracting DOM...", "");

  const { gatewayUrl, workspaceToken } = await chrome.storage.local.get(["gatewayUrl", "workspaceToken"]);

  if (!gatewayUrl) {
    showStatus("Save a Gateway URL first", "err");
    return;
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    showStatus("Error: " + e.message, "err");
    return;
  }

  if (!tab || !tab.id) {
    showStatus("No active tab found", "err");
    return;
  }

  // Ask content script to extract DOM via PageAgent
  let domResponse;
  try {
    domResponse = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" });
  } catch (e) {
    showStatus("DOM extract error: " + e.message, "err");
    return;
  }

  if (!domResponse || !domResponse.success) {
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
