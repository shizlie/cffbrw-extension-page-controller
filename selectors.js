/**
 * Selector allowlist / rejector. Runs in the recorder before strategies
 * are attached to a state or action. Rejects selectors that:
 *   - reference inline style ([style...]) — highly volatile
 *   - reference inline event handlers ([onclick], [onload], etc.)
 *   - use positional xpath deeper than MAX_XPATH_DEPTH (brittle)
 *
 * Keeps the selector strategy chain honest without touching confidence
 * scores — we just drop entries, letting the next strategy win.
 */

export const MAX_XPATH_DEPTH = 6;

const STYLE_RE = /\[\s*style\b/i;
const EVENT_HANDLER_RE = /\[\s*on[a-z]+\b/i;

function isDeepXPath(sel) {
  if (!sel || !sel.startsWith("/")) return false;
  // Count positional predicates [N] as depth markers.
  const depth = (sel.match(/\/[^/\[]+(?:\[\d+\])?/g) || []).length;
  return depth > MAX_XPATH_DEPTH;
}

export function filterStrategies(strategies) {
  if (!Array.isArray(strategies)) return [];
  return strategies.filter((s) => {
    const sel = s?.selector || "";
    if (STYLE_RE.test(sel)) return false;
    if (EVENT_HANDLER_RE.test(sel)) return false;
    if (s?.type === "xpath" && isDeepXPath(sel)) return false;
    return true;
  });
}

// Expose as global for classic content-script consumption (no ES module support).
// Guard for non-browser environments (e.g. vitest/Node).
if (typeof window !== "undefined") {
  window.__cffbrwFilterStrategies = filterStrategies;
}
