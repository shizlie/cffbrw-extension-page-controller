# CFFBRW Browser Bridge — Closed Alpha Guide

> **You are an invited alpha tester.** This feature is not publicly available yet. Everything here is subject to change. Your feedback shapes what ships next.

---

## What does this do?

The CFFBRW Browser Bridge is a Chrome extension that lets your CFFBRW workflows interact with any website — without building a custom integration.

The idea: instead of writing a scraper or waiting for an API, you open the website in Chrome, click **Compile current page**, and the AI reads the page structure once. It produces a **Tool Schema** — a precise map of every form and action on that page. From then on, your workflows call tools like `add_contact`, `submit_order`, or `log_activity` and the extension executes them deterministically, with no AI at runtime.

**Why this is different from browser automation:**
- Regular automation re-interprets the page on every run (slow, fragile)
- This approach reads the page once at compile time, executes a recipe every time after
- Compile: ~15 seconds, one AI call. Execute: ~700ms, zero AI calls.

**How selectors work (index-based, rigid):**
- The extension extracts a simplified DOM with numbered elements: `[0] <button>Save</button>`, `[1] <input placeholder="Name">`
- AI references elements by `[N]` index only — it never generates CSS selectors
- The extension builds a lookup table mapping each index to a real CSS selector from the DOM
- Post-compilation resolves AI indices to actual selectors deterministically
- Result: zero hallucinated selectors, every target is a real DOM element

---

## Before you start

You need:
- A CFFBRW account (you received this invite because you have one)
- Chrome 116 or newer
- Your CFFBRW API key — go to **Settings → API Keys → Create Key** in your dashboard. It starts with `wfk_`.

---

## Step 1 — Set up the extension

### 1a. Build the bundle

The extension requires one file that must be built before use: `page-controller.bundle.js`.

> **This step requires [bun](https://bun.sh) installed on your machine.**
> Run `curl -fsSL https://bun.sh/install | bash` if you don't have it.

From the `cffbrw-extension-page-controller` folder:

```bash
cd cffbrw-extension-page-controller
bun install
bun run bundle
```

This downloads `@page-agent/page-controller` and bundles it into `page-controller.bundle.js`. The `entry.js` wrapper ensures `window.PageAgent` is exported for the content script.

You only need to run this once. The file will be pre-built and included in the zip for future releases.

**Verify the folder now contains these 7 files:**
```
manifest.json
background.js
content.js
popup.html
popup.js
entry.js
page-controller.bundle.js   ← must be present
```

### 1b. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select this folder (`cffbrw-extension-page-controller`)
5. "CFFBRW Browser Bridge" appears in your extensions list

**Pin it to your toolbar:** Click the puzzle-piece icon (🧩) in Chrome's toolbar → find "CFFBRW Browser Bridge" → click the pin icon. You'll need quick access to the popup.

---

## Step 2 — Configure the extension

1. Click the **CFFBRW Bridge** icon in your Chrome toolbar
2. Set **Gateway URL** to: `https://api.cffbrw.com` (or `http://localhost:8787` for local dev)
3. Set **API Token** to your `wfk_...` key (optional for local dev)
4. Click **Save**

The status line should show **"Connected to gateway."** in green. If it shows an error, double-check your API key — the key must be from a published workspace, not a draft.

The pulsing green dot at the bottom of the popup means the extension is polling for pending workflow actions every 2 seconds. This is normal.

---

## Step 3 — Try the demo CRM

There is a built-in demo CRM app to test against before you try your own tools.

### 3a. Open the demo

**Local dev:** `http://localhost:5173/browser-demo`
**Production:** `https://cffbrw.com/browser-demo`

The demo is a multi-page CRM with 4 sections:

| Page | Interactive elements |
|---|---|
| **Contacts** | Search, status filter, add contact (5 fields + notes), delete |
| **Deals** | New deal (title, contact dropdown, amount, stage, close date), delete |
| **Tasks** | New task (title, assignee, priority), toggle checkbox, delete |
| **Settings** | Company name, timezone, currency, notifications checkbox, save |

### 3b. Compile the page

1. Make sure you're on the demo CRM page in Chrome
2. Click the CFFBRW Bridge extension icon
3. Click **Compile current page**
4. The popup shows:
   - "Extracting DOM..." — extension reads the page structure + builds selector lookup
   - "Compiling (AI)..." — AI analyses the structure once (10–20 seconds)
   - **Tool Schema ID** — a 16-character hex string like `3787d18f91225cd9`
5. Copy the Tool Schema ID

You have just taught CFFBRW everything it needs to know about this page. It will never need to read the page again.

**Note:** The compiler only sees elements visible on the current view. To compile forms on other pages (Deals, Tasks, Settings), navigate to each page and compile separately. Each compile produces a separate Tool Schema ID.

---

## Step 4 — Run a workflow with browser_action steps

In your CFFBRW dashboard, create a new workflow. Use the markdown below as a template (replace the Tool Schema ID with yours from Step 3):

### Example: Delete a contact

```markdown
# Delete a CRM contact

## Steps

### 1. Delete Alice Chen
Use browser tool `delete_alice_chen` from schema `3787d18f91225cd9`.
```

### Example: Navigate and add a contact

```markdown
# Add a new contact to CRM

## Inputs
- name: Full name (string)
- email: Email address (string)
- company: Company name (string)

## Steps

### 1. Open add contact form
Use browser tool `add_new_contact` from schema `3787d18f91225cd9`.

### 2. Fill and submit form
Use browser tool `submit_contact` from schema `<SCHEMA_ID_FROM_ADD_FORM>`:
- contact-name: {{name}}
- contact-email: {{email}}
- contact-company: {{company}}
```

> **Important:** Step 2 requires a separate Tool Schema compiled from the "Add Contact" form view. Navigate to the add contact form first, then compile that page to get a second Schema ID.

### What happens when you run it

1. Compile the workflow
2. Click **Run** (enter inputs if prompted)
3. **Keep Chrome open on the demo CRM tab** — the extension needs an active tab on the target site
4. The workflow step pauses with status **"Awaiting browser action"**
5. The extension picks up the action within 2 seconds (polls `/v1/browser/pending-actions`)
6. Extension executes the tool on the active tab: nav clicks → fill inputs → submit
7. Extension POSTs result back to `POST /v1/runs/:runId/browser-result/:stepIndex`
8. Workflow step resumes with the result
9. Workflow continues to next step or completes

---

## Step 5 — Compile your own site

The same flow works on any website you can access in Chrome:

1. Navigate to the exact page you want to automate (the form or action screen — not the homepage)
2. Click the CFFBRW Bridge icon
3. Click **Compile current page**
4. Copy the Tool Schema ID
5. Use it in a workflow with `browser_action` steps referencing that schema

**Tips for better compilation:**
- Be on the specific screen you want to automate — the compiler reads what is visible, not the entire site
- For modal-based forms (e.g. "Add Contact" opens a dialog), open the modal before compiling
- Sites on a VPN work fine — compilation runs in your browser, not on our servers
- The extension adds `data-*` attribute selectors when available (most reliable), falls back to tag+class combos
- Each compile produces a new Schema ID — use the latest one

---

## Step 6 — View compiled schemas

Check all your compiled Tool Schemas:

```bash
# List all schemas for your workspace
curl -H "Authorization: Bearer wfk_YOUR_KEY" \
  https://api.cffbrw.com/v1/browser/schemas

# View a specific schema
curl -H "Authorization: Bearer wfk_YOUR_KEY" \
  https://api.cffbrw.com/v1/browser/schemas/3787d18f91225cd9
```

The response shows every tool with its name, description, input fields, and CSS selectors. You can verify the selectors match real elements on the page.

---

## Known limitations in this alpha

| Limitation | Workaround |
|---|---|
| One screen per compile | Navigate to each screen separately, compile each, note the Schema IDs |
| Chrome must be open during execution | Keep a Chrome window with the target tab open while your workflow runs |
| SPAs may not expose all screens at once | Navigate to the specific screen/modal state before compiling |
| Page redesigns invalidate schemas | Re-compile after significant UI changes to the target site |
| Compiling the same page twice creates two schemas | No deduplication yet — use the latest ID |
| `page-controller.bundle.js` requires manual build | Will be pre-built in the zip for beta |
| Hidden form views not compiled | Navigate to each form page and compile separately |
| Browser action timeout: 5 minutes | Extension must execute and respond within 5 min or step fails |

---

## Troubleshooting

**"DOM error: PageAgent not loaded"**
`page-controller.bundle.js` is missing or didn't export correctly. Re-run `bun run bundle` and verify the file exists. If the issue persists, check that `entry.js` exists in the folder — it's the wrapper that makes `window.PageAgent` available.

**"Could not establish connection" in console**
Refresh the target page after loading/reloading the extension. Content scripts only inject on page load — if the extension was loaded after the page, a refresh is needed. This error can also come from other extensions (check the source in DevTools).

**"Compile error: 401 Unauthorized"**
Your API token is wrong or expired. Go to Settings → API Keys in the dashboard and create a new key.

**"Compile error: 400 VALIDATION_ERROR"**
The Gateway URL may be set incorrectly. It should be exactly `https://api.cffbrw.com` with no trailing slash. For local dev, use `http://localhost:8787`.

**Workflow step stays at "Awaiting browser action" and never completes**
Three possible causes:
1. Extension is not running — check that the Bridge icon is visible in Chrome's toolbar and the popup shows the green polling dot
2. No tab is open on the target site — the extension executes against the active tab; open a tab on that site
3. The target page has changed since compilation — re-compile to get fresh selectors

**Tool names in the compiled schema are wrong or missing**
The AI infers tool names from the page content. If names are poor (e.g. `button_3`), the page may have no descriptive labels. Try: navigate directly to the form, ensure field labels are visible on screen, then recompile.

**Selectors point to wrong elements**
The index-based system maps AI references to real DOM elements. If the page has dynamic content that changes element order between compile and execute, selectors may drift. Solution: compile when the page is in its stable/default state.

---

## What to send us

This alpha exists to find edge cases before we open it up. When you test, please note and share:

- **Which sites compiled cleanly** and what tools were detected
- **Which sites failed** — what error appeared, what URL/type of site
- **Tool names** — did the AI describe the tools accurately?
- **Selector quality** — check the schema JSON, do selectors use IDs/data-attributes (good) or long class chains (fragile)?
- **Execution** — did the workflow fill and submit forms correctly?
- **Latency** — compile time and execution time (rough estimates are fine)
- **Anything surprising** — good or bad

Send to the shared Slack channel, or reply to the invite email.

---

## How it works (for the curious)

```
Your browser                    CFFBRW Gateway (CF Workers)
─────────────────────           ──────────────────────────────
Extension popup
  │ "Compile current page"
  ↓
content.js: PageController
  │ getBrowserState()
  │ → simplified HTML with [N] indices
  │ → selectorLookup: {0: "#btn", 1: "[data-input='name']", ...}
  │
  ↓ popup.js
  │                             POST /v1/browser/compile
  ├─ domSnapshots (HTML)  ───→  compileWebsite(snapshots, selectorLookup)
  ├─ selectorLookup       ───→    │ Gemini 2.5 Flash (once)
  │                                │ AI outputs: [N] indices only
  │                                │ Resolver: index → real CSS selector
  │                                ↓
  │                              ToolSchema stored in D1
  ←──────────────────────────── { toolSchemaId }
  popup shows Schema ID

──── later, when a workflow runs ─────────────────────────────

WorkflowRunner hits
browser_action step
  │ executeBrowserAction()
  │ loads ToolSchema from D1
  │ broadcasts step:paused
  │ waitForEvent('browser-action-N')
  │ D1: run status = 'paused'
  │
Extension background.js
  │ polls every 2s
  ←──────────────────────────── GET /v1/browser/pending-actions
  │ { runId, stepIndex, toolSchema, toolName, params }
  ↓
content.js executes:
  1. nav clicks (open form)
  2. fill inputs (native setter + input/change events)
  3. click submit
  4. wait for close signal
  │
  │                             POST /v1/runs/:runId/browser-result/:stepIndex
  ────────────────────────────→ { success: true, output }
                                  │ gateway forwards to agent DO
                                  │ agent sends workflow event
                                  ↓
                                waitForEvent resumes
                                step completes with output
                                workflow continues
```

### Key design decisions

- **Index-based compilation:** AI never generates CSS selectors. It references `[N]` element indices from PageController's simplified HTML. Selectors are resolved deterministically from the extension's DOM lookup. This prevents hallucinated selectors.
- **D1 storage:** Tool Schemas are stored in D1 (SQLite), not KV cache. They're first-class artifacts with workspace scoping, queryable history, and no TTL expiry.
- **waitForEvent pattern:** Browser action steps use the same pause/resume mechanism as human approval gates. The workflow pauses durably (survives worker restarts) and resumes when the extension posts its result.
- **Native input setter:** The extension uses `HTMLInputElement.prototype.value.set` to fill inputs, bypassing React/Vue/Angular's synthetic event system. This ensures framework state updates correctly.
