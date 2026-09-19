/* WL Adv Filter (private) — background service worker (MV3).
 * Single job: open a clean watch URL in a brand-new separate Chrome window.
 * No playlist mutation, no API keys, no tracking.
 */
'use strict';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'WLAVF_OPEN_CLEAN' || typeof msg.url !== 'string') return false;
  const url = msg.url;
  // Basic allowlist: only https youtube watch URLs we built ourselves.
  let ok = false;
  try {
    const u = new URL(url);
    ok =
      (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'm.youtube.com') &&
      u.pathname === '/watch' &&
      /^[A-Za-z0-9_-]{6,}$/.test(u.searchParams.get('v') || '');
  } catch (_e) {
    ok = false;
  }
  if (!ok) {
    sendResponse({ ok: false, error: 'bad-url' });
    return true;
  }
  // User asked for a NEW SEPARATE WINDOW (not just a tab).
  chrome.windows
    .create({ url, focused: true, type: 'normal' })
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});
