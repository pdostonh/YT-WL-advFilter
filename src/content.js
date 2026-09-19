/* WL Adv Filter (private) — content script.
 * Runs ONLY on youtube.com/playlist* and activates ONLY when list=WL.
 * Pure helpers live in src/wlavf-lib.js (loaded first, shared with tests).
 * Isolation: IIFE, no page globals, `wlavf-` prefix, Shadow DOM toolbar,
 * inline hide only (display:none + data attrs), no prototype patching.
 */
(() => {
  'use strict';

  const LIB = (typeof globalThis !== 'undefined' && globalThis.__WLAVF_LIB) || null;
  if (!LIB) {
    try { console.warn('[wlavf] shared lib missing — extension idle'); } catch (_e) { /* ignore */ }
    return;
  }

  const P = 'wlavf-';
  const MSG_OPEN = 'WLAVF_OPEN_CLEAN';
  const LOG = '[wlavf]';

  function log(...args) {
    try { console.log(LOG, ...args); } catch (_e) { /* ignore */ }
  }
  const LS_KEYS = { subsOnly: P + 'subsOnly', cleanOpen: P + 'cleanOpen', deepCollab: P + 'deepCollab' };
  const STORE_SUBS = P + 'subs';       // { map, updatedAt }
  const STORE_COLLAB = P + 'collabs';  // { videoId: {authors, at} } — secondary, on-demand only

  const state = {
    active: false,
    subsOnly: false,
    cleanOpen: true,
    deepCollab: false, // secondary nice-to-have; primary subs filter must stay fast
    subsMap: {},
    subsUpdatedAt: 0,
    collabCache: {},
    verifying: false,
    verifyAbort: false,
    lastUrl: location.href,
    rowObserver: null,
  };

  /* ---------- utils ---------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function isWlPage() {
    return LIB.isWlUrl(location.href);
  }

  /* ---------- playlist parsing (WL page only) ---------- */

  function getVideoRows() {
    // Primary: classic playlist renderers. Secondary: newer lockup view models
    // inside the playlist container. Never match outside the container.
    const container = $('ytd-playlist-video-list-renderer #contents');
    let rows = $$('ytd-playlist-video-renderer');
    if (container) {
      $$('yt-lockup-view-model', container).forEach((el) => {
        if (rows.indexOf(el) === -1) rows.push(el);
      });
    }
    if (!rows.length && container) rows = Array.from(container.children);
    return rows.filter((el) => el && el.querySelector && el.querySelector('a[href*="watch?v="]'));
  }

  function parseRow(row) {
    const titleA = row.querySelector('a#video-title') || row.querySelector('a[href*="watch?v="]');
    const href = titleA ? titleA.getAttribute('href') : null;
    const videoId = LIB.videoIdFromHref(href);
    const title = titleA ? (titleA.textContent || '').trim() : '';
    const chA =
      row.querySelector('ytd-channel-name a[href]') ||
      row.querySelector('a[href^="/@"]') ||
      row.querySelector('a[href^="/channel/"]') ||
      row.querySelector('a[href^="/c/"]') ||
      row.querySelector('a[href^="/user/"]');
    const chHref = chA ? chA.getAttribute('href') : null;
    const chName = chA ? (chA.textContent || '').trim() : '';
    const chUrl = LIB.resolveUrl(chHref, location.origin);
    return { row, videoId, title, href, chHref, chName, chUrl, chKey: LIB.channelKey(chHref || chUrl || '') };
  }

  /* ---------- storage ---------- */

  async function loadPersisted() {
    try {
      const got = await chrome.storage.local.get([LS_KEYS.subsOnly, LS_KEYS.cleanOpen, LS_KEYS.deepCollab, STORE_SUBS, STORE_COLLAB]);
      if (typeof got[LS_KEYS.subsOnly] === 'boolean') state.subsOnly = got[LS_KEYS.subsOnly];
      if (typeof got[LS_KEYS.cleanOpen] === 'boolean') state.cleanOpen = got[LS_KEYS.cleanOpen];
      if (typeof got[LS_KEYS.deepCollab] === 'boolean') state.deepCollab = got[LS_KEYS.deepCollab];
      if (got[STORE_SUBS] && got[STORE_SUBS].map) {
        state.subsMap = got[STORE_SUBS].map;
        state.subsUpdatedAt = got[STORE_SUBS].updatedAt || 0;
      }
      if (got[STORE_COLLAB]) state.collabCache = got[STORE_COLLAB];
    } catch (_e) { /* storage unavailable — run memory-only */ }
  }

  async function saveToggles() {
    try {
      await chrome.storage.local.set({
        [LS_KEYS.subsOnly]: state.subsOnly,
        [LS_KEYS.cleanOpen]: state.cleanOpen,
        [LS_KEYS.deepCollab]: state.deepCollab,
      });
    } catch (_e) { /* ignore */ }
  }

  async function saveSubs() {
    try {
      await chrome.storage.local.set({ [STORE_SUBS]: { map: state.subsMap, updatedAt: state.subsUpdatedAt } });
    } catch (_e) { /* ignore */ }
  }

  async function saveCollabCache() {
    try {
      const ids = Object.keys(state.collabCache);
      if (ids.length > 3000) {
        ids.slice(0, ids.length - 3000).forEach((k) => delete state.collabCache[k]);
      }
      await chrome.storage.local.set({ [STORE_COLLAB]: state.collabCache });
    } catch (_e) { /* ignore */ }
  }

  /* ---------- subs: scan / import / export ---------- */

  function subsCount() { return LIB.canonicalCount(state.subsMap); }

  /** One-time scrape of /feed/channels (same-origin fetch, no navigation). */
  async function scanSubscriptions(status) {
    status('Scanning /feed/channels…');
    const res = await fetch('https://www.youtube.com/feed/channels', { credentials: 'include', headers: { accept: 'text/html' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — open youtube.com/feed/channels once while logged in, then retry.');
    const html = await res.text();
    const items = [];
    // Pass 1: rendered component anchors (with display titles).
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const anchors = doc.querySelectorAll(
        'ytd-grid-channel-renderer a[href], ytd-expanded-shelf-contents-renderer a[href], ' +
        'ytd-channel-renderer a[href], a.yt-simple-endpoint[href^="/@"], ' +
        'a.yt-simple-endpoint[href^="/channel/"], a.yt-simple-endpoint[href^="/c/"], a.yt-simple-endpoint[href^="/user/"]'
      );
      anchors.forEach((a) => {
        const href = a.getAttribute('href');
        if (!href || href.indexOf('/feed/') === 0 || href.indexOf('/playlist') === 0) return;
        const renderer = a.closest('ytd-grid-channel-renderer, ytd-channel-renderer, ytd-expanded-shelf-contents-renderer');
        const title = ((renderer && renderer.textContent) || a.textContent || '').trim().split('\n')[0].slice(0, 120);
        items.push({ url: href, title });
      });
    } catch (_e) { /* fall through to regex pass */ }
    // Pass 2: regex over raw HTML — works on the JS shell (ytInitialData).
    LIB.extractSubsFromHtml(html).forEach((it) => items.push(it));
    const map = LIB.buildSubsMap(items);
    if (!LIB.canonicalCount(map)) {
      throw new Error('No channels found. Make sure you are logged in and subscriptions are visible at /feed/channels.');
    }
    state.subsMap = map;
    state.subsUpdatedAt = Date.now();
    await saveSubs();
    return LIB.canonicalCount(map);
  }

  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- collaborators (secondary, on-demand only) ---------- */

  async function fetchVideoAuthors(videoId) {
    if (state.collabCache[videoId]) return state.collabCache[videoId].authors;
    const res = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId), {
      credentials: 'include', headers: { accept: 'text/html' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const found = new Map();
    const add = (href) => {
      const key = LIB.channelKey(href);
      if (key && !found.has(key)) found.set(key, { key, url: LIB.resolveUrl(href, location.origin) });
    };
    const ownerAreas = doc.querySelectorAll(
      'ytd-video-owner-renderer, #owner, #upload-info, #above-the-fold, #top-row, ' +
      '[class*="collab" i], [id*="collab" i], [class*="co-author" i], [class*="coauthor" i]'
    );
    ownerAreas.forEach((area) => {
      area.querySelectorAll('a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]').forEach((a) => add(a.getAttribute('href')));
    });
    const low = html.toLowerCase();
    if (low.includes('collaborat') || low.includes('cocreator') || low.includes('co-creator') || low.includes('coauthor') || low.includes('co-author')) {
      const re = /.{0,400}(collaborat\w*|cocreator|co-creator|coauthor|co-author).{0,800}/gi;
      let m;
      const linkRe = /\/(channel\/UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]+|c\/[^"'\/\s]+|user\/[^"'\/\s]+)/g;
      let guard = 0;
      while ((m = re.exec(html)) && guard++ < 20) {
        let lm;
        while ((lm = linkRe.exec(m[0]))) add('/' + lm[1]);
        linkRe.lastIndex = 0;
      }
    }
    const canon = doc.querySelector('meta[itemprop="channelId"]');
    if (canon) {
      const cid = canon.getAttribute('content');
      if (cid) add('/channel/' + cid);
    }
    const authors = found.size ? Array.from(found.values()) : null;
    state.collabCache[videoId] = { authors, at: Date.now() };
    return authors;
  }

  async function verifyCollabsOnVisible(ui) {
    if (state.verifying) return;
    state.verifying = true;
    state.verifyAbort = false;
    ui.setLoading(true);
    const rows = getVideoRows().map(parseRow).filter((p) => p.videoId && p.row.style.display !== 'none');
    let checked = 0, hidden = 0;
    ui.status('Verifying collaborators 0/' + rows.length + '… (Cancel available)');
    const queue = rows.slice();
    const step = async () => {
      while (queue.length && !state.verifyAbort) {
        const p = queue.shift();
        try {
          const authors = await fetchVideoAuthors(p.videoId);
          checked++;
          if (authors && authors.length > 1) {
            const allSubbed = authors.every((a) => state.subsMap[a.key]);
            p.row.setAttribute('data-' + P + 'collab', authors.length + '');
            if (!allSubbed) {
              p.row.style.display = 'none';
              p.row.setAttribute('data-' + P + 'hidden', 'collab');
              hidden++;
            }
          } else {
            p.row.setAttribute('data-' + P + 'collab', authors ? '1' : 'unknown-single');
          }
        } catch (_e) { /* keep visible on error — never hide on uncertainty */ }
        if (checked % 5 === 0 || !queue.length) {
          ui.status('Verifying collaborators ' + checked + '/' + rows.length + '… hid ' + hidden + ' (partial collab)');
          ui.counts();
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    await Promise.all([step(), step(), step()]);
    await saveCollabCache();
    state.verifying = false;
    ui.setLoading(false);
    ui.status(state.verifyAbort
      ? 'Collab check cancelled after ' + checked + '/' + rows.length + '.'
      : (rows.length ? 'Collab check done: ' + checked + ' checked, ' + hidden + ' hidden (not all co-authors subscribed).' : 'Nothing to verify.'));
    ui.counts();
  }

  /* ---------- filter / shuffle / load-all ---------- */

  function applySubsFilter(ui) {
    const infos = getVideoRows().map(parseRow);
    let shown = 0, hidden = 0, unknown = 0;
    const unmatched = new Set();
    if (!state.subsOnly) {
      infos.forEach((p) => { p.row.style.display = ''; p.row.removeAttribute('data-' + P + 'hidden'); p.row.removeAttribute('data-' + P + 'unknown'); });
      ui.counts(infos.length, infos.length, 0);
      if (infos.length) ui.status('Filter off — showing all ' + infos.length + ' loaded.');
      return { infos, unmatched };
    }
    if (!subsCount()) {
      infos.forEach((p) => { p.row.style.display = ''; });
      ui.status('Subs-only is ON but no subscription cache. Press “Scan subs” or Import a list first.');
      ui.counts(infos.length, infos.length, 0);
      return { infos, unmatched };
    }
    infos.forEach((p) => {
      const decision = LIB.decideRow(p.chKey, p.chName, state.subsMap);
      if (decision === 'show-subscribed') {
        // Preserve a manual collab-hide across lazy-load re-filters while the
        // collab check is enabled; otherwise re-show.
        if (state.deepCollab && p.row.getAttribute('data-' + P + 'hidden') === 'collab') {
          hidden++;
        } else {
          p.row.style.display = '';
          p.row.removeAttribute('data-' + P + 'hidden');
          p.row.removeAttribute('data-' + P + 'unknown');
          shown++;
        }
      } else if (decision === 'show-unknown') {
        p.row.style.display = '';
        p.row.removeAttribute('data-' + P + 'hidden');
        p.row.setAttribute('data-' + P + 'unknown', '1');
        shown++;
        unknown++;
      } else {
        p.row.style.display = 'none';
        p.row.setAttribute('data-' + P + 'hidden', 'unsub');
        p.row.removeAttribute('data-' + P + 'unknown');
        hidden++;
        if (p.chUrl) unmatched.add(p.chName ? p.chName + ' — ' + p.chUrl : p.chUrl);
      }
    });
    ui.counts(infos.length, shown, hidden);
    ui.status(
      'Subs-only: ' + shown + ' shown / ' + hidden + ' hidden of ' + infos.length + ' loaded' +
      (unknown ? ' (' + unknown + ' unknown kept visible)' : '') + '.' +
      (state.deepCollab ? ' Collab check enabled — press “Verify collabs”.' : '')
    );
    ui.unmatched(unmatched);
    return { infos, unmatched };
  }

  function shuffleRows(ui) {
    const rows = getVideoRows();
    if (rows.length < 2) { ui.status('Nothing to shuffle yet — videos are still loading.'); return; }
    const parent = rows[0].parentElement;
    if (!parent) return;
    const arr = rows.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const frag = document.createDocumentFragment();
    arr.forEach((r) => frag.appendChild(r));
    parent.appendChild(frag);
    ui.status('Shuffled ' + arr.length + ' loaded videos (random order). Press again to reshuffle. Tip: “Load all” first for full-playlist shuffle.');
  }

  async function loadAllVideos(ui) {
    if (ui.loading) return;
    state.loadAllAbort = false;
    ui.setLoading(true);
    let last = -1, stable = 0, iters = 0;
    ui.status('Loading full playlist… 0 (auto-scroll, Cancel available)');
    while (!state.loadAllAbort && iters++ < 150 && stable < 6) {
      window.scrollTo(0, document.body.scrollHeight);
      const list = $('ytd-playlist-video-list-renderer #contents') || $('ytd-playlist-video-list-renderer');
      if (list) list.scrollTop = list.scrollHeight;
      await new Promise((r) => setTimeout(r, 900));
      const n = getVideoRows().length;
      if (n > last) { last = n; stable = 0; ui.status('Loading full playlist… ' + n + ' (auto-scroll, Cancel available)'); }
      else stable++;
    }
    window.scrollTo(0, 0);
    ui.setLoading(false);
    const n = getVideoRows().length;
    ui.status(state.loadAllAbort ? 'Load-all cancelled at ' + n + ' videos.' : 'Loaded ' + n + ' videos. Now filter/shuffle applies to all of them.');
    if (state.subsOnly) applySubsFilter(ui);
    else ui.counts(n, n, 0);
  }

  /* ---------- toolbar (Shadow DOM) ---------- */

  /** Preferred insert point: left sidebar, right under Play all / Shuffle.
   *  Keeps the toolbar out of the video-list column so the list layout is untouched. */
  function findSidebarInsertPoint() {
    const sidebar = document.querySelector('ytd-playlist-sidebar-renderer');
    if (!sidebar) return null;
    const btns = Array.from(sidebar.querySelectorAll('button, a'));
    const playAll = btns.find((el) => (el.textContent || '').trim().toLowerCase() === 'play all');
    if (playAll) {
      let node = playAll;
      while (node && node !== sidebar) {
        const text = (node.textContent || '').toLowerCase();
        if (text.includes('play all') && text.includes('shuffle') && node.parentElement) {
          return { parent: node.parentElement, after: node };
        }
        node = node.parentElement;
      }
    }
    return { parent: sidebar, after: sidebar.lastElementChild };
  }

  function placeHost(host) {
    const spot = findSidebarInsertPoint();
    if (spot && spot.parent) {
      const ref = spot.after ? spot.after.nextSibling : null;
      if (host.parentElement !== spot.parent || host.nextSibling !== ref) {
        spot.parent.insertBefore(host, ref);
        log('toolbar placed in sidebar');
      }
      return;
    }
    // Fallbacks (old behavior): above the list, then body.
    const anchor =
      $('ytd-browse[page-subtype="playlist"] #primary') ||
      $('ytd-browse #primary') ||
      $('#primary') ||
      $('ytd-playlist-video-list-renderer') ||
      document.body;
    const parent = anchor.parentElement || document.body;
    if (host.parentElement !== parent) parent.insertBefore(host, anchor === document.body ? null : anchor);
  }

  function ensureToolbar() {
    const existing = $('#' + P + 'host');
    if (existing && existing.shadowRoot) {
      placeHost(existing); // migrate to sidebar on upgrade / re-position if layout changed
      return bindToolbarApi(existing.shadowRoot);
    }
    const host = document.createElement('div');
    host.id = P + 'host';
    host.setAttribute('data-' + P + 'scope', 'toolbar');
    placeHost(host);
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        .${P}bar{font:13px/1.45 system-ui,Roboto,Arial,sans-serif;color:#0f0f0f;background:#fff;box-sizing:border-box;max-width:100%;
          border:1px solid #e5e5e5;border-radius:12px;padding:10px 12px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
        .${P}row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
        .${P}title{font-weight:700;margin-right:4px}
        .${P}badge{font-size:11px;background:#f2f2f2;border-radius:20px;padding:2px 8px;color:#606060}
        .${P}btn{cursor:pointer;border:1px solid #d9d9d9;background:#f8f8f8;border-radius:18px;padding:5px 12px;font-size:13px;color:#0f0f0f}
        .${P}btn:hover{background:#eee}
        .${P}btn[disabled]{opacity:.5;cursor:default}
        .${P}btn-primary{background:#0f0f0f;color:#fff;border-color:#0f0f0f}
        .${P}btn-primary:hover{background:#333}
        label.${P}chk{display:inline-flex;gap:6px;align-items:center;border:1px solid #e0e0e0;border-radius:18px;padding:5px 10px;cursor:pointer;user-select:none}
        .${P}status{margin-top:8px;font-size:12.5px;color:#333;white-space:pre-wrap}
        .${P}counts{font-size:12px;color:#606060;margin-top:4px}
        details.${P}adv{margin-top:8px;font-size:12.5px}
        details.${P}adv summary{cursor:pointer;color:#065fd4}
        textarea.${P}unmatched{width:100%;min-height:64px;font-size:11.5px;margin-top:6px;box-sizing:border-box}
        .${P}hint{font-size:11.5px;color:#606060;margin-top:6px}
        input[type="file"].${P}file{display:none}
      </style>
      <div class="${P}bar">
        <div class="${P}row">
          <span class="${P}title">WL Adv Filter</span>
          <span class="${P}badge">private · no API key</span>
          <label class="${P}chk"><input type="checkbox" id="${P}subsOnly"> Subs-only</label>
          <label class="${P}chk"><input type="checkbox" id="${P}cleanOpen" checked> Open clean in new tab</label>
          <label class="${P}chk"><input type="checkbox" id="${P}deepCollab"> Collab check (slow)</label>
          <button class="${P}btn ${P}btn-primary" id="${P}shuffle">Shuffle</button>
          <button class="${P}btn" id="${P}loadAll">Load all</button>
          <button class="${P}btn" id="${P}cancel" disabled>Cancel</button>
        </div>
        <div class="${P}row" style="margin-top:8px">
          <button class="${P}btn" id="${P}scan">Scan subs</button>
          <button class="${P}btn" id="${P}import">Import list</button>
          <button class="${P}btn" id="${P}export">Export list</button>
          <button class="${P}btn" id="${P}verify">Verify collabs</button>
          <button class="${P}btn" id="${P}reset">Show all</button>
          <input type="file" class="${P}file" id="${P}file" accept=".json,.txt,text/plain,application/json">
        </div>
        <div class="${P}status" id="${P}status">Ready.</div>
        <div class="${P}counts" id="${P}counts"></div>
        <details class="${P}adv">
          <summary>Advanced: unmatched channels, matching, isolation</summary>
          <div class="${P}hint">Matching: channel-ID/handle match first, exact display-name match as fallback (covers /channel/UC… vs /@handle mismatches). Rows with no channel signal are kept visible (“unknown”) so page changes can’t wipe the list. “Collab check” is optional and slow: it fetches visible watch pages and hides videos where not all co-authors are subscribed. Nothing is ever deleted from Watch Later.</div>
          <div class="${P}hint" id="${P}subsMeta"></div>
          <textarea class="${P}unmatched" id="${P}unmatched" readonly placeholder="Hidden channels will be listed here for review…"></textarea>
          <div class="${P}hint">Isolation: toolbar lives in Shadow DOM, all attrs prefixed “${P}”. Clicks are intercepted only on WL rows with plain left-click; Ctrl/Cmd/shift/middle-click untouched. Other YouTube extensions are not modified.</div>
        </details>
      </div>`;

    const q = (id) => shadow.getElementById(P + id);
    const ui = {
      loading: false,
      status: (t) => { q('status').textContent = t; },
      counts: (total, shown, hidden) => {
        if (total === undefined) {
          const infos = getVideoRows().map(parseRow);
          const h = infos.filter((p) => p.row.style.display === 'none').length;
          total = infos.length; shown = total - h; hidden = h;
        }
        q('counts').textContent = 'Loaded: ' + total + ' · Shown: ' + shown + ' · Hidden: ' + hidden + ' · Subs cached: ' + subsCount();
        q('subsMeta').textContent = state.subsUpdatedAt
          ? 'Subs cache: ' + subsCount() + ' channels, updated ' + new Date(state.subsUpdatedAt).toLocaleString() + '.'
          : 'Subs cache: empty. Press “Scan subs” (reads /feed/channels once) or “Import list”.';
      },
      unmatched: (set) => {
        q('unmatched').value = set && set.size ? Array.from(set).sort().slice(0, 200).join('\n') : (q('unmatched').value || '');
      },
      setLoading: (v) => {
        ui.loading = v;
        q('cancel').disabled = !(v || state.verifying);
        q('loadAll').disabled = v;
      },
    };

    shadow.addEventListener('click', (e) => e.stopPropagation(), true);
    const on = (id, fn) => q(id).addEventListener('click', (e) => { e.stopPropagation(); fn(e); });

    q('subsOnly').checked = state.subsOnly;
    q('cleanOpen').checked = state.cleanOpen;
    q('deepCollab').checked = state.deepCollab;
    q('subsOnly').addEventListener('change', async (e) => {
      state.subsOnly = e.target.checked;
      await saveToggles();
      applySubsFilter(ui);
    });
    q('cleanOpen').addEventListener('change', async (e) => { state.cleanOpen = e.target.checked; await saveToggles(); ui.status(state.cleanOpen ? 'Clean-open ON: WL clicks open plain watch URLs in a new tab (kept in WL).' : 'Clean-open OFF: YouTube default click behavior.'); });
    q('deepCollab').addEventListener('change', async (e) => { state.deepCollab = e.target.checked; await saveToggles(); applySubsFilter(ui); });

    on('shuffle', () => shuffleRows(ui));
    on('loadAll', () => loadAllVideos(ui));
    on('cancel', () => { state.loadAllAbort = true; state.verifyAbort = true; ui.setLoading(false); q('cancel').disabled = true; });
    on('reset', async () => {
      state.subsOnly = false; q('subsOnly').checked = false; await saveToggles();
      applySubsFilter(ui);
    });
    on('scan', async () => {
      try {
        q('scan').disabled = true;
        const count = await scanSubscriptions(ui.status);
        ui.status('Subs cache saved: ' + count + ' channels. Now toggle “Subs-only” to filter.');
        ui.counts();
        if (state.subsOnly) applySubsFilter(ui);
      } catch (err) { ui.status('Scan failed: ' + (err && err.message ? err.message : err)); }
      finally { q('scan').disabled = false; }
    });
    on('import', () => q('file').click());
    q('file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const items = LIB.parseImportText(await f.text());
        const map = LIB.buildSubsMap(items);
        if (!LIB.canonicalCount(map)) throw new Error('no channels parsed (expect one URL/handle/UC-id per line, or JSON array)');
        state.subsMap = map;
        state.subsUpdatedAt = Date.now();
        await saveSubs();
        ui.status('Imported ' + LIB.canonicalCount(map) + ' channels from ' + f.name + '.');
        ui.counts();
        if (state.subsOnly) applySubsFilter(ui);
      } catch (err) { ui.status('Import failed: ' + (err && err.message ? err.message : err)); }
      e.target.value = '';
    });
    on('export', () => {
      const entries = Object.entries(state.subsMap).filter(([k]) => k.indexOf('name:') !== 0);
      if (!entries.length) { ui.status('Nothing to export — subs cache is empty.'); return; }
      downloadFile(P + 'subscriptions.json', JSON.stringify(entries.map(([k, v]) => ({ key: k, url: v.url, title: v.title })), null, 2), 'application/json');
      const urls = Array.from(new Set(entries.map(([, v]) => v.url)));
      downloadFile(P + 'subscriptions.txt', urls.join('\n') + '\n');
      ui.status('Exported ' + entries.length + ' channels (JSON + TXT, duplicates removed).');
    });
    on('verify', () => verifyCollabsOnVisible(ui));

    if (state.rowObserver) state.rowObserver.disconnect();
    const list = $('ytd-playlist-video-list-renderer #contents');
    if (list) {
      state.rowObserver = new MutationObserver(debounce(() => {
        if (!isWlPage() || !state.subsOnly) { ui.counts(); return; }
        applySubsFilter(ui);
      }, 600));
      state.rowObserver.observe(list, { childList: true });
    }

    ui.counts();
    if (!subsCount()) ui.status('Ready. Step 1: “Scan subs” (one-time read of /feed/channels) or “Import list”. Step 2: toggle “Subs-only”.');
    else if (state.subsOnly) applySubsFilter(ui);
    log('toolbar injected, rows found:', getVideoRows().length);
    return ui;
  }

  function bindToolbarApi(shadow) {
    const q = (id) => shadow.getElementById(P + id);
    return {
      loading: false,
      status: (t) => { const el = q('status'); if (el) el.textContent = t; },
      counts: (total, shown, hidden) => {
        const el = q('counts');
        if (!el) return;
        if (total === undefined) {
          const infos = getVideoRows().map(parseRow);
          const h = infos.filter((p) => p.row.style.display === 'none').length;
          total = infos.length; shown = total - h; hidden = h;
        }
        el.textContent = 'Loaded: ' + total + ' · Shown: ' + shown + ' · Hidden: ' + hidden + ' · Subs cached: ' + subsCount();
      },
      unmatched: () => {},
      setLoading: () => {},
    };
  }

  /* ---------- click intercept: clean URL in NEW TAB (same window), keep in WL ---------- */

  function onDocClickCapture(e) {
    if (!state.cleanOpen || !isWlPage()) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#' + P + 'host')) return;
    const a = t.closest('a[href*="watch"]');
    if (!a) return;
    const row = a.closest('ytd-playlist-video-renderer, yt-lockup-view-model');
    if (!row) return; // only WL rows — leaves every other extension/page area alone
    const href = a.getAttribute('href');
    const vid = LIB.videoIdFromHref(href);
    if (!vid) return;
    e.preventDefault();
    e.stopPropagation();
    const url = LIB.cleanWatchUrl(vid, href);
    // Single send, callback form (works on all Chrome versions — no double-send).
    try {
      chrome.runtime.sendMessage({ type: MSG_OPEN, url }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      });
    } catch (_err) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  /* ---------- boot / SPA navigation ---------- */

  let booted = false;

  async function boot() {
    if (booted) return;
    booted = true;
    log('boot on', location.href);
    document.addEventListener('click', onDocClickCapture, true);
    await loadPersisted();
    if (isWlPage()) { state.active = true; ensureToolbar(); }
    else log('not a WL page, idle');
    window.addEventListener('yt-navigate-finish', debounce(() => {
      if (isWlPage()) ensureToolbar();
      else { const h = $('#' + P + 'host'); if (h) h.remove(); if (state.rowObserver) state.rowObserver.disconnect(); }
    }, 400));
    // Self-heal: re-inject if on WL but the host is missing (slow render, DOM wipe).
    setInterval(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        if (isWlPage()) ensureToolbar();
        else { const h = $('#' + P + 'host'); if (h) h.remove(); }
      } else if (isWlPage() && !$('#' + P + 'host')) {
        log('host missing, re-injecting');
        ensureToolbar();
      }
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
