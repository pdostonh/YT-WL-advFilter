/* wlavf-lib.js — pure helpers for WL Adv Filter. No browser globals (URL only).
 * Loaded before src/content.js (same isolated world) and required by tests.
 * Exposes globalThis.__WLAVF_LIB and module.exports (for Node).
 */
'use strict';

(function () {
  const YT_ORIGIN = 'https://www.youtube.com';
  const WL_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
  const UC_RE = /UC[A-Za-z0-9_-]{22}/;
  const HANDLE_RE = /@([A-Za-z0-9._-]+)/;
  const VID_RE = /^[A-Za-z0-9_-]{6,}$/;

  function isWlUrl(url) {
    try {
      const u = new URL(url);
      return WL_HOSTS.has(u.hostname) && u.pathname === '/playlist' && u.searchParams.get('list') === 'WL';
    } catch (_e) {
      return false;
    }
  }

  function videoIdFromHref(href) {
    if (!href || typeof href !== 'string') return null;
    try {
      const u = new URL(href, YT_ORIGIN);
      if (u.pathname === '/watch' || u.searchParams.has('v')) {
        const v = u.searchParams.get('v');
        if (v && VID_RE.test(v)) return v;
      }
    } catch (_e) {
      /* ignore */
    }
    return null;
  }

  /** Canonical match key for any channel reference. Null when unparseable. */
  function channelKey(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m = s.match(UC_RE);
    if (m) return 'id:' + m[0];
    m = s.match(HANDLE_RE);
    if (m) return 'handle:@' + m[1].toLowerCase().replace(/[.]+$/, '');
    m = s.match(/youtube\.com\/(c|user)\/([^/?#\s]+)/i);
    if (m) return m[1].toLowerCase() + ':' + m[2].toLowerCase();
    m = s.match(/^\/(c|user)\/([^/?#\s]+)/i);
    if (m) return m[1].toLowerCase() + ':' + m[2].toLowerCase();
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        const p = u.pathname.replace(/\/+$/, '').toLowerCase();
        if (!p) return null;
        return 'path:' + p;
      } catch (_e) {
        return null;
      }
    }
    if (s[0] === '/') {
      const p = s.split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();
      if (!p || p === '/') return null;
      return 'path:' + p;
    }
    return null;
  }

  function normName(name) {
    return String(name || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /** Display-name alias keys, incl. " - topic" stripped variant. */
  function nameAliases(name) {
    const n = normName(name);
    if (n.length < 2) return [];
    const out = ['name:' + n];
    const stripped = n.replace(/\s+-\s+topic$/, '');
    if (stripped && stripped !== n && stripped.length >= 2) out.push('name:' + stripped);
    return out;
  }

  function nameKey(name) {
    const a = nameAliases(name);
    return a.length ? a[0] : null;
  }

  function resolveUrl(href, origin) {
    if (!href) return null;
    try {
      return new URL(href, origin || YT_ORIGIN).href;
    } catch (_e) {
      return null;
    }
  }

  function cleanWatchUrl(videoId, sourceHref) {
    let t = null;
    try {
      t = new URL(sourceHref, YT_ORIGIN).searchParams.get('t');
    } catch (_e) {
      /* ignore */
    }
    let url = YT_ORIGIN + '/watch?v=' + encodeURIComponent(videoId);
    if (t) url += '&t=' + encodeURIComponent(t);
    return url;
  }

  function addChannelToMap(map, url, title) {
    const key = channelKey(url);
    const rec = { url: String(url), title: String(title || '').slice(0, 120) };
    if (key) {
      if (!map[key] || !map[key].title) map[key] = rec;
    }
    nameAliases(title).forEach((nk) => {
      if (!map[nk]) map[nk] = rec;
    });
    return key;
  }

  /** items: array of strings or {url,title}. Returns key->record map (deduped). */
  function buildSubsMap(items) {
    const map = {};
    (items || []).forEach((it) => {
      if (typeof it === 'string') addChannelToMap(map, it, '');
      else if (it && it.url) addChannelToMap(map, it.url, it.title || '');
    });
    return map;
  }

  function canonicalCount(subsMap) {
    return Object.keys(subsMap || {}).filter((k) => k.indexOf('name:') !== 0).length;
  }

  function isSubscribed(chKey, chName, subsMap) {
    if (!subsMap) return false;
    if (chKey && subsMap[chKey]) return true;
    const aliases = nameAliases(chName);
    for (let i = 0; i < aliases.length; i++) {
      if (subsMap[aliases[i]]) return true;
    }
    return false;
  }

  /**
   * Fail-open decision: unknown rows (no channel signal at all) are KEPT visible
   * so a YouTube markup change can never wipe the playlist.
   */
  function decideRow(chKey, chName, subsMap) {
    if (isSubscribed(chKey, chName, subsMap)) return 'show-subscribed';
    if (!chKey && nameAliases(chName).length === 0) return 'show-unknown';
    return 'hide-unsub';
  }

  /** Parse an imported list. Returns deduped [{url,title}]. Throws nothing. */
  function parseImportText(text) {
    const items = [];
    const t = String(text || '').trim();
    if (!t) return items;
    let arr = null;
    if (t[0] === '[' || t[0] === '{') {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) arr = j;
        else if (j && typeof j === 'object') {
          if (Array.isArray(j.channels)) arr = j.channels;
          else if (Array.isArray(j.subscriptions)) arr = j.subscriptions;
          else arr = [];
        }
      } catch (_e) {
        arr = null;
      }
    }
    const lines = arr !== null ? arr : t.split(/\r?\n/);
    lines.forEach((line) => {
      let url = '';
      let title = '';
      if (typeof line === 'string') url = line.trim();
      else if (line && typeof line === 'object') {
        url = String(line.url || line.key || '').trim();
        title = String(line.title || line.name || '').trim();
      }
      if (!url || url[0] === '#') return;
      items.push({ url, title });
    });
    return items;
  }

  /**
   * Regex-only extraction of subscribed channels from /feed/channels HTML.
   * Works on the server-rendered shell (ytInitialData) where component
   * selectors find nothing. Returns [{url,title:''}].
   */
  function extractSubsFromHtml(html) {
    const items = [];
    const s = String(html || '');
    if (!s) return items;
    const aRe = /href="(\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[^"/?#\s]+|user\/[^"/?#\s]+))[^"]*"/g;
    let m;
    while ((m = aRe.exec(s))) {
      const href = m[1];
      if (
        href.indexOf('/feed/') === 0 ||
        href.indexOf('/playlist') === 0 ||
        href.indexOf('/watch') === 0 ||
        href.indexOf('/results') === 0 ||
        href.indexOf('/hashtag') === 0
      ) {
        continue;
      }
      items.push({ url: href, title: '' });
    }
    const idRe = /"(?:channelId|browseId)"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/g;
    while ((m = idRe.exec(s))) {
      items.push({ url: '/channel/' + m[1], title: '' });
    }
    return items;
  }

  /* ---- v2 data mode: InnerTube helpers (pure, no DOM) ----
   * The WL page virtualizes its list (~100 row nodes for 4000+ videos, nodes
   * recycled in place), so DOM scraping can never cover a big playlist.
   * Instead we read the page's own embedded InnerTube key/context and fetch
   * the full playlist data (videoId + channel per item, all continuations).
   * No user API key involved — same key the YouTube page itself uses. */

  /** Balanced-brace scan from str[startIdx] (must be '{'). Returns substring or null. */
  function scanBalancedJson(str, startIdx) {
    const s = String(str || '');
    if (s[startIdx] !== '{') return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = startIdx; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(startIdx, i + 1);
      }
    }
    return null;
  }

  /** Extract {apiKey, context, clientVersion} from page HTML. Missing parts are null. */
  function parseInnertubeConfig(html) {
    const s = String(html || '');
    let apiKey = null;
    let context = null;
    let clientVersion = null;
    const km = s.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (km) apiKey = km[1];
    const cm = s.match(/"INNERTUBE_CONTEXT"\s*:\s*\{/);
    if (cm) {
      const braceIdx = cm[0].lastIndexOf('{') + cm.index;
      const raw = scanBalancedJson(s, braceIdx);
      if (raw) {
        try {
          context = JSON.parse(raw);
        } catch (_e) {
          context = null;
        }
      }
    }
    if (context && context.client && typeof context.client.clientVersion === 'string') {
      clientVersion = context.client.clientVersion;
    } else {
      const vm = s.match(/"clientVersion"\s*:\s*"([^"]+)"/);
      if (vm) clientVersion = vm[1];
    }
    return { apiKey, context, clientVersion };
  }

  function runsText(t) {
    if (!t || typeof t !== 'object') return '';
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
    return '';
  }

  /** One playlistVideoRenderer -> flat item. Unknowns stay empty (fail-open later). */
  function parsePlaylistVideo(pvr) {
    const p = (pvr && typeof pvr === 'object') ? pvr : {};
    const videoId = typeof p.videoId === 'string' ? p.videoId : null;
    const title = runsText(p.title) || runsText(p.headline) || '';
    const run =
      (p.shortBylineText && Array.isArray(p.shortBylineText.runs) && p.shortBylineText.runs[0]) ||
      (p.longBylineText && Array.isArray(p.longBylineText.runs) && p.longBylineText.runs[0]) ||
      null;
    let channelName = '';
    let channelId = null;
    let channelHandle = null;
    if (run) {
      channelName = run.text || '';
      const be = run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
      if (be && typeof be === 'object') {
        if (typeof be.browseId === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(be.browseId)) channelId = be.browseId;
        const canon = typeof be.canonicalBaseUrl === 'string' ? be.canonicalBaseUrl : '';
        const hm = canon.match(/@([A-Za-z0-9._-]+)/);
        if (hm) channelHandle = '@' + hm[1].toLowerCase();
      }
    }
    return { videoId, title, channelName, channelId, channelHandle };
  }

  /**
   * Recursively collect {items, continuation} from any browse/continuation
   * response shape. Defensive: probes structure by key names, not paths.
   */
  function collectPlaylistData(root) {
    const items = [];
    const seenIds = new Set();
    const contTokens = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.playlistVideoRenderer && typeof node.playlistVideoRenderer === 'object') {
        const it = parsePlaylistVideo(node.playlistVideoRenderer);
        if (it.videoId && !seenIds.has(it.videoId)) {
          seenIds.add(it.videoId);
          items.push(it);
        }
      }
      const cir = node.continuationItemRenderer;
      if (cir && cir.continuationEndpoint && cir.continuationEndpoint.continuationCommand) {
        const t = cir.continuationEndpoint.continuationCommand.token;
        if (typeof t === 'string' && t) contTokens.push(t);
      }
      if (node.nextContinuationData && typeof node.nextContinuationData.continuation === 'string') {
        contTokens.push(node.nextContinuationData.continuation);
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === 'playlistVideoRenderer') continue;
        walk(node[keys[i]]);
      }
    })(root);
    return { items, continuation: contTokens.length ? contTokens[contTokens.length - 1] : null };
  }

  const lib = {
    YT_ORIGIN,
    isWlUrl,
    videoIdFromHref,
    channelKey,
    nameAliases,
    nameKey,
    resolveUrl,
    cleanWatchUrl,
    addChannelToMap,
    buildSubsMap,
    canonicalCount,
    isSubscribed,
    decideRow,
    parseImportText,
    extractSubsFromHtml,
    scanBalancedJson,
    parseInnertubeConfig,
    collectPlaylistData,
    parsePlaylistVideo,
  };

  if (typeof globalThis !== 'undefined') globalThis.__WLAVF_LIB = lib;
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
})();
