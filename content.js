/**
 * CFFBRW Browser Bridge — Content Script (v2)
 *
 * Message orchestration layer. Delegates to:
 *   - CffbrwRecorder (recorder.js) for recording mode
 *   - CffbrwOverlay (overlay.js) for visual feedback
 *   - PageController (page-controller.bundle.js) for DOM extraction + tool execution
 *
 * Messages from background/popup:
 *   EXTRACT_DOM    — extract DOM + v2 selector strategies (quick compile)
 *   EXECUTE_TOOL   — execute ToolSchema step on page
 *   CAPTURE_STATE  — capture current state for recording
 *   START_RECORDING — begin event-driven recording
 *   STOP_RECORDING  — stop recording, return states + actions
 *   CAPTURE_MANUAL  — force capture current state during recording
 */

// ── Auto-resume check on injection ───────────────────────────────
// If recording was active and page navigated, resume automatically
if (typeof CffbrwRecorder !== "undefined") {
  CffbrwRecorder.checkAutoResume().catch((err) => {
    console.warn("[cffbrw] auto-resume failed:", err);
  });
}

// ── Message handler ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT_DOM") {
    extractDom()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "EXECUTE_TOOL") {
    executeTool(message.toolSchema, message.toolName, message.params)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "START_RECORDING") {
    if (typeof CffbrwRecorder === "undefined") {
      sendResponse({ success: false, error: "Recorder not loaded" });
      return false;
    }
    CffbrwRecorder.startRecording()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    if (typeof CffbrwRecorder === "undefined") {
      sendResponse({ success: false, error: "Recorder not loaded" });
      return false;
    }
    CffbrwRecorder.stopRecording()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "CAPTURE_MANUAL") {
    if (typeof CffbrwRecorder === "undefined") {
      sendResponse({ success: false, error: "Recorder not loaded" });
      return false;
    }
    CffbrwRecorder.captureManual()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "CAPTURE_STATE") {
    captureState(message.trigger || { type: "manual" })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "COMPILE_UPDATE") {
    if (typeof CffbrwOverlay !== "undefined") {
      CffbrwOverlay.setCompileStatus(message);
    }
    return false;
  }

  return false;
});

// ── DOM Extraction (v2 with selector strategies) ──────────────────

async function extractDom() {
  if (!window.PageAgent?.PageController) {
    return { success: false, error: "PageAgent not loaded" };
  }

  const controller = new window.PageAgent.PageController({ viewportExpansion: -1 });
  const state = await controller.getBrowserState({});

  const selectorLookup = {};
  const selectorStrategies = {};
  const verifyProps = {};

  if (controller.selectorMap) {
    for (const [index, node] of controller.selectorMap.entries()) {
      const el = node.ref;
      if (!el) continue;

      const strategies = buildSelectorStrategies(el, node);
      selectorStrategies[String(index)] = strategies;
      verifyProps[String(index)] = buildVerifyProps(el);

      const best = strategies.find((s) => s.selector);
      selectorLookup[String(index)] = best?.selector || buildFallbackSelector(el);
    }
  }

  return {
    success: true,
    flatTree: state.content,
    selectorLookup,
    selectorStrategies,
    verifyProps,
    interactiveCount: controller.selectorMap?.size || 0,
    url: window.location.href,
  };
}

async function captureState(trigger) {
  const dom = await extractDom();
  if (!dom.success) return dom;
  return {
    success: true,
    state: {
      url: window.location.href,
      flatTree: dom.flatTree,
      selectorLookup: dom.selectorLookup,
      selectorStrategies: dom.selectorStrategies,
      verifyProps: dom.verifyProps,
      trigger,
      interactiveCount: dom.interactiveCount,
    },
  };
}

// ── Selector strategies (shared with recorder.js for quick compile) ──

function buildSelectorStrategies(el, node) {
  const s = [];
  if (el.id) s.push({ type: "id", selector: `#${CSS.escape(el.id)}`, confidence: 1.0 });

  const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-cy");
  if (testId) {
    const attr = el.hasAttribute("data-testid") ? "data-testid" : el.hasAttribute("data-test-id") ? "data-test-id" : "data-cy";
    s.push({ type: "testid", selector: `[${attr}="${CSS.escape(testId)}"]`, confidence: 0.95 });
  }
  if (el.name) s.push({ type: "name", selector: `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`, confidence: 0.9 });
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) s.push({ type: "aria-label", selector: `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`, confidence: 0.85 });
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) s.push({ type: "placeholder", selector: `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`, confidence: 0.8 });
  for (const attr of ["data-action", "data-input", "data-nav", "data-role", "data-type"]) {
    const val = el.getAttribute(attr);
    if (val) { s.push({ type: "data-attr", selector: `[${attr}="${CSS.escape(val)}"]`, confidence: 0.75 }); break; }
  }
  const text = getVisibleText(el);
  if (text && text.length <= 60 && ["BUTTON", "A", "LABEL", "SPAN"].includes(el.tagName)) {
    s.push({ type: "text", text, tag: el.tagName.toLowerCase(), confidence: 0.6 });
  }
  if (node.xpath) s.push({ type: "xpath", selector: node.xpath, confidence: 0.5 });
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).map(CSS.escape).join(".")}` : "";
  if (cls) s.push({ type: "css", selector: tag + cls, confidence: 0.3 });
  return s;
}

function buildVerifyProps(el) {
  return {
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    text: getVisibleText(el) || null,
    placeholder: el.getAttribute("placeholder") || null,
    ariaLabel: el.getAttribute("aria-label") || null,
  };
}

function buildFallbackSelector(el) {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return tag + cls;
}

function getVisibleText(el) {
  const text = (el.textContent || "").trim();
  if (el.children.length === 0) return text;
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent.trim();
      if (t) return t;
    }
  }
  return text.length <= 60 ? text : "";
}

// ── Tool execution (v2 with multi-selector fallback) ─────────────

async function executeTool(toolSchema, toolName, params) {
  if (!toolSchema || !Array.isArray(toolSchema.tools)) {
    return { success: false, error: "Invalid toolSchema: missing tools array" };
  }
  const tool = toolSchema.tools.find((t) => t.name === toolName);
  if (!tool) {
    return { success: false, error: `Tool "${toolName}" not found. Available: ${toolSchema.tools.map((t) => t.name).join(", ")}` };
  }

  try {
    if (Array.isArray(tool.navigation)) {
      for (let i = 0; i < tool.navigation.length; i++) {
        const strategies = tool.navigationStrategies?.[i]?.strategies;
        const expectedProps = tool.navigationStrategies?.[i]?.expectedProps;
        const el = findElement(tool.navigation[i], strategies, expectedProps);
        if (el) { el.click(); await sleep(300); }
        else console.warn(`[cffbrw] nav not found: ${tool.navigation[i]}`);
      }
    }

    if (Array.isArray(tool.inputs)) {
      for (const input of tool.inputs) {
        const value = params?.[input.name];
        if (value === undefined || value === null) continue;
        const el = findElement(input.selector, input.selectorStrategies, input.expectedProps);
        if (!el) { console.warn(`[cffbrw] input not found: ${input.selector}`); continue; }
        setInputValue(el, String(value));
      }
    }

    await sleep(100);

    if (tool.submitSelector) {
      const submitEl = findElement(tool.submitSelector, tool.submitStrategies, tool.submitExpectedProps);
      if (!submitEl) return { success: false, error: `Submit not found: ${tool.submitSelector}` };
      submitEl.click();
    }

    if (tool.closeSignal) {
      await waitForSignal(tool.closeSignal, 5000);
    }

    return { success: true, output: { toolName, params, completedAt: new Date().toISOString() } };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

function findElement(primarySelector, strategies, expectedProps) {
  if (primarySelector) {
    try {
      const el = document.querySelector(primarySelector);
      if (el && verifyElement(el, expectedProps)) return el;
    } catch { /* invalid selector */ }
  }
  if (!Array.isArray(strategies)) {
    try { return document.querySelector(primarySelector); } catch { return null; }
  }
  const sorted = [...strategies].sort((a, b) => b.confidence - a.confidence);
  for (const strat of sorted) {
    let el = null;
    if (strat.type === "text" && strat.text && strat.tag) {
      el = findByText(strat.tag, strat.text);
    } else if (strat.selector) {
      try { el = document.querySelector(strat.selector); } catch { /* skip */ }
    }
    if (el && verifyElement(el, expectedProps)) return el;
  }
  return null;
}

function verifyElement(el, expectedProps) {
  if (!expectedProps) return true;
  if (expectedProps.tag && el.tagName.toLowerCase() !== expectedProps.tag) return false;
  if (expectedProps.type && el.type !== expectedProps.type) return false;
  return true;
}

function findByText(tag, text) {
  const els = document.querySelectorAll(tag);
  for (const el of els) { if ((el.textContent || "").trim() === text) return el; }
  for (const el of els) {
    const t = (el.textContent || "").trim();
    if (t.includes(text) || text.includes(t)) return el;
  }
  return null;
}

function setInputValue(el, value) {
  const setter = el.tagName === "TEXTAREA"
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
    : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSignal(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (!document.querySelector(selector)) return true; } catch { return true; }
    await sleep(100);
  }
  return false;
}
