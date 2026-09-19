# Watch Later Adv Filter (private, no API key)

> **AI-generated code warning**: this extension was written by an AI coding assistant, not a human developer. It works as described and is covered by automated tests (`node test/run-tests.cjs`) plus a manual checklist below — but review the code yourself before trusting it, especially the click-interception and filtering logic. Use at your own risk.

Niche Chrome extension (Manifest V3) for your own use. No Web Store, no OAuth, no API license.

## What it does (only on `youtube.com/playlist?list=WL`)

- **Toolbar on the WL page** (Shadow DOM, `wlavf-` prefix, isolated from other YouTube extensions):
  `Subs-only` · `Open clean in new tab` · `Collab check (slow, off by default)` · `Shuffle` · `Load all` · `Cancel` · `Scan subs` · `Import/Export list` · `Verify collabs` · `Show all`.
- **Subs-only filter (the core feature)**: hides WL rows whose channel is not in your cached subs. Never deletes anything; hiding is `display:none` + `data-wlavf-*`, reversible with `Show all` or toggling off.
- **Reliability rules**:
  - Matching is ID/handle first, exact display-name match as fallback — so `/channel/UC…` in WL still matches `/@handle` in subs (and `"Artist - Topic"` aliases).
  - Rows with no channel signal at all (deleted/private videos, YouTube markup changes) are **kept visible** and counted as unknown — a page change can never wipe the list.
  - Filter/shuffle apply to **loaded** rows; use `Load all` (auto-scroll + cancel) first for the full playlist. New lazy-loaded rows are re-filtered automatically.
- **Subs source**: (1) one-time `Scan subs` that reads `/feed/channels` in place (rendered anchors + `ytInitialData` fallback, works on the JS shell) and caches to `chrome.storage.local`, (2) `Import list` (.txt one-per-line or .json), (3) `Export` writes deduped JSON + TXT for re-upload.
- **Collab check (secondary, opt-in)**: YouTube's new co-author UI is read best-effort from watch pages; `Verify collabs` fetches visible videos 3-at-a-time, caches, never hides on uncertainty. Off by default to keep the main filter fast.
- **Random order**: Fisher–Yates over loaded rows; `Load all` first for full-playlist shuffle.
- **Click behavior**: plain left-click on a WL row opens `https://www.youtube.com/watch?v=ID` (+`t` only, `list`/`index` stripped) in a **new foreground tab of the same window** via `chrome.tabs.create`; video stays in Watch Later. Single message send (callback form, no double-open). Ctrl/Cmd/Shift/middle-click untouched.

## Install (unpacked, private)

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. Open `https://www.youtube.com/playlist?list=WL` (logged in).
3. Toolbar appears in the left sidebar, under the Play all / Shuffle buttons. `Scan subs` once (or `Import list`), then `Subs-only`.

## Files

- `manifest.json` — MV3, `storage` only, content scripts `wlavf-lib.js` then `content.js` on `/playlist*` only (never on watch pages).
- `src/wlavf-lib.js` — pure helpers (no browser globals), shared by the extension and the tests.
- `src/content.js` — page logic, Shadow DOM toolbar, SPA-navigation aware.
- `src/background.js` — service worker: only `chrome.tabs.create` for clean URLs.
- `src/popup.html` — pointer to the WL page (controls stay on WL per your choice).
- `test/run-tests.cjs` — `node test/run-tests.cjs` (49 assertions: parsing, matching incl. alias fallback, import formats, scan-HTML extraction, manifest wiring).

## Security & privacy

- **Manifest V3**, default content security policy. No remote code, no `eval`, no third-party requests.
- **Permissions and why**: `storage` (local subs + settings cache) plus host access to `*.youtube.com` only (read the WL page, one-time `/feed/channels` scan, optional watch-page fetch for collab check, open clean watch URLs in a new tab). No `<all_urls>`, `tabs`, `cookies`, or `identity`.
- **Nothing leaves your machine**: subscriptions are cached in `chrome.storage.local`; export writes local files. No analytics, no API keys, no accounts.
- **Narrow runtime scope**: the content script loads only on `/playlist*` pages and activates only when `list=WL` (youtube.com hosts). It never touches watch pages, never calls playlist-delete APIs, and intercepts only plain left-clicks on WL rows (Ctrl/Cmd/Shift/middle-click untouched).
- **Input safety**: the toolbar is a static template in Shadow DOM; all YouTube-derived strings go through `textContent`, never `innerHTML`. The background worker allowlists URLs (`youtube.com/watch` + video id) before opening them.
- **Install warning is expected**: Chrome shows "read and change your data on youtube.com" — that is exactly what filtering the WL page requires. This extension is side-loaded for private use, not from the Web Store.

## Updating

`git pull`, then `chrome://extensions` → reload the extension (or remove + Load unpacked again).

## Troubleshooting

- **No toolbar on the WL page**: reload the WL tab (content scripts only inject on page load — tabs already open during install/update stay untouched until reloaded). Then check `chrome://extensions` → Errors for this extension, and the page console (F12) for `[wlavf]` lines: `boot on …` means the script runs; `toolbar injected` means it rendered; `not a WL page` means the URL didn't match `youtube.com/playlist?list=WL`.
- **Subs-only hides too much**: check Advanced → unmatched channels for ID/handle alias mismatches, or re-run `Scan subs`.

## Manual check after install

1. WL page shows toolbar; counts line reads `Loaded/Shown/Hidden/Subs cached`.
2. `Scan subs` reports N channels; `Export` downloads JSON + TXT; re-`Import` of the TXT gives the same count.
3. `Subs-only` hides non-subscribed, keeps unknown rows (status says how many), lists hidden channels under Advanced.
4. Plain click opens a clean URL in a new tab (no `list=WL`); Ctrl+click unchanged.
5. `Shuffle` reorders; `Load all` grows the loaded count; `Show all` restores everything.
