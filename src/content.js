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
    // v2 data mode: full playlist items keyed by videoId (DOM is virtualized).
    dataItems: [],
    dataById: {},
    dataMode: false,
    dataLoading: false,
    dataAbort: false,
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

  /* ---------- legacy loaded-rows filter (fallback when data mode unavailable) ---------- */

  function applySubsFilterLegacy(ui) {
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

  /* ---------- v2 data mode: full playlist via the page's own InnerTube ----------
   * The WL DOM is virtualized (~100 recycled row nodes for 4000+ videos), so
   * DOM scraping can never cover a big playlist. Instead we fetch the playlist
   * data (videoId + channel per item) through youtubei/v1/browse using the
   * page's embedded key/context — no user API key — then hide rows by stable
   * videoId, which survives node recycling. */

  let itConfig = null;

  function getInnertubeConfig() {
    if (itConfig) return itConfig;
    try {
      itConfig = LIB.parseInnertubeConfig(document.documentElement.innerHTML);
    } catch (_e) {
      itConfig = { apiKey: null, context: null, clientVersion: null };
    }
    return itConfig;
  }

  function browseContext() {
    const cfg = getInnertubeConfig();
    if (cfg.context) return cfg.context;
    return { client: { clientName: 'WEB', clientVersion: cfg.clientVersion || '2.20260101.00.00', hl: 'en', gl: 'US' } };
  }

  async function innertubeBrowse(body) {
    const cfg = getInnertubeConfig();
    const res = await fetch('https://www.youtube.com/youtubei/v1/browse?key=' + encodeURIComponent(cfg.apiKey) + '&prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('YouTube data request failed (HTTP ' + res.status + ')');
    return res.json();
  }

  function itemKey(item) {
    if (item.channelId) return 'id:' + item.channelId;
    if (item.channelHandle) return 'handle:' + item.channelHandle;
    return null;
  }

  /** Hidden videoIds from data + subs. Unknowns stay visible (fail-open). */
  function rebuildHiddenSet() {
    const hidden = new Set();
    const unmatched = new Set();
    state.dataItems.forEach((it) => {
      if (!it.videoId) return;
      if (LIB.isSubscribed(itemKey(it), it.channelName, state.subsMap)) return;
      if (!itemKey(it) && LIB.nameAliases(it.channelName).length === 0) return;
      hidden.add(it.videoId);
      if (unmatched.size < 500) unmatched.add(it.channelName || itemKey(it) || it.videoId);
    });
    return { hidden, unmatched };
  }

  let hiddenIds = new Set();

  async function fetchFullPlaylist(ui) {
    if (state.dataLoading) return false;
    const cfg = getInnertubeConfig();
    if (!cfg.apiKey) {
      ui.status('Could not read the page data key (logged out or consent page?). Using loaded-rows mode.');
      log('no innertube key, legacy mode');
      applySubsFilterLegacy(ui);
      return false;
    }
    state.dataLoading = true;
    state.dataAbort = false;
    ui.setLoading(true);
    try {
      const items = [];
      const seen = new Set();
      const usedTokens = new Set();
      let token = null;
      let first = true;
      let pages = 0;
      let stalePages = 0;
      while (!state.dataAbort) {
        const body = first
          ? { context: browseContext(), browseId: 'VLWL' }
          : { context: browseContext(), continuation: token };
        first = false;
        const json = await innertubeBrowse(body);
        const r = LIB.collectPlaylistData(json);
        let fresh = 0;
        r.items.forEach((it) => {
          if (it.videoId && !seen.has(it.videoId)) { seen.add(it.videoId); items.push(it); fresh++; }
        });
        pages++;
        stalePages = fresh === 0 ? stalePages + 1 : 0;
        token = r.continuation;
        if (pages <= 2) log('page', pages, 'keys:', Object.keys(json || {}).join(','), 'fresh:', fresh, 'token:', token ? 'yes' : 'no');
        ui.status('Fetching playlist data... ' + items.length + ' videos (' + pages + ' pages, Cancel available)');
        if (!token) { log('no continuation, done'); break; }
        if (usedTokens.has(token)) { log('repeated token, stopping'); break; }
        usedTokens.add(token);
        if (stalePages >= 2) { log('no new items twice, stopping'); break; }
        if (pages > 200 || items.length > 20000) { log('fetch cap hit'); break; }
        await new Promise((res) => setTimeout(res, 150));
      }
      if (state.dataAbort) {
        ui.status('Fetch cancelled at ' + items.length + ' videos.');
        return false;
      }
      state.dataItems = items;
      state.dataById = {};
      items.forEach((it) => { state.dataById[it.videoId] = it; });
      state.dataMode = items.length > 0;
      log('fetched', items.length, 'items in', pages, 'pages');
      const r2 = rebuildHiddenSet();
      hiddenIds = r2.hidden;
      ui.unmatched(r2.unmatched);
      applyVideoFilter(ui);
      return state.dataMode;
    } catch (err) {
      ui.status('Fetch failed: ' + (err && err.message ? err.message : err) + ' - using loaded-rows mode.');
      log('fetch failed:', err && err.message);
      applySubsFilterLegacy(ui);
      return false;
    } finally {
      state.dataLoading = false;
      ui.setLoading(false);
    }
  }

  function rowVideoId(row) {
    const a = row.querySelector('a[href*="watch?v="]');
    return a ? LIB.videoIdFromHref(a.getAttribute('href')) : null;
  }

  /** Hide/show rendered rows by stable videoId. Cheap: O(visible rows). */
  function applyVideoFilter(ui) {
    const rows = getVideoRows();
    let shown = 0, hidden = 0;
    if (!state.subsOnly) {
      rows.forEach((row) => { row.style.display = ''; row.removeAttribute('data-' + P + 'hidden'); });
      const total = state.dataItems.length || rows.length;
      ui.counts(total, total, 0);
      return;
    }
    if (!subsCount()) {
      rows.forEach((row) => { row.style.display = ''; });
      ui.status('Subs-only is ON but no subscription cache. Press "Scan subs" or Import a list first.');
      ui.counts(state.dataItems.length || rows.length, rows.length, 0);
      return;
    }
    rows.forEach((row) => {
      const vid = rowVideoId(row);
      if (vid && hiddenIds.has(vid)) {
        row.style.display = 'none';
        row.setAttribute('data-' + P + 'hidden', 'unsub');
        hidden++;
      } else if (state.deepCollab && row.getAttribute('data-' + P + 'hidden') === 'collab') {
        hidden++; // preserve manual collab hides
      } else {
        row.style.display = '';
        if (row.getAttribute('data-' + P + 'hidden') !== 'collab') row.removeAttribute('data-' + P + 'hidden');
        shown++;
      }
    });
    const total = state.dataItems.length || rows.length;
    ui.counts(total, total - hiddenIds.size, hiddenIds.size);
    ui.status('Subs-only (full playlist): ' + (total - hiddenIds.size) + ' shown / ' + hiddenIds.size + ' hidden of ' + total + '. Rendered rows: ' + rows.length + '.');
  }

  function reapplyFilter(ui) {
    if (!state.subsOnly) return;
    if (state.dataMode) applyVideoFilter(ui);
    else applySubsFilterLegacy(ui);
  }

  async function ensureDataForFilter(ui) {
    if (!state.subsOnly) {
      getVideoRows().forEach((row) => { row.style.display = ''; row.removeAttribute('data-' + P + 'hidden'); });
      const total = state.dataMode && state.dataItems.length ? state.dataItems.length : getVideoRows().length;
      ui.counts(total, total, 0);
      ui.status('Filter off - showing all.');
      return;
    }
    if (!subsCount()) {
      getVideoRows().forEach((row) => { row.style.display = ''; });
      ui.status('Subs-only is ON but no subscription cache. Press "Scan subs" or Import a list first.');
      return;
    }
    if (state.dataMode) {
      const r = rebuildHiddenSet();
      hiddenIds = r.hidden;
      ui.unmatched(r.unmatched);
      applyVideoFilter(ui);
      return;
    }
    await fetchFullPlaylist(ui);
  }

  function openCleanUrl(url) {
    const fallback = () => window.open(url, '_blank', 'noopener,noreferrer');
    try {
      chrome.runtime.sendMessage({ type: MSG_OPEN, url }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) fallback();
      });
    } catch (_err) {
      fallback();
    }
  }

  /** Random pick from the current pool - honest replacement for visual shuffle
   *  on virtualized multi-thousand-video lists (DOM order cannot survive recycling). */
  async function pickRandom(ui) {
    if (!state.dataMode) {
      ui.status('Fetching playlist data first...');
      const ok = await fetchFullPlaylist(ui);
      if (!ok) return;
    }
    let pool = state.dataItems.filter((it) => it.videoId);
    if (state.subsOnly) pool = pool.filter((it) => !hiddenIds.has(it.videoId));
    if (!pool.length) { ui.status('Nothing to pick from.'); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    ui.status('Random pick (' + pool.length + ' to choose from): ' + (pick.title || pick.videoId) + ' - opening in a new tab.');
    openCleanUrl(LIB.cleanWatchUrl(pick.videoId, ''));
  }

  /* ---------- toolbar (Shadow DOM) ---------- */

  /** Preferred insert point: left sidebar, right under Play all / Shuffle.
   *  Keeps the toolbar out of the video-list column so the list layout is untouched. */
  function isVisible(el) {
    try {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_e) { return false; }
  }

  /** Preferred insert point: right under the VISIBLE Play all / Shuffle row,
   *  wherever YouTube renders it (sidebar or header card). Visibility is checked
   *  because the page can contain hidden/stale duplicate renderers. */
  function findPlayAllRow() {
    const els = Array.from(document.querySelectorAll('button, a'));
    for (const el of els) {
      if (!isVisible(el)) continue;
      if ((el.textContent || '').trim().toLowerCase() !== 'play all') continue;
      let node = el;
      for (let depth = 0; depth < 10 && node && node !== document.body; depth++) {
        const text = (node.textContent || '').toLowerCase();
        if (text.includes('play all') && text.includes('shuffle') && node.parentElement && isVisible(node.parentElement)) {
          return { parent: node.parentElement, after: node, how: 'play-all row' };
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function findSidebarInsertPoint() {
    // Visible header/sidebar card (new and old layouts). Hidden duplicates ignored.
    const sels = ['ytd-playlist-header-renderer', 'ytd-playlist-sidebar-renderer'];
    for (const sel of sels) {
      const nodes = Array.from(document.querySelectorAll(sel));
      const vis = nodes.find(isVisible);
      if (vis) return { parent: vis, after: vis.lastElementChild, how: sel };
    }
    if (sels.some((sel) => document.querySelector(sel))) log('header/sidebar renderers hidden, using fallback');
    else log('no header/sidebar renderer found, using fallback');
    return null;
  }

  /** Returns true when the host was actually moved. */
  function moveHost(host, parent, ref) {
    if (!parent || !parent.isConnected) return false;
    if (host.parentElement === parent && host.nextSibling === (ref || null)) return false;
    parent.insertBefore(host, ref || null);
    return true;
  }

  function placeHost(host) {
    try {
      const row = findPlayAllRow();
      if (row && moveHost(host, row.parent, row.after ? row.after.nextSibling : null)) {
        log('toolbar placed under Play all / Shuffle');
        return;
      } else if (row) return; // already in place
    } catch (err) {
      log('play-all placement failed:', err && err.message);
    }
    try {
      const spot = findSidebarInsertPoint();
      if (spot && moveHost(host, spot.parent, spot.after ? spot.after.nextSibling : null)) {
        log('toolbar placed in header card (' + spot.how + ')');
        return;
      } else if (spot) return; // already in place
    } catch (err) {
      log('header placement failed, using fallback:', err && err.message);
    }
    try {
      // Fallbacks (old behavior): above the list, then body.
      const anchor =
        $('ytd-browse[page-subtype="playlist"] #primary') ||
        $('ytd-browse #primary') ||
        $('#primary') ||
        $('ytd-playlist-video-list-renderer') ||
        document.body;
      const parent = anchor.parentElement || document.body;
      if (moveHost(host, parent, anchor === document.body ? null : anchor)) log('toolbar placed at fallback');
    } catch (err2) {
      log('fallback placement failed:', err2 && err2.message);
      try { document.body.appendChild(host); } catch (_e) { /* ignore */ }
    }
  }

  function ensureToolbar() {
    try {
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
          <button class="${P}btn ${P}btn-primary" id="${P}random">Random</button>
          <button class="${P}btn" id="${P}fetch">Fetch list</button>
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
        q('fetch').disabled = v;
      },
    };

    // NOTE: no capture-phase click blocker here — one would stop our own
    // buttons' handlers (capture runs before the target). YouTube is shielded
    // instead by per-button stopPropagation below, and onDocClickCapture
    // already ignores anything inside #wlavf-host.
    const on = (id, fn) => q(id).addEventListener('click', (e) => { e.stopPropagation(); fn(e); });

    q('subsOnly').checked = state.subsOnly;
    q('cleanOpen').checked = state.cleanOpen;
    q('deepCollab').checked = state.deepCollab;
    q('subsOnly').addEventListener('change', async (e) => {
      state.subsOnly = e.target.checked;
      await saveToggles();
      ensureDataForFilter(ui);
    });
    q('cleanOpen').addEventListener('change', async (e) => { state.cleanOpen = e.target.checked; await saveToggles(); ui.status(state.cleanOpen ? 'Clean-open ON: WL clicks open plain watch URLs in a new tab (kept in WL).' : 'Clean-open OFF: YouTube default click behavior.'); });
    q('deepCollab').addEventListener('change', async (e) => { state.deepCollab = e.target.checked; await saveToggles(); reapplyFilter(ui); });

    on('random', () => pickRandom(ui));
    on('fetch', () => fetchFullPlaylist(ui));
    on('cancel', () => { state.dataAbort = true; state.verifyAbort = true; ui.setLoading(false); q('cancel').disabled = true; });
    on('reset', async () => {
      state.subsOnly = false; q('subsOnly').checked = false; await saveToggles();
      ensureDataForFilter(ui);
    });
    on('scan', async () => {
      try {
        q('scan').disabled = true;
        const count = await scanSubscriptions(ui.status);
        ui.status('Subs cache saved: ' + count + ' channels. Now toggle “Subs-only” to filter.');
        ui.counts();
        if (state.subsOnly) ensureDataForFilter(ui);
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
        if (state.subsOnly) ensureDataForFilter(ui);
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
      // Node recycling changes hrefs in place — watch attributes too.
      state.rowObserver = new MutationObserver(debounce(() => {
        if (!isWlPage()) return;
        if (!state.subsOnly) { ui.counts(); return; }
        reapplyFilter(ui);
      }, 400));
      state.rowObserver.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }

    ui.counts();
    if (!subsCount()) ui.status('Ready. Step 1: “Scan subs” (one-time read of /feed/channels) or “Import list”. Step 2: toggle “Subs-only”.');
    else if (state.subsOnly) ensureDataForFilter(ui);
    log('toolbar injected, rows found:', getVideoRows().length);
    return ui;
    } catch (err) {
      log('toolbar build failed:', err && err.stack || err);
      return bindToolbarApi(document);
    }
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
    openCleanUrl(LIB.cleanWatchUrl(vid, href));
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
    // Self-heal: re-place if on WL but the host is missing OR hidden
    // (e.g. stuck inside a stale invisible renderer).
    setInterval(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        if (isWlPage()) ensureToolbar();
        else { const h = $('#' + P + 'host'); if (h) h.remove(); }
      } else if (isWlPage()) {
        const h = $('#' + P + 'host');
        if (!h || !isVisible(h)) {
          log('host missing or hidden, re-placing');
          ensureToolbar();
        }
      }
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
