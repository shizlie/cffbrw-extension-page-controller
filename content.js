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

    // After navigation, wait for the target form to appear by polling for a
    // known anchor element (submit button or first input). 300ms per nav click
    // isn't enough for React's commit + paint on slower pages. Without this,
    // fill/submit run against stale DOM and silently miss elements.
    const anchorSelector = tool.submitSelector
      || (tool.inputs?.[0]?.selector)
      || null;
    if (anchorSelector) {
      const ready = await waitForElement(anchorSelector, 3000);
      if (!ready) console.warn(`[cffbrw] form anchor never appeared: ${anchorSelector}`);
    }

    if (Array.isArray(tool.inputs)) {
      for (const input of tool.inputs) {
        const value = params?.[input.name];
        if (value === undefined || value === null) continue;
        // v3: Skip row-identifier params — they are templated into the submit
        // selector at exec time, not typed into a DOM input.
        if (input.selectorTemplate) continue;
        const el = findElement(input.selector, input.selectorStrategies, input.expectedProps);
        if (!el) { console.warn(`[cffbrw] input not found: ${input.selector}`); continue; }
        setInputValue(el, String(value));
      }
    }

    await sleep(100);

    // v3: If tool has submitSelectorTemplate, substitute params {name} into it.
    // Example: "[data-action=\"delete-contact-{contactId}\"]" + {contactId:"7"}
    //       => "[data-action=\"delete-contact-7\"]"
    // Fallback to submitSelector if template absent or substitution leaves
    // unresolved placeholders.
    const submitTarget = resolveSubmitSelector(tool, params);
    if (submitTarget) {
      const submitEl = findElement(submitTarget, tool.submitStrategies, tool.submitExpectedProps);
      if (!submitEl) return { success: false, error: `Submit not found: ${submitTarget}` };
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

// v3: If the tool has a submitSelectorTemplate (for row-scoped actions),
// substitute {paramName} placeholders with param values. Returns the resolved
// selector, or falls back to submitSelector if template has unfilled
// placeholders or is absent.
function resolveSubmitSelector(tool, params) {
  if (tool.submitSelectorTemplate) {
    const resolved = tool.submitSelectorTemplate.replace(/\{([^}]+)\}/g, (_m, name) => {
      const v = params?.[name];
      return v === undefined || v === null ? `{${name}}` : String(v);
    });
    // If any {placeholder} remains, fall back to literal selector
    if (!/\{[^}]+\}/.test(resolved)) return resolved;
    console.warn(`[cffbrw] submitSelectorTemplate has unfilled placeholders, falling back: ${resolved}`);
  }
  return tool.submitSelector || null;
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
  // Pick native prototype setter matching the element type. Calling an
  // InputElement setter on a SelectElement throws "Illegal invocation"
  // because the setter uses the "this" binding's internal slot.
  let setter;
  if (el.tagName === "SELECT") {
    // SELECT: find option matching value (case-insensitive) or option text,
    // fall back to literal value assignment. Dispatches change for React.
    const v = String(value);
    const byValue = Array.from(el.options).find((o) => o.value === v || o.value.toLowerCase() === v.toLowerCase());
    const byText = byValue || Array.from(el.options).find((o) => o.text.trim() === v || o.text.trim().toLowerCase() === v.toLowerCase());
    setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(el, byText?.value ?? v);
    else el.value = byText?.value ?? v;
  } else if (el.tagName === "TEXTAREA") {
    setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
  } else {
    setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll document for an element matching `selector` up to `timeoutMs`.
// Returns the element when found, null on timeout. Used post-navigation
// to confirm form DOM rendered before filling/submitting.
async function waitForElement(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch { return null; }
    await sleep(100);
  }
  return null;
}

async function waitForSignal(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (!document.querySelector(selector)) return true; } catch { return true; }
    await sleep(100);
  }
  return false;
}
