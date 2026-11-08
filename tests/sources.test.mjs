import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseResults, parseResolve, resolveFile, buildResolveUrl, DEFAULT_SOURCES, sourceReady } from '../www/js/sources.js';

const src = (id) => DEFAULT_SOURCES.find((s) => s.id === id);

test('PeerTube: חיפוש רק בקטגוריית חינוך, בלי nsfw', () => {
  const url = new URL(buildSearchUrl(src('sepia'), 'algebra', { cursor: 2, langs: ['he'] }));
  assert.equal(url.host, 'sepiasearch.org');
  assert.equal(url.searchParams.get('categoryOneOf'), '13');
  assert.equal(url.searchParams.get('nsfw'), 'false');
  assert.equal(url.searchParams.get('start'), '24');
  assert.equal(url.searchParams.get('languageOneOf'), 'he');
});

test('PeerTube: פירוק תוצאה, ופסילת nsfw / קטגוריה אחרת / כתובת לא https', () => {
  const base = { uuid: 'u1', name: 'Algebra 1', duration: 2975, category: { id: 13 }, url: 'https://tubedu.org/videos/watch/u1', embedUrl: 'https://tubedu.org/videos/embed/x', thumbnailUrl: 'https://tubedu.org/t.jpg', channel: { displayName: 'Prof' } };
  const { items, next } = parseResults(src('sepia'), {
    total: 40,
    data: [base, { ...base, uuid: 'u2', nsfw: true }, { ...base, uuid: 'u3', category: { id: 10 } }, { ...base, uuid: 'u4', url: 'javascript:alert(1)', embedUrl: 'javascript:x' }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'peertube:tubedu.org:u1');
  assert.equal(items[0].play.url, 'https://tubedu.org/videos/embed/x');
  assert.equal(items[0].author, 'Prof');
  assert.equal(next, 1);
});

test('Archive: השאילתה מחייבת נושא/אוסף לימודי ומנקה תחביר', () => {
  const url = new URL(buildSearchUrl(src('archive'), 'algebra) OR (x', {}));
  const q = url.searchParams.get('q');
  assert.match(q, /mediatype:movies/);
  assert.match(q, /subject:\(education/);
  assert.ok(!q.startsWith('(algebra) OR'), q);
});

test('Archive: פירוק ומשך', () => {
  const { items, next } = parseResults(src('archive'), { response: { numFound: 5, docs: [{ identifier: 'abc', title: 'Lesson', runtime: '00:23:01', creator: ['School'] }] } });
  assert.equal(items[0].duration, 23 * 60 + 1);
  assert.equal(items[0].author, 'School');
  assert.equal(items[0].thumb, 'https://archive.org/services/img/abc');
  assert.equal(next, null);
});

test('Archive: קובץ mp4 ישיר מהמטא-דאטה', () => {
  const v = { sourceType: 'archive', nativeId: 'abc' };
  assert.equal(buildResolveUrl(v), 'https://archive.org/metadata/abc');
  const files = [{ name: 'a.ogv' }, { name: 'big.mp4', source: 'original', size: '900' }, { name: 'dir/a 512kb.mp4', format: '512Kb MPEG4', size: '100', source: 'derivative' }, { name: 'a.h264.mp4', format: 'h.264', size: '400', source: 'derivative' }];
  assert.equal(parseResolve(v, { files }), 'https://archive.org/download/abc/a.h264.mp4');
  assert.equal(parseResolve(v, { files }, 'low'), 'https://archive.org/download/abc/dir/a%20512kb.mp4');
  assert.equal(parseResolve(v, { files: [files[1]] }), 'https://archive.org/download/abc/big.mp4');
});

test('Commons: רק VIDEO, נגן ישיר', () => {
  const { items, next } = parseResults(src('commons'), {
    continue: { gsroffset: 12 },
    query: { pages: {
      1: { pageid: 1, index: 1, title: 'File:Linear_algebra.webm', imageinfo: [{ mediatype: 'VIDEO', url: 'https://upload.wikimedia.org/a.webm', duration: 469.8, thumburl: 'https://thumb/a.jpg', extmetadata: { ImageDescription: { value: '<b>MOOC</b> part' } } }] },
      2: { pageid: 2, index: 2, title: 'File:x.png', imageinfo: [{ mediatype: 'BITMAP', url: 'https://u/x.png' }] },
    } },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].play.kind, 'video');
  assert.equal(items[0].title, 'Linear algebra');
  assert.equal(items[0].description, 'MOOC part');
  assert.equal(items[0].duration, 470);
  assert.equal(next, 1);
});

test('YouTube: דורש מפתח, קטגוריית חינוך ו-safeSearch מחמיר', () => {
  assert.equal(sourceReady({ ...src('youtube'), enabled: true }), false);
  const s = { ...src('youtube'), enabled: true, key: 'K' };
  assert.equal(sourceReady(s), true);
  const url = new URL(buildSearchUrl(s, 'calculus', { cursor: 'TOKEN' }));
  assert.equal(url.searchParams.get('videoCategoryId'), '27');
  assert.equal(url.searchParams.get('safeSearch'), 'strict');
  assert.equal(url.searchParams.get('pageToken'), 'TOKEN');
  const { items, next } = parseResults(s, { nextPageToken: 'N2', items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: 'Calc &amp; more', channelTitle: 'MIT' } }, { id: { videoId: '<bad>' } }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Calc & more');
  assert.match(items[0].play.url, /^https:\/\/www\.youtube-nocookie\.com\/embed\/abcdefghijk/);
  assert.equal(next, 'N2');
});

test('PeerTube: בחירת קובץ עד 720p, גם מתוך HLS', () => {
  const v = { sourceType: 'peertube', host: 'tube.x', nativeId: 'u' };
  assert.equal(buildResolveUrl(v), 'https://tube.x/api/v1/videos/u');
  const files = [{ resolution: { id: 1080 }, fileUrl: 'https://tube.x/1080.mp4' }, { resolution: { id: 720 }, fileUrl: 'https://tube.x/720.mp4' }, { resolution: { id: 0 }, fileUrl: 'https://tube.x/audio.mp4' }];
  assert.equal(parseResolve(v, { files }), 'https://tube.x/720.mp4');
  assert.equal(parseResolve(v, { files: [...files, { resolution: { id: 480 }, fileUrl: 'https://tube.x/480.mp4' }] }, 'low'), 'https://tube.x/480.mp4');
  assert.equal(parseResolve(v, { files: [], streamingPlaylists: [{ files: [{ resolution: { id: 1080 }, fileUrl: 'https://tube.x/h.mp4' }] }] }), 'https://tube.x/h.mp4');
  assert.equal(parseResolve(v, { files: [{ resolution: { id: 480 }, fileUrl: 'http://tube.x/insecure.mp4' }] }), '');
});

test('שרת מותאם — רק https', () => {
  assert.throws(() => buildSearchUrl({ type: 'peertube', url: 'http://tube.x' }, 'a'), /https-only/);
  assert.match(buildSearchUrl({ type: 'peertube', url: 'tube.x/' }, 'a'), /^https:\/\/tube\.x\/api\/v1\/search\/videos\?/);
});

test('סקירה: Commons — גרסה מוקטנת לפי האיכות, עם גודל משוער', () => {
  const v = { sourceType: 'commons', nativeId: '54082866', duration: 470, play: { kind: 'video', url: 'https://upload.wikimedia.org/orig.webm' } };
  assert.match(buildResolveUrl(v), /pageids=54082866/);
  const json = { query: { pages: { 1: { videoinfo: [{ url: 'https://upload.wikimedia.org/orig.webm', size: 36669270, duration: 469.8, derivatives: [
    { src: 'https://upload.wikimedia.org/t/a.240p.vp9.webm', type: 'video/webm', height: 240, bandwidth: 104144 },
    { src: 'https://upload.wikimedia.org/t/a.360p.mpeg4.mov', type: 'video/quicktime', height: 360, bandwidth: 302024 },
    { src: 'https://upload.wikimedia.org/t/a.480p.vp9.webm', type: 'video/webm', height: 480, bandwidth: 140360 },
    { src: 'https://upload.wikimedia.org/t/a.720p.vp9.webm', type: 'video/webm', height: 720, bandwidth: 250000 },
    { src: 'https://upload.wikimedia.org/t/a.1080p.vp9.webm', type: 'video/webm', height: 1080, bandwidth: 317032 },
  ] }] } } } };
  assert.equal(resolveFile(v, json, 'low').url, 'https://upload.wikimedia.org/t/a.480p.vp9.webm');
  assert.equal(resolveFile(v, json, 'low').size, Math.round(140360 * 469.8 / 8));
  assert.equal(resolveFile(v, json).url, 'https://upload.wikimedia.org/t/a.720p.vp9.webm');
  // בלי גרסאות מוקטנות — המקור, עם הגודל האמיתי
  const plain = { query: { pages: { 1: { videoinfo: [{ url: 'https://upload.wikimedia.org/orig.webm', size: 999 }] } } } };
  assert.deepEqual(resolveFile(v, plain), { url: 'https://upload.wikimedia.org/orig.webm', size: 999 });
});

test('סקירה: גודל הקובץ מ-Archive ומ-PeerTube', () => {
  assert.equal(resolveFile({ sourceType: 'archive', nativeId: 'x' }, { files: [{ name: 'a.mp4', size: '1234', source: 'derivative' }] }).size, 1234);
  assert.equal(resolveFile({ sourceType: 'peertube', host: 'h', nativeId: 'u' }, { files: [{ resolution: { id: 480 }, fileUrl: 'https://h/a.mp4', size: 777 }] }).size, 777);
});
