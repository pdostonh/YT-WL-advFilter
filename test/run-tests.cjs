/* Tests for WL Adv Filter pure lib + manifest wiring. Run: node test/run-tests.cjs */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'src', 'wlavf-lib.js'));

let n = 0;
function ok(actual, expected, msg) {
  n++;
  assert.strictEqual(actual, expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- videoIdFromHref ---
ok(lib.videoIdFromHref('/watch?v=dQw4w9WgXcQ&list=WL&index=7'), 'dQw4w9WgXcQ', 'watch href with list+index');
ok(lib.videoIdFromHref('https://www.youtube.com/watch?v=abcDEF123-_&t=42s'), 'abcDEF123-_', 'watch href with t');
ok(lib.videoIdFromHref('/watch?v=short'), null, 'too-short id rejected');
ok(lib.videoIdFromHref('/playlist?list=WL'), null, 'playlist href has no video');
ok(lib.videoIdFromHref(null), null, 'null href');
ok(lib.videoIdFromHref('https://youtu.be/dQw4w9WgXcQ'), null, 'youtu.be not used on WL');

// --- channelKey ---
ok(lib.channelKey('/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw'), 'id:UC_x5XG1OV2P6uZZ5FSM9Ttw', 'channel id path');
ok(lib.channelKey('https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw?x=1'), 'id:UC_x5XG1OV2P6uZZ5FSM9Ttw', 'channel id url prefers id');
ok(lib.channelKey('/@SomeChannel'), 'handle:@somechannel', 'handle lowercased');
ok(lib.channelKey('https://www.youtube.com/@SomeChannel/videos'), 'handle:@somechannel', 'handle url with suffix');
ok(lib.channelKey('UC_x5XG1OV2P6uZZ5FSM9Ttw'), 'id:UC_x5XG1OV2P6uZZ5FSM9Ttw', 'bare channel id');
ok(lib.channelKey('@SomeChannel'), 'handle:@somechannel', 'bare handle');
ok(lib.channelKey('/c/CustomName'), 'c:customname', 'custom url');
ok(lib.channelKey('/user/OldName'), 'user:oldname', 'user url');
ok(lib.channelKey(''), null, 'empty');
ok(lib.channelKey(null), null, 'null');
ok(lib.channelKey('   '), null, 'blank');
ok(lib.channelKey('/feed/subscriptions'), 'path:/feed/subscriptions', 'unknown path kept distinct');
ok(lib.channelKey('not a url at all'), null, 'garbage has no key');

// --- name aliases (the alias-mismatch fix) ---
assert.deepStrictEqual(lib.nameAliases('Linus Tech Tips'), ['name:linus tech tips'], 'single name alias');
assert.deepStrictEqual(lib.nameAliases('VEVO - Topic'), ['name:vevo - topic', 'name:vevo'], 'topic alias');
assert.deepStrictEqual(lib.nameAliases('x'), [], 'too short');
assert.deepStrictEqual(lib.nameAliases(''), [], 'empty name');

// --- buildSubsMap / isSubscribed / decideRow ---
const UC1 = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const map = lib.buildSubsMap([
  { url: 'https://www.youtube.com/@LinusTechTips', title: 'Linus Tech Tips' },
  { url: '/channel/' + UC1, title: 'Google for Developers' },
]);
ok(lib.isSubscribed('handle:@linustechtips', 'Linus Tech Tips', map), true, 'handle+name match');
ok(lib.isSubscribed('id:' + UC1, 'Google for Developers', map), true, 'id match');
// Alias mismatch case: WL shows /channel/UC…, subs cached /@handle with same display name.
const map2 = lib.buildSubsMap([{ url: '/@AliasChannel', title: 'Alias Channel' }]);
ok(lib.isSubscribed('id:UCAAAAAAAAAAAAAAAAAAAAAA', 'Alias Channel', map2), true, 'name fallback bridges id/handle mismatch');
ok(lib.isSubscribed('id:UCAAAAAAAAAAAAAAAAAAAAAA', 'Other Name', map2), false, 'different channel not matched');
ok(lib.isSubscribed(null, null, map2), false, 'null signals not matched');
ok(lib.decideRow(null, '', map2), 'show-unknown', 'unknown rows fail OPEN (kept)');
ok(lib.decideRow(null, 'Some Channel', map2), 'hide-unsub', 'named but unsub hides');
ok(lib.decideRow('id:UCAAAAAAAAAAAAAAAAAAAAAA', 'Alias Channel', map2), 'show-subscribed', 'subscribed shows');
ok(lib.canonicalCount(map2), 1, 'alias keys not double-counted');

// --- cleanWatchUrl ---
ok(
  lib.cleanWatchUrl('dQw4w9WgXcQ', '/watch?v=dQw4w9WgXcQ&list=WL&index=7&pp=iAQB'),
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'list/index/pp stripped'
);
ok(
  lib.cleanWatchUrl('dQw4w9WgXcQ', '/watch?v=dQw4w9WgXcQ&t=42s&list=WL'),
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
  'timestamp kept'
);

// --- isWlUrl ---
ok(lib.isWlUrl('https://www.youtube.com/playlist?list=WL'), true, 'bare WL');
ok(lib.isWlUrl('https://www.youtube.com/playlist?list=WL&index=3'), true, 'WL with params');
ok(lib.isWlUrl('https://www.youtube.com/playlist?list=PL123'), false, 'other playlist');
ok(lib.isWlUrl('https://www.youtube.com/watch?v=x&list=WL'), false, 'watch-with-list is not WL page');
ok(lib.isWlUrl('https://music.youtube.com/playlist?list=WL'), false, 'music host excluded');
ok(lib.isWlUrl('not a url'), false, 'garbage');

// --- parseImportText ---
let items = lib.parseImportText('https://www.youtube.com/@A\n/channel/UCBBBBBBBBBBBBBBBBBBBBBB\n\n# comment\n');
ok(items.length, 2, 'txt lines parsed, blanks/comments skipped');
items = lib.parseImportText(JSON.stringify(['https://www.youtube.com/@A', { url: '/@B', title: 'Bee' }]));
ok(items.length, 2, 'json array of string+object');
ok(items[1].title, 'Bee', 'json object title kept');
items = lib.parseImportText(JSON.stringify({ channels: ['/@A'] }));
ok(items.length, 1, 'object with channels key');
items = lib.parseImportText(JSON.stringify([{ key: 'id:UCCCCCCCCCCCCCCCCCCCCCC', url: '/channel/UCCCCCCCCCCCCCCCCCCCCCC', title: 'C' }]));
ok(items.length, 1, 'own export format re-imports');
items = lib.parseImportText('{{{not json');
ok(items.length, 1, 'broken json falls back to lines');
items = lib.parseImportText('');
ok(items.length, 0, 'empty import');

// --- extractSubsFromHtml (server shell fallback) ---
const UC_A = 'UC' + 'A'.repeat(22);
const UC_B = 'UC' + 'B'.repeat(22);
const html =
  '<html><body>' +
  '<a href="/@AlphaChannel">Alpha</a>' +
  '<a href="/channel/' + UC_A + '">A</a>' +
  '<a href="/feed/subscriptions">x</a>' +
  '<script>var ytInitialData={"gridChannelRenderer":{"channelId":"' + UC_B + '"}};</script>' +
  '</body></html>';
const ex = lib.extractSubsFromHtml(html);
const exMap = lib.buildSubsMap(ex);
ok(!!exMap['handle:@alphachannel'], true, 'anchor handle extracted');
ok(!!exMap['id:' + UC_A], true, 'anchor channel id extracted');
ok(!!exMap['id:' + UC_B], true, 'ytInitialData channel id extracted');
ok(ex.filter((e) => e.url.includes('/feed/')).length, 0, 'feed links skipped');

// --- manifest wiring ---
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
ok(manifest.manifest_version, 3, 'mv3');
assert.ok((manifest.permissions || []).includes('storage'), 'storage permission');
assert.ok(!(manifest.permissions || []).includes('windows'), 'no windows permission (tabs need none)');
const cs = (manifest.content_scripts || [])[0];
assert.ok(cs, 'content script declared');
assert.deepStrictEqual(cs.js, ['src/wlavf-lib.js', 'src/content.js'], 'lib loads before content');
ok(cs.all_frames, false, 'no all-frames');
assert.ok(!JSON.stringify(cs.matches).includes('watch'), 'content script NOT on watch pages');
const bgPath = path.join(ROOT, manifest.background.service_worker);
assert.ok(fs.existsSync(bgPath), 'background file exists');
cs.js.forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, f)), `content file exists: ${f}`));
const contentSrc = fs.readFileSync(path.join(ROOT, 'src', 'content.js'), 'utf8');
assert.ok(contentSrc.includes('__WLAVF_LIB'), 'content uses shared lib');
assert.ok(contentSrc.includes('ytd-playlist-sidebar-renderer'), 'toolbar knows sidebar layout');
assert.ok(contentSrc.includes('findPlayAllRow'), 'toolbar anchors to visible Play-all row');
assert.ok(!contentSrc.includes("addEventListener('click', (e) => e.stopPropagation(), true)"), 'no capture click blocker killing buttons');
assert.ok(contentSrc.includes('toolbar build failed'), 'toolbar build errors are logged, not silent');
assert.ok(!contentSrc.includes('function channelKey('), 'no duplicated channelKey in content');
const bgSrc = fs.readFileSync(bgPath, 'utf8');
assert.ok(bgSrc.includes('WLAVF_OPEN_CLEAN'), 'background handles clean-open message');
assert.ok(bgSrc.includes('chrome.tabs') && bgSrc.includes('.create'), 'background opens new tab');
assert.ok(!bgSrc.includes('chrome.windows'), 'background does not open windows');

console.log(`wlavf tests passed: ${n} assertions + structural checks`);
