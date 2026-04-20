/**
 * Selector allowlist / rejector. Runs in the recorder before strategies
 * are attached to a state or action. Rejects selectors that:
 *   - reference inline style ([style...]) — highly volatile
 *   - reference inline event handlers ([onclick], [onload], etc.)
 *   - use positional xpath deeper than MAX_XPATH_DEPTH (brittle)
 *
 * Classic script (NOT ES module) because content_scripts in MV3 are
 * loaded as classic scripts. `export` keyword throws SyntaxError at parse
 * time in this context. Exposes filterStrategies via globalThis so
 * recorder.js can read window.__cffbrwFilterStrategies. Tests import this
 * file dynamically — vitest runs it, the IIFE attaches to globalThis,
 * tests read from there.
 */

(function (g) {
  var MAX_XPATH_DEPTH = 6;
  var STYLE_RE = /\[\s*style\b/i;
  var EVENT_HANDLER_RE = /\[\s*on[a-z]+\b/i;

  function isDeepXPath(sel) {
    if (!sel || !sel.startsWith("/")) return false;
    var depth = (sel.match(/\/[^/\[]+(?:\[\d+\])?/g) || []).length;
    return depth > MAX_XPATH_DEPTH;
  }

  function filterStrategies(strategies) {
    if (!Array.isArray(strategies)) return [];
    return strategies.filter(function (s) {
      var sel = (s && s.selector) || "";
      if (STYLE_RE.test(sel)) return false;
      if (EVENT_HANDLER_RE.test(sel)) return false;
      if (s && s.type === "xpath" && isDeepXPath(sel)) return false;
      return true;
    });
  }

  g.__cffbrwFilterStrategies = filterStrategies;
  g.__cffbrwMaxXpathDepth = MAX_XPATH_DEPTH;
})(typeof window !== "undefined" ? window : globalThis);
