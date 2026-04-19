/**
 * CFFBRW Browser Bridge — Recorder (v2)
 *
 * Event-driven recording: captures user interactions (click, focus, input, select, keydown)
 * and detects meaningful DOM state changes via PageController interactiveCount delta.
 *
 * Responsibilities:
 *   - Attach/detach global event listeners
 *   - MutationObserver for DOM change detection
 *   - Action logging (debounced input, deduped clicks)
 *   - State capture triggers (interactiveCount delta > 3, URL change, manual)
 *   - Auto-resume on content script re-injection
 */

/* global CffbrwOverlay */

const RECORDING_KEY = "cffbrw_recording";
const STATES_PREFIX = "cffbrw_state_";
const ACTIONS_KEY = "cffbrw_actions";
const META_KEY = "cffbrw_meta";

const INTERACTIVE_DELTA_THRESHOLD = 3;
const CLICK_DEDUP_MS = 300;
const INPUT_DEBOUNCE_MS = 500;
const STATE_CHANGE_DEBOUNCE_MS = 800;
const MAX_STATES = 20;
const MAX_ACTIONS = 500; // must match backend CompileRequestSchema cap
const SIZE_WARNING_BYTES = 8 * 1024 * 1024; // 8MB

// ── State ────────────────────────────────────────────────────────

let _controller = null;
let _observer = null;
let _lastInteractiveCount = 0;
let _lastUrl = "";
let _stateChangeTimer = null;
let _awaitingStateCheck = false;
let _inputTimers = new Map(); // elementIndex → timer
let _lastClickTime = 0;
let _lastClickIndex = -1;

// ── Public API (called by content.js) ────────────────────────────

window.CffbrwRecorder = {
  async startRecording() {
    await _initController();
    // Show overlay FIRST so subsequent updateCount calls have a target
    if (typeof CffbrwOverlay !== "undefined") {
      CffbrwOverlay.show();
      CffbrwOverlay.updateCount(0, 0);
    }
    await _captureState({ type: "initial" });
    _attachListeners();
    _startObserver();
    await _persistMeta({ active: true, tabId: null });
    return { success: true };
  },

  async stopRecording() {
    _detachListeners();
    _stopObserver();
    _flushAllInputs();
    const states = await _loadAllStates();
    const actions = await _loadActions();
    const cleaned = _deduplicateActions(actions, states);
    await _clearRecordingData();
    if (typeof CffbrwOverlay !== "undefined") CffbrwOverlay.hide();
    return { success: true, states, actions: cleaned };
  },

  async captureManual() {
    return _captureState({ type: "manual_capture" });
  },

  async checkAutoResume() {
    const meta = await _loadMeta();
    if (meta?.active) {
      await _initController();
      _attachListeners();
      _startObserver();
      await _captureState({ type: "navigation" });
      if (typeof CffbrwOverlay !== "undefined") {
        const states = await _loadAllStates();
        const actions = await _loadActions();
        CffbrwOverlay.show();
        CffbrwOverlay.updateCount(states.length, actions.length);
      }
    }
  },

  isRecording() {
    return _observer !== null;
  },
};

// ── Controller init ──────────────────────────────────────────────

async function _initController() {
  if (!window.PageAgent?.PageController) {
    throw new Error("PageAgent not loaded");
  }
  _controller = new window.PageAgent.PageController({ viewportExpansion: -1 });
  await _controller.updateTree();
  _lastInteractiveCount = _controller.selectorMap?.size || 0;
  _lastUrl = window.location.href;
}

// ── Event listeners ──────────────────────────────────────────────

function _attachListeners() {
  document.addEventListener("click", _onClickCapture, true);
  document.addEventListener("focus", _onFocusCapture, true);
  document.addEventListener("input", _onInputCapture, true);
  document.addEventListener("change", _onChangeCapture, true);
  document.addEventListener("keydown", _onKeydownCapture, true);
  window.addEventListener("popstate", _onUrlChange);
  window.addEventListener("hashchange", _onUrlChange);
}

function _detachListeners() {
  document.removeEventListener("click", _onClickCapture, true);
  document.removeEventListener("focus", _onFocusCapture, true);
  document.removeEventListener("input", _onInputCapture, true);
  document.removeEventListener("change", _onChangeCapture, true);
  document.removeEventListener("keydown", _onKeydownCapture, true);
  window.removeEventListener("popstate", _onUrlChange);
  window.removeEventListener("hashchange", _onUrlChange);
}

// ── Click handler ────────────────────────────────────────────────

function _onClickCapture(e) {
  const index = _findElementIndex(e.target);
  if (index === null) return;

  // Dedup: ignore duplicate clicks within 300ms on same element
  const now = Date.now();
  if (index === _lastClickIndex && (now - _lastClickTime) < CLICK_DEDUP_MS) return;
  _lastClickIndex = index;
  _lastClickTime = now;

  const el = e.target;
  _logAction({
    type: "click",
    elementIndex: index,
    text: _getVisibleText(el),
    tag: el.tagName.toLowerCase(),
    timestamp: now,
  });

  if (typeof CffbrwOverlay !== "undefined") {
    CffbrwOverlay.logEntry(`[${index}] Clicked "${_getVisibleText(el)}" (${el.tagName.toLowerCase()})`);
  }

  // Trigger state check after click
  _scheduleStateCheck();
}

// ── Focus handler ────────────────────────────────────────────────

function _onFocusCapture(e) {
  const index = _findElementIndex(e.target);
  if (index === null) return;

  const el = e.target;
  const label = _getFieldLabel(el);

  _logAction({
    type: "focus",
    elementIndex: index,
    tag: el.tagName.toLowerCase(),
    label: label || undefined,
    timestamp: Date.now(),
  });

  if (typeof CffbrwOverlay !== "undefined") {
    CffbrwOverlay.highlightFocus(index, label);
  }
}

// ── Input handler (debounced) ────────────────────────────────────

function _onInputCapture(e) {
  const index = _findElementIndex(e.target);
  if (index === null) return;

  // Clear existing timer for this element
  if (_inputTimers.has(index)) clearTimeout(_inputTimers.get(index));

  const el = e.target;
  const timer = setTimeout(() => {
    _inputTimers.delete(index);
    _commitInput(el, index);
  }, INPUT_DEBOUNCE_MS);

  _inputTimers.set(index, timer);

  // Live update in overlay (not committed yet)
  if (typeof CffbrwOverlay !== "undefined") {
    const label = _getFieldLabel(el);
    CffbrwOverlay.logEntryLive(`[${index}] Typing in ${label || el.tagName.toLowerCase()}...`);
  }
}

function _onChangeCapture(e) {
  const index = _findElementIndex(e.target);
  if (index === null) return;

  // For select elements, commit immediately
  if (e.target.tagName === "SELECT") {
    _commitInput(e.target, index);
    return;
  }

  // For other elements, flush pending input
  if (_inputTimers.has(index)) {
    clearTimeout(_inputTimers.get(index));
    _inputTimers.delete(index);
  }
  _commitInput(e.target, index);
}

function _commitInput(el, index) {
  const value = el.value;
  const label = _getFieldLabel(el);
  const isSelect = el.tagName === "SELECT";
  const selectedText = isSelect ? el.options?.[el.selectedIndex]?.text : undefined;

  _logAction({
    type: isSelect ? "select" : "input",
    elementIndex: index,
    value: value,
    selectedText: selectedText || undefined,
    tag: el.tagName.toLowerCase(),
    label: label || undefined,
    fieldType: el.type || undefined,
    timestamp: Date.now(),
  });

  if (typeof CffbrwOverlay !== "undefined") {
    const display = isSelect ? `Selected "${selectedText}"` : `"${_truncate(value, 30)}"`;
    CffbrwOverlay.logEntry(`[${index}] ${display} in ${label || el.tagName.toLowerCase()}`);
  }
}

function _flushAllInputs() {
  for (const [index, timer] of _inputTimers.entries()) {
    clearTimeout(timer);
    // Find element by index and commit
    if (_controller?.selectorMap) {
      const node = _controller.selectorMap.get(index);
      if (node?.ref) _commitInput(node.ref, index);
    }
  }
  _inputTimers.clear();
}

// ── Keydown handler ──────────────────────────────────────────────

function _onKeydownCapture(e) {
  // Only capture Enter, Space, Tab (interaction keys)
  if (!["Enter", " ", "Tab"].includes(e.key)) return;

  const index = _findElementIndex(e.target);
  if (index === null) return;

  _logAction({
    type: "keydown",
    elementIndex: index,
    key: e.key,
    tag: e.target.tagName.toLowerCase(),
    timestamp: Date.now(),
  });

  // Enter and Space can cause state changes (like click)
  if (e.key === "Enter" || e.key === " ") {
    _scheduleStateCheck();
  }

  // Flush pending input on Enter (form submission)
  if (e.key === "Enter") {
    _flushAllInputs();
  }
}

// ── URL change handler ───────────────────────────────────────────

function _onUrlChange() {
  if (window.location.href !== _lastUrl) {
    _lastUrl = window.location.href;
    _scheduleStateCheck();
  }
}

// ── State change detection ───────────────────────────────────────

function _scheduleStateCheck() {
  _awaitingStateCheck = true;
  if (_stateChangeTimer) clearTimeout(_stateChangeTimer);
  _stateChangeTimer = setTimeout(_checkStateChange, STATE_CHANGE_DEBOUNCE_MS);
}

async function _checkStateChange() {
  _stateChangeTimer = null;
  _awaitingStateCheck = false;
  if (!_controller) return;

  try {
    await _controller.updateTree();
    const newCount = _controller.selectorMap?.size || 0;
    const newUrl = window.location.href;
    const countDelta = Math.abs(newCount - _lastInteractiveCount);
    const urlChanged = newUrl !== _lastUrl;

    if (countDelta > INTERACTIVE_DELTA_THRESHOLD || urlChanged) {
      _lastInteractiveCount = newCount;
      _lastUrl = newUrl;

      // Mark the last click/keydown action as having caused a state change
      _markLastActionAsStateChange();

      await _captureState({
        type: urlChanged ? "navigation" : "dom_change",
        interactiveCountDelta: countDelta,
      });

      if (typeof CffbrwOverlay !== "undefined") {
        CffbrwOverlay.toast("State captured");
      }
    } else {
      _lastInteractiveCount = newCount;
    }
  } catch (err) {
    console.warn("[cffbrw] state check failed:", err);
  }
}

async function _markLastActionAsStateChange() {
  const actions = await _loadActions();
  if (actions.length > 0) {
    const last = actions[actions.length - 1];
    if (last.type === "click" || last.type === "keydown") {
      last.causedStateChange = true;
      await chrome.storage.session.set({ [ACTIONS_KEY]: actions });
    }
  }
}

// ── State capture ────────────────────────────────────────────────

async function _captureState(trigger) {
  if (!_controller) return { success: false, error: "No controller" };

  const meta = await _loadMeta();
  const stateCount = meta?.stateCount || 0;

  if (stateCount >= MAX_STATES) {
    if (typeof CffbrwOverlay !== "undefined") {
      CffbrwOverlay.toast("Max 20 states reached");
    }
    return { success: false, error: "Max states reached" };
  }

  // Ensure tree is fresh
  if (trigger.type !== "dom_change" && trigger.type !== "navigation") {
    await _controller.updateTree();
  }
  _lastInteractiveCount = _controller.selectorMap?.size || 0;
  _lastUrl = window.location.href;

  const state = await _controller.getBrowserState({});
  const selectorData = _buildSelectorData(_controller.selectorMap);

  const recordingState = {
    url: window.location.href,
    flatTree: state.content,
    selectorLookup: selectorData.lookup,
    selectorStrategies: selectorData.strategies,
    verifyProps: selectorData.verifyProps,
    trigger,
    interactiveCount: _lastInteractiveCount,
  };

  const newIndex = stateCount;
  await chrome.storage.session.set({
    [STATES_PREFIX + newIndex]: recordingState,
  });
  await _persistMeta({ ...meta, active: true, stateCount: newIndex + 1 });

  // Check storage size
  const bytesUsed = await chrome.storage.session.getBytesInUse(null);
  if (bytesUsed > SIZE_WARNING_BYTES) {
    if (typeof CffbrwOverlay !== "undefined") {
      CffbrwOverlay.toast("Storage nearly full — stop recording soon");
    }
  }

  // Update overlay
  const actions = await _loadActions();
  if (typeof CffbrwOverlay !== "undefined") {
    CffbrwOverlay.updateCount(newIndex + 1, actions.length);
  }

  // Notify background
  chrome.runtime.sendMessage({
    type: "RECORDING_STATE_CAPTURED",
    stateCount: newIndex + 1,
    actionCount: actions.length,
  }).catch(() => {}); // SW might be inactive

  return { success: true, stateCount: newIndex + 1 };
}

// ── Selector strategy builder (7-tier) ───────────────────────────

function _buildSelectorData(selectorMap) {
  const lookup = {};
  const strategies = {};
  const verifyProps = {};

  if (!selectorMap) return { lookup, strategies, verifyProps };

  for (const [index, node] of selectorMap.entries()) {
    const el = node.ref;
    if (!el) continue;

    const strats = _buildStrategies(el, node);
    strategies[String(index)] = strats;
    verifyProps[String(index)] = _buildVerifyProps(el);

    const best = strats.find((s) => s.selector);
    lookup[String(index)] = best?.selector || _fallbackSelector(el);
  }

  return { lookup, strategies, verifyProps };
}

function _buildStrategies(el, node) {
  const s = [];

  if (el.id) s.push({ type: "id", selector: `#${CSS.escape(el.id)}`, confidence: 1.0 });

  const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-cy");
  if (testId) {
    const attr = el.hasAttribute("data-testid") ? "data-testid" : el.hasAttribute("data-test-id") ? "data-test-id" : "data-cy";
    s.push({ type: "testid", selector: `[${attr}="${CSS.escape(testId)}"]`, confidence: 0.95 });
  }

  if (el.name) {
    s.push({ type: "name", selector: `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`, confidence: 0.9 });
  }

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    s.push({ type: "aria-label", selector: `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`, confidence: 0.85 });
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) {
    s.push({ type: "placeholder", selector: `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`, confidence: 0.8 });
  }

  for (const attr of ["data-action", "data-input", "data-nav", "data-role", "data-type"]) {
    const val = el.getAttribute(attr);
    if (val) { s.push({ type: "data-attr", selector: `[${attr}="${CSS.escape(val)}"]`, confidence: 0.75 }); break; }
  }

  const text = _getVisibleText(el);
  if (text && text.length <= 60 && ["BUTTON", "A", "LABEL", "SPAN"].includes(el.tagName)) {
    s.push({ type: "text", text, tag: el.tagName.toLowerCase(), confidence: 0.6 });
  }

  if (node.xpath) s.push({ type: "xpath", selector: node.xpath, confidence: 0.5 });

  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).map(CSS.escape).join(".")}` : "";
  if (cls) s.push({ type: "css", selector: tag + cls, confidence: 0.3 });

  return s;
}

function _buildVerifyProps(el) {
  return {
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    text: _getVisibleText(el) || null,
    placeholder: el.getAttribute("placeholder") || null,
    ariaLabel: el.getAttribute("aria-label") || null,
  };
}

function _fallbackSelector(el) {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return tag + cls;
}

// ── MutationObserver ─────────────────────────────────────────────

function _startObserver() {
  if (_observer) _observer.disconnect();
  _observer = new MutationObserver(() => {
    // Only extend debounce if we're already waiting for state check
    if (_awaitingStateCheck && _stateChangeTimer) {
      clearTimeout(_stateChangeTimer);
      _stateChangeTimer = setTimeout(_checkStateChange, STATE_CHANGE_DEBOUNCE_MS);
    }
  });
  _observer.observe(document.body, { childList: true, subtree: true });
}

function _stopObserver() {
  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }
}

// ── Action logging ───────────────────────────────────────────────

async function _logAction(action) {
  const meta = await _loadMeta();
  action.stateIndex = (meta?.stateCount || 1) - 1;

  const actions = await _loadActions();
  if (actions.length >= MAX_ACTIONS) {
    if (typeof CffbrwOverlay !== "undefined" && !meta?.actionCapWarned) {
      CffbrwOverlay.toast(`Max ${MAX_ACTIONS} actions reached — stop & compile`);
      await _persistMeta({ ...meta, actionCapWarned: true });
    }
    return; // drop action silently after warning
  }
  actions.push(action);
  await chrome.storage.session.set({ [ACTIONS_KEY]: actions });

  // Refresh overlay counter so user sees live feedback per action
  if (typeof CffbrwOverlay !== "undefined") {
    CffbrwOverlay.updateCount(meta?.stateCount || 1, actions.length);
  }
}

// ── Action dedup/validation ──────────────────────────────────────

function _deduplicateActions(actions, states) {
  const maxStateIndex = states.length - 1;
  const result = [];
  let prevClick = null;

  for (const action of actions) {
    // Drop actions referencing non-existent states
    if (action.stateIndex > maxStateIndex) continue;

    // Dedup clicks: skip if same element within 300ms
    if (action.type === "click") {
      if (prevClick && prevClick.elementIndex === action.elementIndex &&
          (action.timestamp - prevClick.timestamp) < CLICK_DEDUP_MS) {
        continue;
      }
      prevClick = action;
    }

    // Skip focus events that are immediately followed by input on same element
    if (action.type === "focus") {
      const nextIdx = actions.indexOf(action) + 1;
      if (nextIdx < actions.length) {
        const next = actions[nextIdx];
        if (next.type === "input" && next.elementIndex === action.elementIndex) continue;
      }
    }

    result.push(action);
  }

  return result;
}

// ── Storage helpers ──────────────────────────────────────────────

async function _loadMeta() {
  const result = await chrome.storage.session.get(META_KEY);
  return result[META_KEY] || null;
}

async function _persistMeta(meta) {
  await chrome.storage.session.set({ [META_KEY]: meta });
}

async function _loadActions() {
  const result = await chrome.storage.session.get(ACTIONS_KEY);
  return result[ACTIONS_KEY] || [];
}

async function _loadAllStates() {
  const meta = await _loadMeta();
  const count = meta?.stateCount || 0;
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(STATES_PREFIX + i);
  if (keys.length === 0) return [];
  const result = await chrome.storage.session.get(keys);
  const states = [];
  for (let i = 0; i < count; i++) {
    const s = result[STATES_PREFIX + i];
    if (s) states.push(s);
  }
  return states;
}

async function _clearRecordingData() {
  const meta = await _loadMeta();
  const count = meta?.stateCount || 0;
  const keys = [META_KEY, ACTIONS_KEY];
  for (let i = 0; i < count; i++) keys.push(STATES_PREFIX + i);
  await chrome.storage.session.remove(keys);
}

// ── Element index lookup ─────────────────────────────────────────

function _findElementIndex(el) {
  if (!_controller?.selectorMap) return null;
  for (const [index, node] of _controller.selectorMap.entries()) {
    if (node.ref === el) return index;
    // Check if el is a child of the indexed element
    if (node.ref?.contains(el)) return index;
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────

function _getVisibleText(el) {
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

function _getFieldLabel(el) {
  // Try aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // Try associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.textContent.trim();
  }

  // Try placeholder
  if (el.placeholder) return el.placeholder;

  // Try name
  if (el.name) return el.name;

  return null;
}

function _truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}
