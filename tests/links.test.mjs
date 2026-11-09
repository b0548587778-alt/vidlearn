import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, parseInstances, instanceKind, buildYtInfoUrl, parseYtInfo, parseVimeoConfig, titleFromUrl } from '../www/js/links.js';
import { fetchLinkItem, fetchYoutube, resolveDirectFile } from '../www/js/search.js';
import { defaultState } from '../www/js/store.js';

const ID = 'abcdefghijk';

test('זיהוי קישורים', () => {
  for (const u of [`https://www.youtube.com/watch?v=${ID}&t=5`, `youtu.be/${ID}`, `https://m.youtube.com/shorts/${ID}`, `https://music.youtube.com/watch?v=${ID}`, `https://yewtu.be/watch?v=${ID}`, `http://youtube.com/embed/${ID}`]) {
    assert.deepEqual(parseLink(u), { type: 'youtube', id: ID }, u);
  }
  assert.deepEqual(parseLink('https://vimeo.com/123456789'), { type: 'vimeo', id: '123456789' });
  assert.deepEqual(parseLink('https://tube.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv'), { type: 'peertube', host: 'tube.example.org', id: 'kkGMgK9ZtnKfYAgnEtQxbv' });
  assert.deepEqual(parseLink('https://archive.org/details/algebra_101'), { type: 'archive', id: 'algebra_101' });
  assert.equal(parseLink('https://commons.wikimedia.org/wiki/File:Lesson_1.webm').type, 'commons');
  assert.equal(parseLink('https://example.org/files/shiur_3.mp3').type, 'direct');
  assert.equal(parseLink('javascript:alert(1)'), null);
  assert.equal(parseLink('https://www.youtube.com/'), null);
  assert.equal(parseLink('נסיון'), null);
});

test('שרתי יוטיוב', () => {
  assert.deepEqual(parseInstances('inv.example.org\nhttps://pipedapi.example.com/x, http://bad.example'), ['https://inv.example.org', 'https://pipedapi.example.com']);
  assert.equal(instanceKind('https://pipedapi.kavin.rocks'), 'piped');
  assert.equal(instanceKind('https://yewtu.be'), 'invidious');
  assert.equal(buildYtInfoUrl('https://yewtu.be', ID), `https://yewtu.be/api/v1/videos/${ID}?local=true`);
  assert.throws(() => buildYtInfoUrl('https://yewtu.be', 'bad/../id'));
});

const inv = {
  title: 'Algebra lesson 1', description: 'Intro', author: 'Math Channel', lengthSeconds: 600, keywords: ['math'], genre: 'Education', isFamilyFriendly: true,
  formatStreams: [
    { url: `/latest_version?id=${ID}&itag=18&local=true`, itag: '18', type: 'video/mp4; codecs="avc1"', resolution: '360p', container: 'mp4' },
    { url: `/latest_version?id=${ID}&itag=22&local=true`, itag: '22', type: 'video/mp4; codecs="avc1"', resolution: '720p', container: 'mp4' },
  ],
  adaptiveFormats: [
    { url: `/latest_version?id=${ID}&itag=140&local=true`, type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: '130000', clen: '9000000' },
    { url: `/latest_version?id=${ID}&itag=251&local=true`, type: 'audio/webm; codecs="opus"', bitrate: '160000', clen: '8000000' },
  ],
};

test('Invidious: איכות רגילה / חסכונית / שמע בלבד', () => {
  const base = 'https://inv.example.org';
  const n = parseYtInfo(base, inv, 'normal');
  assert.equal(n.meta.title, 'Algebra lesson 1');
  assert.equal(n.url, `${base}/latest_version?id=${ID}&itag=22&local=true`);
  assert.equal(parseYtInfo(base, inv, 'low').url, `${base}/latest_version?id=${ID}&itag=18&local=true`);
  const a = parseYtInfo(base, inv, 'audio');
  assert.equal(a.ext, 'm4a');
  assert.match(a.url, /itag=140/);
  assert.equal(a.size, 9000000);
});

test('Piped: רק קובץ עם תמונה וקול', () => {
  const json = {
    title: 'Physics lecture', uploader: 'Uni', duration: 100, category: 'Education',
    videoStreams: [
      { url: 'https://proxy.example/v1', mimeType: 'video/mp4', videoOnly: true, height: 720 },
      { url: 'https://proxy.example/v2', mimeType: 'video/mp4', videoOnly: false, height: 360, contentLength: 5000 },
    ],
    audioStreams: [{ url: 'https://proxy.example/a', mimeType: 'audio/mp4', bitrate: 128000 }],
  };
  assert.equal(parseYtInfo('https://pipedapi.example.com', json, 'normal').url, 'https://proxy.example/v2');
  assert.equal(parseYtInfo('https://pipedapi.example.com', json, 'audio').url, 'https://proxy.example/a');
});

test('Vimeo ושם קובץ ישיר', () => {
  const cfg = { request: { files: { progressive: [{ url: 'https://v.example/1080.mp4', height: 1080 }, { url: 'https://v.example/540.mp4', height: 540 }] } } };
  assert.equal(parseVimeoConfig(cfg).url, 'https://v.example/540.mp4');
  assert.equal(parseVimeoConfig({}).url, '');
  assert.equal(titleFromUrl('https://example.org/a/shiur_03.mp3'), 'shiur 03');
});

const ok = (data) => ({ ok: true, json: async () => data });

test('הורדה מיוטיוב: שרת שלא עונה מדולג, סרטון לא הולם נחסם', async () => {
  const settings = { ...defaultState().settings, ytInstances: ['https://dead.example', 'https://inv.example.org'] };
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.startsWith('https://dead.example')) throw new Error('offline');
    return ok(inv);
  };
  const r = await fetchYoutube(ID, settings, { fetchImpl });
  assert.match(r.url, /^https:\/\/inv\.example\.org\//);
  assert.equal(asked.length, 2);

  const bad = async () => ok({ ...inv, title: 'Funny prank compilation' });
  await assert.rejects(fetchYoutube(ID, settings, { fetchImpl: bad }), /blocked/);
  const notFamily = async () => ok({ ...inv, isFamilyFriendly: false });
  await assert.rejects(fetchYoutube(ID, settings, { fetchImpl: notFamily }), /blocked/);
  // שגיאת סינון נעצרת מיד — לא מנסים שרת אחר
  const r2 = await resolveDirectFile({ sourceType: 'youtube', nativeId: ID }, { fetchImpl, settings, quality: 'audio' });
  assert.equal(r2.ext, 'm4a');
});

test('הורדה מיוטיוב: אף שרת לא ענה', async () => {
  const settings = { ...defaultState().settings, ytInstances: ['https://a.example'] };
  await assert.rejects(fetchYoutube(ID, settings, { fetchImpl: async () => { throw new Error('x'); } }), /yt-unavailable/);
});

test('קישור: פריט מוכן אחרי סינון', async () => {
  const settings = { ...defaultState().settings, ytInstances: ['https://inv.example.org'] };
  const v = await fetchLinkItem(`https://youtu.be/${ID}`, settings, { fetchImpl: async () => ok(inv) });
  assert.equal(v.id, `youtube:${ID}`);
  assert.equal(v.title, 'Algebra lesson 1');
  assert.equal(v.sourceType, 'youtube');

  await assert.rejects(fetchLinkItem('https://www.xvideos.com/v/a.mp4', settings), /blocked/);
  await assert.rejects(fetchLinkItem('https://cdn.example.org/sexy_clip.mp4', settings), /blocked/);
  await assert.rejects(fetchLinkItem('not a link', settings), /bad-link/);
  const d = await fetchLinkItem('https://cdn.example.org/shiur_bava_metzia_01.mp3', settings);
  assert.equal(d.sourceType, 'direct');
  assert.equal(d.play.kind, 'video');

  // PeerTube: לא בקטגוריית חינוך ← צריך מילת לימוד; nsfw ← נחסם
  const pt = (extra) => async () => ok({ uuid: 'u-1234567890', name: 'Sunset timelapse', embedPath: '/videos/embed/u-1234567890', category: { id: 1 }, ...extra });
  await assert.rejects(fetchLinkItem('https://tube.example.org/w/u-1234567890', settings, { fetchImpl: pt({}) }), /blocked/);
  await assert.rejects(fetchLinkItem('https://tube.example.org/w/u-1234567890', settings, { fetchImpl: pt({ name: 'Chemistry lesson', nsfw: true }) }), /blocked/);
  const okPt = await fetchLinkItem('https://tube.example.org/w/u-1234567890', settings, { fetchImpl: pt({ name: 'Chemistry lesson' }) });
  assert.equal(okPt.host, 'tube.example.org');
});
