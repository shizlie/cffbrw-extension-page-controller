# Packaging & Distribution — CFFBRW Browser Bridge

How to ship the extension to alpha users. Two paths: Chrome Web Store (polished, recommended) and manual `.zip` sideload (fastest, requires Developer Mode).

## TL;DR decision

| need | use |
|---|---|
| Auto-updates + no dev-mode warning banner | **Chrome Web Store Unlisted** (requires one-time $5 dev fee + ~1-3 day review) |
| Ship in 10 minutes, user can load it today | **Manual `.zip` sideload** (user must enable Developer Mode) |
| Private to 1-5 testers, iterate daily | `.zip` sideload |
| Ready for 20+ alpha users | Chrome Web Store Unlisted |

Chrome killed `.crx` self-hosting in 2018. Outside of the Store, "Load Unpacked" is the only path.

## Prerequisites (both paths)

Before any package, sync the latest code from the main repo to the public extension repo. The extension lives in TWO places:
- `~/Codes/workspaces/hcproduct-cffbrw/dubai/.context/extension-v2/` (dev staging, in main-repo worktree)
- `~/Codes/hcproduct-cffbrw/cffbrw-extension-page-controller-public-repo/` (public repo, what Chrome loads AND what users audit on GitHub)

They must match before any `.zip` ships.

```bash
# From main repo
cd ~/Codes/workspaces/hcproduct-cffbrw/dubai

EXT=~/Codes/hcproduct-cffbrw/cffbrw-extension-page-controller-public-repo
WS=.context/extension-v2

for f in recorder.js overlay.js content.js background.js popup.js popup.html manifest.json; do
  cp "$WS/$f" "$EXT/$f"
done

cd $EXT
git status --short           # review what changed
git add -A
git commit -m "sync: <describe changes>"
git push origin main
```

Verify bundle is fresh (only needed if `entry.js` changed):

```bash
cd $EXT
ls -lh page-controller.bundle.js  # ~100KB+
bun install                        # first time only
bun run bundle                     # produces page-controller.bundle.js from entry.js
```

## Path 1: Chrome Web Store — Unlisted (recommended)

Unlisted = not searchable, not in the public store, but anyone with the URL can install. Ideal for closed alpha. Users get auto-updates and no "Developer Mode" warning.

### One-time setup

1. **Dev account** — https://chrome.google.com/webstore/devconsole. One-time $5 fee.
2. **Icons** — need 16x16, 48x48, 128x128. `manifest.json` currently has none. Add:
   ```json
   "icons": {
     "16":  "icons/icon-16.png",
     "48":  "icons/icon-48.png",
     "128": "icons/icon-128.png"
   },
   "action": {
     "default_popup": "popup.html",
     "default_icon": {
       "16": "icons/icon-16.png",
       "48": "icons/icon-48.png",
       "128": "icons/icon-128.png"
     }
   }
   ```
   Create `icons/` directory + commit PNGs. Simple CFFBRW wordmark is fine for alpha.
3. **Screenshots** — 1280x800 or 640x400 PNGs of the popup in use. Min 1, max 5. Literal screenshots of `/browser-demo` with extension open work.
4. **Privacy policy URL** — required for any extension with `<all_urls>` host permission. Put a short page at `cffbrw.com/extension-privacy` covering: what's collected (nothing unless user clicks Compile or Record), where it's sent (user's configured gateway URL), retention (ephemeral unless workflow saves).

### Package + upload

```bash
cd $EXT

# Clean dev junk
rm -rf node_modules .DS_Store

# Create zip — Store wants exactly what's in the extension folder
zip -r ../cffbrw-extension-v0.2.0.zip . \
  -x ".git/*" -x "node_modules/*" -x "*.DS_Store" -x "entry.js" -x "package.json" -x "bun.lock" -x "ALPHA_GUIDE.md" -x "PACKAGING.md"

# Verify zip contents
unzip -l ../cffbrw-extension-v0.2.0.zip
# should list: manifest.json, background.js, content.js, recorder.js, overlay.js,
#              popup.html, popup.js, page-controller.bundle.js, icons/*
```

Upload flow:
1. Developer Console → **New item**
2. Drag the `.zip`
3. Fill Store listing: name, summary (<132 chars), description, category = Developer Tools, language
4. **Visibility = Unlisted**
5. **Distribution = Public** (anyone with link — not searchable)
6. Submit for review

Review time: 1-3 days typical for unlisted dev tools.

### Share with alpha users

Once approved, Store gives a URL: `https://chrome.google.com/webstore/detail/<id>`. Send that to users. They click Install — done. Auto-updates push every time you upload a new `.zip` with bumped `manifest.version`.

## Path 2: Manual `.zip` sideload (fastest)

No review. User opts into Developer Mode. Lowest friction for 1-10 private testers.

### Package

```bash
cd $EXT
zip -r ../cffbrw-extension-v0.2.0.zip . \
  -x ".git/*" -x "node_modules/*" -x "*.DS_Store" -x "entry.js" -x "package.json" -x "bun.lock"
ls -lh ../cffbrw-extension-v0.2.0.zip
```

### User install instructions (paste to alpha users verbatim)

> **Install CFFBRW Browser Bridge**
>
> 1. Download the zip: [link]
> 2. Unzip. You get `cffbrw-extension-page-controller-public-repo/`.
> 3. Open Chrome → `chrome://extensions`
> 4. Top-right, toggle **Developer mode** ON
> 5. Click **Load unpacked**, select the unzipped folder
> 6. Pin the extension (puzzle icon in toolbar → pin)
> 7. Click the icon. Set Gateway URL, click Save. Status shows "Connected."
>
> **Updating**: re-download zip, replace the folder, go to `chrome://extensions`, click refresh icon on the extension.

Caveat: Chrome shows a "Disable developer mode extensions" banner every restart. Annoying for daily users. Migrate to Chrome Web Store Unlisted as soon as you have >5 users.

### Host the zip

Options:
- **GitHub Releases** (recommended):
  ```bash
  gh release create v0.2.0 ../cffbrw-extension-v0.2.0.zip \
    -R shizlie/cffbrw-extension-page-controller \
    --notes "Alpha release: multi-page recording, row-pattern templating, recording persistence"
  ```
  Stable download URL, version history, release notes.
- **Direct link** (Dropbox / S3) — works but no versioning.
- **Never email the zip** — Gmail flags extensions as executables and strips them.

## Enterprise / managed distribution

For enterprise customers later, Chrome supports `ExtensionInstallForcelist` policy that preloads the extension on managed devices. Out of scope for alpha.

## Version bumping

Before every release, bump `manifest.json`:

```json
"version": "0.2.0"
```

Chrome Web Store rejects uploads with same-or-lower version.

For alpha iteration speed: `0.2.1`, `0.2.2`, `0.2.3`... patch-per-release. Save `0.3.0` for the next significant UX shift.

## Checklist before every release

1. `git status` on public repo clean — no uncommitted source changes
2. `bun run bundle` if `entry.js` changed — verify `page-controller.bundle.js` is fresh
3. Bump `manifest.json` version
4. Update `ALPHA_GUIDE.md` if user-visible UX changed
5. Smoke-test: `chrome://extensions` → reload → open `/browser-demo` → run Quick Compile + a Record flow → verify compile succeeds
6. `zip -r ../cffbrw-extension-v<X.Y.Z>.zip . -x '.git/*' -x 'node_modules/*'`
7. Test the zip: unzip elsewhere, Load Unpacked, confirm it works
8. Upload to Store OR publish GitHub Release
9. Commit tag: `cd $EXT && git tag v<X.Y.Z> && git push --tags`
10. Send install link to alpha list

## Keeping main repo and public extension repo in sync

The extension lives in two places (see Prerequisites above). Every extension change made during feature development MUST be copied to the public repo AND pushed to its remote before closing the PR. Otherwise users running the published `.zip` don't see the fix.

Quick sync alias (add to `~/.zshrc`):

```bash
alias cffbrw-sync-ext='
  WS=~/Codes/workspaces/hcproduct-cffbrw/dubai/.context/extension-v2
  EXT=~/Codes/hcproduct-cffbrw/cffbrw-extension-page-controller-public-repo
  for f in recorder.js overlay.js content.js background.js popup.js popup.html manifest.json; do
    cp "$WS/$f" "$EXT/$f"
  done
  cd "$EXT" && git status --short
'
```

Run `cffbrw-sync-ext` → review `git status` in the public repo → commit + push.

**CI guard (follow-up work):** add a pre-merge hook that runs `diff -q` across both paths and fails if they diverge. Prevents the "public repo is a commit behind" problem.

## Release-note template for alpha users

When sending the install link to alpha testers, include a short release note. Template:

> **CFFBRW Browser Bridge v0.2.0 — Alpha**
>
> Install / update: [Store link or GitHub Release zip]
>
> **New in this release:**
> - [user-facing capability 1]
> - [user-facing capability 2]
>
> **Known issues:**
> - [known gotcha if any]
>
> **How to report bugs:** [github issues link or email]
>
> Thanks for testing!
