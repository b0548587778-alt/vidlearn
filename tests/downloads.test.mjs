import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloads, fileNameFor, formatBytes, MB } from '../www/js/downloads.js';
import { createStore, normalizeState } from '../www/js/store.js';
import { canDownload } from '../www/js/sources.js';

function mem() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }
const arch = (id) => ({ id: `archive:${id}`, nativeId: id, title: id, sourceType: 'archive', sourceName: 'A', play: { kind: 'iframe', url: 'https://archive.org/embed/' + id } });

function fakeFs({ size = 10 * MB, fail = null } = {}) {
  const files = new Map();
  return {
    files,
    async download(url, path, onProgress) {
      if (fail && url.includes(fail)) throw new Error('net');
      onProgress(0.5);
      files.set(path, size);
      return { uri: 'file:///data/' + path };
    },
    async stat(path) { return files.get(path) ?? 0; },
    async remove(path) { files.delete(path); },
    toSrc: (uri) => 'https://localhost/_capacitor_file_' + uri.slice(7),
  };
}
function fakeNet(type = 'wifi') {
  let fn = null;
  const n = { type, status: async () => ({ connected: n.type !== 'none', type: n.type }), onChange: (f) => { fn = f; }, fire: () => fn && fn() };
  return n;
}
const resolveUrl = async (v, q) => `https://archive.org/download/${v.nativeId}/${q}.mp4`;
const idle = () => new Promise((r) => setTimeout(r, 0));
async function settle(dl) { for (let i = 0; i < 20; i++) await idle(); }

test('מה אפשר להוריד: לא יוטיוב', () => {
  assert.equal(canDownload(arch('a')), true);
  assert.equal(canDownload({ id: 'youtube:x', sourceType: 'youtube', play: { kind: 'iframe', url: 'https://www.youtube-nocookie.com/embed/x' } }), false);
  assert.equal(canDownload({ sourceType: 'commons', nativeId: '5', play: { kind: 'video', url: 'https://upload.wikimedia.org/a.webm' } }), true);
  assert.match(fileNameFor({ id: 'commons:5', sourceType: 'commons' }, 'https://upload.wikimedia.org/x/a.webm?utm=1'), /^videos\/commons-[0-9a-f]{16}\.webm$/);
});

test('הורדה: נשמר, גודל, נגן מקומי, ומחיקה', async () => {
  const store = createStore(mem());
  const fs = fakeFs();
  const dl = createDownloads({ store, fs, network: fakeNet(), resolveUrl });
  assert.equal(dl.enqueue(arch('a')), 'queued');
  assert.equal(dl.enqueue(arch('a')), 'exists');
  await settle(dl);
  const d = store.getDownload('archive:a');
  assert.equal(d.status, 'done');
  assert.equal(d.size, 10 * MB);
  assert.match(d.path, /^videos\/archive-[0-9a-f]{16}\.mp4$/);
  assert.equal(dl.localSrc('archive:a'), 'https://localhost/_capacitor_file_/data/' + d.path);
  assert.equal(dl.isSaved('archive:a'), true);
  assert.equal(dl.usedBytes(), 10 * MB);
  await dl.remove('archive:a');
  assert.equal(fs.files.size, 0);
  assert.equal(store.getDownload('archive:a'), null);
});

test('איכות חסכונית עוברת לכתובת', async () => {
  const store = createStore(mem());
  store.setSetting('dlQuality', 'low');
  const dl = createDownloads({ store, fs: fakeFs(), network: fakeNet(), resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').quality, 'low');
});

test('רק Wi-Fi: בסלולר ממתין, וממשיך כשה-Wi-Fi חוזר', async () => {
  const store = createStore(mem());
  const net = fakeNet('cellular');
  const dl = createDownloads({ store, fs: fakeFs(), network: net, resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'waiting');
  net.type = 'wifi';
  net.fire();
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'done');
});

test('גם בסלולר כשהמשתמש התיר', async () => {
  const store = createStore(mem());
  store.setSetting('dlWifiOnly', false);
  const dl = createDownloads({ store, fs: fakeFs(), network: fakeNet('cellular'), resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'done');
});

test('תקרת נפח: קובץ שחורג נמחק ומסומן', async () => {
  const store = createStore(mem());
  store.setSetting('dlLimitMB', 100);
  const fs = fakeFs({ size: 60 * MB });
  const dl = createDownloads({ store, fs, network: fakeNet(), resolveUrl });
  dl.enqueue(arch('a'));
  dl.enqueue(arch('b'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'done');
  assert.equal(store.getDownload('archive:b').status, 'error');
  assert.equal(store.getDownload('archive:b').error, 'limit');
  assert.equal(fs.files.size, 1);
});

test('כשל ברשת ← שגיאה, ניסיון חוזר מצליח', async () => {
  const store = createStore(mem());
  const fs = fakeFs({ fail: '/a/' });
  const dl = createDownloads({ store, fs, network: fakeNet(), resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'error');
  const ok = fakeFs();
  fs.download = ok.download; fs.stat = ok.stat;
  assert.equal(dl.retry('archive:a'), true);
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'done');
});

test('קורס: השיעור הבא שלא נלמד נשמר מראש; שמירת קורס שלם', async () => {
  const store = createStore(mem());
  const c = store.createCourse('קורס');
  ['a', 'b', 'c'].forEach((x) => store.addLesson(c.id, arch(x)));
  store.setDone('archive:b', true);
  const dl = createDownloads({ store, fs: fakeFs(), network: fakeNet(), resolveUrl });
  const next = dl.prefetchNext(store.state.courses[0], 'archive:a');
  assert.equal(next.id, 'archive:c', 'מדלג על שיעור שכבר נלמד');
  assert.equal(store.getDownload('archive:c').auto, true);
  assert.equal(dl.saveCourse(store.state.courses[0]), 2);
  await settle(dl);
  assert.equal(dl.list().filter((d) => d.status === 'done').length, 3);
  store.setSetting('dlAutoNext', false);
  assert.equal(dl.prefetchNext(store.state.courses[0], 'archive:a'), null);
});

test('נלמד ← נמחק רק אם הוגדר', async () => {
  const store = createStore(mem());
  const dl = createDownloads({ store, fs: fakeFs(), network: fakeNet(), resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(await dl.onLearned('archive:a'), false);
  store.setSetting('dlDeleteLearned', true);
  assert.equal(await dl.onLearned('archive:a'), true);
  assert.equal(store.getDownload('archive:a'), null);
});

test('בלי מערכת קבצים (דפדפן) — לא זמין', () => {
  const dl = createDownloads({ store: createStore(mem()), fs: null, network: null, resolveUrl });
  assert.equal(dl.available, false);
  assert.equal(dl.enqueue(arch('a')), 'unavailable');
});

test('הורדה שנקטעה חוזרת לתור; גיבוי לא כולל קבצים', () => {
  const v = arch('a');
  const n = normalizeState({ settings: {}, downloads: { 'archive:a': { video: v, status: 'downloading' }, bad: { status: 'done' } } });
  assert.deepEqual(Object.keys(n.downloads), ['archive:a']);
  assert.equal(n.downloads['archive:a'].status, 'queued');
  const s = createStore(mem());
  s.setDownload('archive:a', { video: v, status: 'done', path: 'videos/x.mp4' });
  assert.deepEqual(JSON.parse(s.exportJson()).downloads, {});
  s.importJson(JSON.stringify({ settings: {} }));
  assert.equal(s.getDownload('archive:a').status, 'done', 'ייבוא לא מוחק את מה שבטלפון');
});

test('סקירה: שני סרטונים עם מזהה ארוך דומה — קבצים שונים', () => {
  const host = 'x'.repeat(150);
  const a = fileNameFor({ id: `peertube:${host}:uuid-1`, sourceType: 'peertube' }, 'https://h/a.mp4');
  const b = fileNameFor({ id: `peertube:${host}:uuid-2`, sourceType: 'peertube' }, 'https://h/a.mp4');
  assert.notEqual(a, b);
  assert.notEqual(fileNameFor({ id: 'a:b' }, ''), fileNameFor({ id: 'a_b' }, ''));
});

test('סקירה: החיבור נפל באמצע ההורדה ← ממתין, וממשיך כשהרשת חוזרת', async () => {
  const store = createStore(mem());
  const net = fakeNet('wifi');
  const fs = fakeFs();
  const ok = fs.download;
  fs.download = async () => { net.type = 'none'; throw new Error('connection reset'); };
  const dl = createDownloads({ store, fs, network: net, resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'waiting');
  fs.download = ok;
  net.type = 'wifi';
  net.fire();
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'done');
});

test('סקירה: Wi-Fi חזר בזמן בדיקת הרשת — התור לא נתקע', async () => {
  const store = createStore(mem());
  let release;
  const net = fakeNet('cellular');
  const realStatus = net.status;
  let first = true;
  net.status = async () => {
    if (first) { first = false; const r = await realStatus(); await new Promise((res) => { release = res; }); return r; }
    return realStatus();
  };
  const dl = createDownloads({ store, fs: fakeFs(), network: net, resolveUrl });
  dl.enqueue(arch('a'));
  await idle();
  net.type = 'wifi';
  net.fire();           // pump רץ — הבקשה נרשמת להרצה חוזרת
  release();            // התשובה הישנה (סלולר) מגיעה רק עכשיו
  await settle(dl);
  assert.equal(store.getDownload('archive:a').status, 'done');
});

test('סקירה: גודל ידוע מראש שחורג מהתקרה — לא מורידים בכלל', async () => {
  const store = createStore(mem());
  store.setSetting('dlLimitMB', 100);
  const fs = fakeFs();
  let downloaded = 0;
  const orig = fs.download;
  fs.download = async (...a) => { downloaded++; return orig(...a); };
  const dl = createDownloads({ store, fs, network: fakeNet(), resolveUrl: async (v) => ({ url: `https://archive.org/download/${v.nativeId}/x.mp4`, size: 500 * MB }) });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(store.getDownload('archive:a').error, 'limit');
  assert.equal(downloaded, 0);
});

test('סקירה: שיעור הבא שנכשל לא נשלח שוב אוטומטית', async () => {
  const store = createStore(mem());
  const c = store.createCourse('ק');
  ['a', 'b'].forEach((x) => store.addLesson(c.id, arch(x)));
  const dl = createDownloads({ store, fs: fakeFs(), network: fakeNet(), resolveUrl: async () => '' });
  assert.equal(dl.prefetchNext(store.state.courses[0], 'archive:a').id, 'archive:b');
  await settle(dl);
  assert.equal(store.getDownload('archive:b').status, 'error');
  assert.equal(dl.prefetchNext(store.state.courses[0], 'archive:a'), null);
  assert.equal(store.getDownload('archive:b').status, 'error');
});

test('סקירה: 0 בתים = 0 KB', () => {
  assert.equal(formatBytes(0).replace(/[\u2066\u2069]/g, ''), '0 KB');
  assert.equal(formatBytes(42 * MB).replace(/[\u2066\u2069]/g, ''), '42 MB');
});

test('עותק כקובץ רגיל בתיקיית ההורדות של הטלפון: אחרי הורדה, נשאר אחרי מחיקה מהאפליקציה', async () => {
  const { publicFileName } = await import('../www/js/downloads.js');
  const store = createStore(mem());
  const fs = fakeFs();
  const exported = [];
  fs.exportCopy = async (path, v) => { exported.push([path, v.id]); return `Download/VidLearn/${publicFileName(v, path)}`; };
  const dl = createDownloads({ store, fs, network: fakeNet(), resolveUrl });
  assert.equal(store.state.settings.dlPublicCopy, true, 'ברירת מחדל: פעיל');
  dl.enqueue(arch('a'));
  await settle(dl);
  const d = store.getDownload('archive:a');
  assert.equal(d.status, 'done');
  assert.match(d.publicPath, /^Download\/VidLearn\/a \[[0-9a-f]{6}\]\.mp4$/);
  assert.equal(exported.length, 1);
  await dl.remove('archive:a');
  assert.equal(exported.length, 1, 'המחיקה מהאפליקציה לא נוגעת בעותק שבטלפון');
});

test('עותק בטלפון: כבוי בהגדרות ← לא נשמר; כשל ← ההורדה עדיין הצליחה; ייצוא ידני', async () => {
  const store = createStore(mem());
  store.setSetting('dlPublicCopy', false);
  const fs = fakeFs();
  let n = 0;
  fs.exportCopy = async () => { n++; if (n === 1) throw new Error('denied'); return 'Download/VidLearn/x.mp4'; };
  const dl = createDownloads({ store, fs, network: fakeNet(), resolveUrl });
  dl.enqueue(arch('a'));
  await settle(dl);
  assert.equal(n, 0);
  store.setSetting('dlPublicCopy', true);
  dl.enqueue(arch('b'));
  await settle(dl);
  assert.equal(store.getDownload('archive:b').status, 'done', 'כשל בעותק לא מפיל את ההורדה');
  assert.ok(!store.getDownload('archive:b').publicPath);
  assert.equal(await dl.exportToDevice('archive:b'), 'Download/VidLearn/x.mp4');
  assert.equal(store.getDownload('archive:b').publicPath, 'Download/VidLearn/x.mp4');
  await assert.rejects(dl.exportToDevice('archive:none'));
});

test('שם קריא לקובץ בטלפון: בלי תווים אסורים, פרק עם שם הספר ומספר', async () => {
  const { publicFileName } = await import('../www/js/downloads.js');
  assert.match(publicFileName({ id: 'x', title: 'שיעור: "אלגברה"/1?' }, 'videos/archive-1.mp4'), /^שיעור אלגברה 1 \[[0-9a-f]{6}\]\.mp4$/);
  assert.match(publicFileName({ id: 'b#3', kind: 'chapter', index: 2, title: 'Chapter 3' }, 'videos/audio-1.mp3', 'Pride and Prejudice'), /^Pride and Prejudice - 03 Chapter 3 \[[0-9a-f]{6}\]\.mp3$/);
  assert.match(publicFileName({ id: 'y', title: '' }, 'videos/book-1.txt'), /^VidLearn \[[0-9a-f]{6}\]\.txt$/);
  assert.notEqual(publicFileName({ id: 'a', title: 'T' }, 'x.mp4'), publicFileName({ id: 'b', title: 'T' }, 'x.mp4'), 'אותו שם — קבצים שונים');
});
