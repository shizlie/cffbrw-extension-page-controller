/**
 * CFFBRW Browser Bridge — Content Script
 *
 * Listens for EXECUTE_TOOL and EXTRACT_DOM messages from the background / popup.
 * EXECUTE_TOOL: executes ToolSchema steps on the current page DOM.
 * EXTRACT_DOM: injects page-controller.bundle.js and returns a flat DOM tree
 *              for the website compiler (POST /v1/browser/compile).
 * Returns { success, output } or { success: false, error } to the sender.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXECUTE_TOOL") {
    executeTool(message.toolSchema, message.toolName, message.params)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true; // async
  }

  if (message.type === "EXTRACT_DOM") {
    (async () => {
      try {
        if (!window.PageAgent?.PageController) {
          sendResponse({ success: false, error: "PageAgent not loaded" });
          return;
        }
        const controller = new window.PageAgent.PageController({ viewportExpansion: -1 });
        const state = await controller.getBrowserState({});

        // Build index → CSS selector lookup from the selectorMap
        // AI references elements by [N] index, we resolve to real selectors
        const selectorLookup = {};
        if (controller.selectorMap) {
          for (const [index, node] of controller.selectorMap.entries()) {
            const el = node.ref;
            if (!el) continue;
            // Best selector: id > data-* > tag+class combo > xpath
            if (el.id) {
              selectorLookup[index] = `#${el.id}`;
            } else if (el.getAttribute("data-input")) {
              selectorLookup[index] = `[data-input="${el.getAttribute("data-input")}"]`;
            } else if (el.getAttribute("data-action")) {
              selectorLookup[index] = `[data-action="${el.getAttribute("data-action")}"]`;
            } else if (el.getAttribute("data-nav")) {
              selectorLookup[index] = `[data-nav="${el.getAttribute("data-nav")}"]`;
            } else if (node.xpath) {
              selectorLookup[index] = node.xpath;
            } else {
              // Fallback: build selector from tag + classes
              const tag = el.tagName.toLowerCase();
              const cls = el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
              selectorLookup[index] = tag + cls;
            }
          }
        }

        sendResponse({
          success: true,
          flatTree: state.content,
          selectorLookup,
        });
      } catch (e) {
        sendResponse({ success: false, error: e.message || String(e) });
      }
    })();
    return true; // async
  }

  return false;
});

// ── Tool execution ────────────────────────────────────────────────

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
    // Step 1: Navigate — click nav selectors in order
    if (Array.isArray(tool.navigation)) {
      for (const selector of tool.navigation) {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          await sleep(300);
        } else {
          console.warn(`[cffbrw] navigation element not found: ${selector}`);
        }
      }
    }

    // Step 2: Fill inputs
    if (Array.isArray(tool.inputs)) {
      for (const input of tool.inputs) {
        const value = params?.[input.name];
        if (value === undefined || value === null) continue;

        const el = document.querySelector(input.selector);
        if (!el) {
          console.warn(`[cffbrw] input element not found: ${input.selector}`);
          continue;
        }

        // Set value and fire native input events so React/Vue/Angular detect the change
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, String(value));
        } else {
          el.value = String(value);
        }

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // Small pause after filling inputs before submit
    await sleep(100);

    // Step 3: Submit
    if (tool.submitSelector) {
      const submitEl = document.querySelector(tool.submitSelector);
      if (!submitEl) {
        return { success: false, error: `Submit element not found: ${tool.submitSelector}` };
      }
      submitEl.click();
    }

    // Step 4: Wait for closeSignal (optional)
    if (tool.closeSignal) {
      const closed = await waitForSignal(tool.closeSignal, 5000);
      if (!closed) {
        console.warn(`[cffbrw] closeSignal "${tool.closeSignal}" did not resolve within 5s`);
      }
    }

    return {
      success: true,
      output: {
        toolName,
        params,
        completedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll every 100ms for up to `timeoutMs` waiting for the element matching
 * `selector` to disappear from the DOM (or never appear).
 * Returns true if the signal resolved (element gone), false on timeout.
 */
async function waitForSignal(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector);
    if (!el) return true; // element gone — signal fired
    await sleep(100);
  }
  return false;
}
