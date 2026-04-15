/**
 * CFFBRW Browser Bridge — Content Script (v2)
 *
 * Listens for messages from background / popup:
 *   EXECUTE_TOOL  — execute ToolSchema steps on current page DOM
 *   EXTRACT_DOM   — extract flat DOM tree + v2 selector strategies + verifyProps
 *   CAPTURE_STATE — capture current page state for recording mode
 *
 * v2 additions:
 *   - 7-tier selector strategy (id > testid > name > aria-label > placeholder > data-attr > text > xpath > css)
 *   - verifyProps: expected properties for execution-time verification
 *   - Multi-selector fallback for tool execution
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXECUTE_TOOL") {
    executeTool(message.toolSchema, message.toolName, message.params)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true; // async
  }

  if (message.type === "EXTRACT_DOM") {
    extractDom()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true; // async
  }

  if (message.type === "CAPTURE_STATE") {
    captureState(message.trigger || { type: "manual" })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true; // async
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

      // v2: Build 7-tier selector strategy with confidence scores
      const strategies = buildSelectorStrategies(el, node);
      selectorStrategies[String(index)] = strategies;

      // v2: Capture expected properties for verification
      verifyProps[String(index)] = buildVerifyProps(el);

      // Backward compat: best selector for selectorLookup
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

// ── Capture state for recording mode ─────────────────────────────

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

// ── 7-tier selector strategy builder ─────────────────────────────

function buildSelectorStrategies(el, node) {
  const strategies = [];

  // Tier 1: id
  if (el.id) {
    strategies.push({ type: "id", selector: `#${CSS.escape(el.id)}`, confidence: 1.0 });
  }

  // Tier 2: data-testid
  const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-cy");
  if (testId) {
    const attr = el.hasAttribute("data-testid") ? "data-testid"
      : el.hasAttribute("data-test-id") ? "data-test-id" : "data-cy";
    strategies.push({ type: "testid", selector: `[${attr}="${CSS.escape(testId)}"]`, confidence: 0.95 });
  }

  // Tier 3: name attribute
  if (el.name) {
    const tag = el.tagName.toLowerCase();
    strategies.push({ type: "name", selector: `${tag}[name="${CSS.escape(el.name)}"]`, confidence: 0.9 });
  }

  // Tier 4: aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    const tag = el.tagName.toLowerCase();
    strategies.push({ type: "aria-label", selector: `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`, confidence: 0.85 });
  }

  // Tier 5: placeholder
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) {
    const tag = el.tagName.toLowerCase();
    strategies.push({ type: "placeholder", selector: `${tag}[placeholder="${CSS.escape(placeholder)}"]`, confidence: 0.8 });
  }

  // Tier 6: data-* attributes (action, input, nav, etc.)
  for (const attr of ["data-action", "data-input", "data-nav", "data-role", "data-type"]) {
    const val = el.getAttribute(attr);
    if (val) {
      strategies.push({ type: "data-attr", selector: `[${attr}="${CSS.escape(val)}"]`, confidence: 0.75 });
      break; // one data-attr is enough
    }
  }

  // Tier 7: text content (for buttons, links, labels)
  const text = getVisibleText(el);
  if (text && text.length <= 60 && ["BUTTON", "A", "LABEL", "SPAN"].includes(el.tagName)) {
    const tag = el.tagName.toLowerCase();
    strategies.push({ type: "text", text, tag, confidence: 0.6 });
  }

  // Tier 8: xpath (from PageController if available)
  if (node.xpath) {
    strategies.push({ type: "xpath", selector: node.xpath, confidence: 0.5 });
  }

  // Tier 9: css (tag + class combo)
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string"
    ? `.${el.className.trim().split(/\s+/).map(CSS.escape).join(".")}`
    : "";
  if (cls) {
    strategies.push({ type: "css", selector: tag + cls, confidence: 0.3 });
  }

  return strategies;
}

// ── Verify props builder ─────────────────────────────────────────

function buildVerifyProps(el) {
  return {
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    text: getVisibleText(el) || null,
    placeholder: el.getAttribute("placeholder") || null,
    ariaLabel: el.getAttribute("aria-label") || null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function buildFallbackSelector(el) {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string"
    ? `.${el.className.trim().split(/\s+/).join(".")}`
    : "";
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
    return {
      success: false,
      error: `Tool "${toolName}" not found in schema. Available: ${toolSchema.tools.map((t) => t.name).join(", ")}`,
    };
  }

  try {
    // Step 1: Navigate — click nav selectors with fallback strategies
    if (Array.isArray(tool.navigation)) {
      for (let i = 0; i < tool.navigation.length; i++) {
        const strategies = tool.navigationStrategies?.[i]?.strategies;
        const expectedProps = tool.navigationStrategies?.[i]?.expectedProps;
        const el = findElement(tool.navigation[i], strategies, expectedProps);
        if (el) {
          el.click();
          await sleep(300);
        } else {
          console.warn(`[cffbrw] navigation element not found: ${tool.navigation[i]}`);
        }
      }
    }

    // Step 2: Fill inputs with fallback strategies
    if (Array.isArray(tool.inputs)) {
      for (const input of tool.inputs) {
        const value = params?.[input.name];
        if (value === undefined || value === null) continue;

        const el = findElement(input.selector, input.selectorStrategies, input.expectedProps);
        if (!el) {
          console.warn(`[cffbrw] input element not found: ${input.selector}`);
          continue;
        }

        setInputValue(el, String(value));
      }
    }

    await sleep(100);

    // Step 3: Submit with fallback strategies
    if (tool.submitSelector) {
      const submitEl = findElement(tool.submitSelector, tool.submitStrategies, tool.submitExpectedProps);
      if (!submitEl) {
        return { success: false, error: `Submit element not found: ${tool.submitSelector}` };
      }
      submitEl.click();
    }

    // Step 4: Wait for closeSignal
    if (tool.closeSignal) {
      const closed = await waitForSignal(tool.closeSignal, 5000);
      if (!closed) {
        console.warn(`[cffbrw] closeSignal "${tool.closeSignal}" did not resolve within 5s`);
      }
    }

    return {
      success: true,
      output: { toolName, params, completedAt: new Date().toISOString() },
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

// ── v2: Multi-selector element finder ────────────────────────────

function findElement(primarySelector, strategies, expectedProps) {
  // Try primary CSS selector first
  if (primarySelector) {
    try {
      const el = document.querySelector(primarySelector);
      if (el && verifyElement(el, expectedProps)) return el;
    } catch { /* invalid selector */ }
  }

  // Fallback through strategies ordered by confidence
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
  const elements = document.querySelectorAll(tag);
  for (const el of elements) {
    if ((el.textContent || "").trim() === text) return el;
  }
  for (const el of elements) {
    const elText = (el.textContent || "").trim();
    if (elText.includes(text) || text.includes(elText)) return el;
  }
  return null;
}

// ── Input value setter (React/Vue/Angular compatible) ────────────

function setInputValue(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  const setter = el.tagName === "TEXTAREA" ? nativeTextAreaValueSetter : nativeInputValueSetter;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSignal(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const el = document.querySelector(selector);
      if (!el) return true;
    } catch { return true; }
    await sleep(100);
  }
  return false;
}
