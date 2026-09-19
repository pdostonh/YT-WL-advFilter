# Watch Later Adv Filter (private, no API key)

Niche Chrome extension (Manifest V3) for your own use. No Web Store, no OAuth, no API license.

## What it does (only on `youtube.com/playlist?list=WL`)

- **Toolbar on the WL page** (Shadow DOM, `wlavf-` prefix, isolated from other YouTube extensions):
  `Subs-only` · `Open clean in new window` · `Collab check (slow, off by default)` · `Shuffle` · `Load all` · `Cancel` · `Scan subs` · `Import/Export list` · `Verify collabs` · `Show all`.
- **Subs-only filter (the core feature)**: hides WL rows whose channel is not in your cached subs. Never deletes anything; hiding is `display:none` + `data-wlavf-*`, reversible with `Show all` or toggling off.
- **Reliability rules**:
  - Matching is ID/handle first, exact display-name match as fallback — so `/channel/UC…` in WL still matches `/@handle` in subs (and `"Artist - Topic"` aliases).
  - Rows with no channel signal at all (deleted/private videos, YouTube markup changes) are **kept visible** and counted as unknown — a page change can never wipe the list.
  - Filter/shuffle apply to **loaded** rows; use `Load all` (auto-scroll + cancel) first for the full playlist. New lazy-loaded rows are re-filtered automatically.
- **Subs source**: (1) one-time `Scan subs` that reads `/feed/channels` in place (rendered anchors + `ytInitialData` fallback, works on the JS shell) and caches to `chrome.storage.local`, (2) `Import list` (.txt one-per-line or .json), (3) `Export` writes deduped JSON + TXT for re-upload.
- **Collab check (secondary, opt-in)**: YouTube's new co-author UI is read best-effort from watch pages; `Verify collabs` fetches visible videos 3-at-a-time, caches, never hides on uncertainty. Off by default to keep the main filter fast.
- **Random order**: Fisher–Yates over loaded rows; `Load all` first for full-playlist shuffle.
- **Click behavior**: plain left-click on a WL row opens `https://www.youtube.com/watch?v=ID` (+`t` only, `list`/`index` stripped) in a **new separate window** via `chrome.windows.create`; video stays in Watch Later. Single message send (callback form, no double-open). Ctrl/Cmd/Shift/middle-click untouched.

## Install (unpacked, private)

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. Open `https://www.youtube.com/playlist?list=WL` (logged in).
3. Toolbar appears above the playlist. `Scan subs` once (or `Import list`), then `Subs-only`.

## Files

- `manifest.json` — MV3, `storage` + `windows`, content scripts `wlavf-lib.js` then `content.js` on `/playlist*` only (never on watch pages).
- `src/wlavf-lib.js` — pure helpers (no browser globals), shared by the extension and the tests.
- `src/content.js` — page logic, Shadow DOM toolbar, SPA-navigation aware.
- `src/background.js` — service worker: only `chrome.windows.create` for clean URLs.
- `src/popup.html` — pointer to the WL page (controls stay on WL per your choice).
- `test/run-tests.cjs` — `node test/run-tests.cjs` (49 assertions: parsing, matching incl. alias fallback, import formats, scan-HTML extraction, manifest wiring).

## Manual check after install

1. WL page shows toolbar; counts line reads `Loaded/Shown/Hidden/Subs cached`.
2. `Scan subs` reports N channels; `Export` downloads JSON + TXT; re-`Import` of the TXT gives the same count.
3. `Subs-only` hides non-subscribed, keeps unknown rows (status says how many), lists hidden channels under Advanced.
4. Plain click opens a clean URL in a new window (no `list=WL`); Ctrl+click unchanged.
5. `Shuffle` reorders; `Load all` grows the loaded count; `Show all` restores everything.
