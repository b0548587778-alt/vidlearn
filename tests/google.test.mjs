import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogle, signInErrorKey, ACCOUNT_KEY } from '../www/js/google.js';
import { createStore } from '../www/js/store.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

// Drive מדומה: קובץ אחד בתיקיית האפליקציה
function fakeDrive(initial = null) {
  const drive = { file: initial, id: initial ? 'F1' : null, calls: [] };
  drive.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    drive.calls.push(`${method} ${url.split('?')[0]}`);
    if (opts.headers?.Authorization !== 'Bearer TOK') return res(401);
    if (url.includes('/userinfo')) return res(200, { email: 'me@example.com', name: 'Me' });
    if (url.includes('/upload/') && method === 'PATCH') { drive.file = JSON.parse(opts.body); return res(200, { id: drive.id }); }
    if (url.includes('alt=media')) return res(200, drive.file);
    if (method === 'POST') { drive.id = 'F1'; return res(200, { id: 'F1' }); }
    return res(200, { files: drive.id ? [{ id: drive.id }] : [] });
  };
  return drive;
}
const native = { signIn: async () => ({ accessToken: 'TOK' }), clearToken: async () => {} };

test('כניסה: פרטי החשבון, סנכרון ראשון יוצר קובץ, ויוטיוב מופעל', async () => {
  const storage = mem();
  const store = createStore(storage);
  store.createCourse('כימיה');
  const drive = fakeDrive();
  const g = createGoogle({ native, store, storage, fetchImpl: drive.fetch, syncDelayMs: 1e9 });
  assert.equal(g.signedIn, false);
  await g.signIn();
  assert.equal(g.account.email, 'me@example.com');
  assert.equal(g.signedIn, true);
  assert.equal(drive.file.courses[0].name, 'כימיה');
  assert.equal(store.state.settings.sources.find((s) => s.id === 'youtube').enabled, true);
  assert.ok(JSON.parse(storage.getItem(ACCOUNT_KEY)).lastSync > 0);
});

test('טלפון שני: מקבל את הנתונים מ-Drive ומעלה את שלו', async () => {
  const storageA = mem();
  const a = createStore(storageA);
  a.createCourse('היסטוריה');
  const drive = fakeDrive();
  await createGoogle({ native, store: a, storage: storageA, fetchImpl: drive.fetch, syncDelayMs: 1e9 }).signIn();

  const storageB = mem();
  const b = createStore(storageB);
  b.createCourse('ביולוגיה');
  let applied = 0;
  const gb = createGoogle({ native, store: b, storage: storageB, fetchImpl: drive.fetch, syncDelayMs: 1e9, onApplied: () => applied++ });
  await gb.signIn();
  assert.deepEqual(b.state.courses.map((c) => c.name).sort(), ['ביולוגיה', 'היסטוריה']);
  assert.equal(applied, 1);
  assert.deepEqual(drive.file.courses.map((c) => c.name).sort(), ['ביולוגיה', 'היסטוריה']);
  await gb.sync(); // הפעלת יוטיוב אחרי הכניסה — שינוי אמיתי שעולה
  // בלי שינוי — אין העלאה נוספת
  const uploads = drive.calls.filter((c) => c.startsWith('PATCH')).length;
  await gb.sync();
  assert.equal(drive.calls.filter((c) => c.startsWith('PATCH')).length, uploads);
});

test('טוקן שפג: 401 ← טוקן חדש וניסיון נוסף', async () => {
  const storage = mem();
  storage.setItem(ACCOUNT_KEY, JSON.stringify({ email: 'me@example.com' }));
  const store = createStore(storage);
  let n = 0;
  const cleared = [];
  const nat = { signIn: async () => ({ accessToken: n++ === 0 ? 'OLD' : 'TOK' }), clearToken: async ({ token }) => { cleared.push(token); } };
  const g = createGoogle({ native: nat, store, storage, fetchImpl: fakeDrive().fetch, syncDelayMs: 1e9 });
  assert.equal(await g.sync(), true);
  assert.deepEqual(cleared, ['OLD']);
});

test('התנתקות: החשבון נמחק, הנתונים נשארים; בדפדפן — לא זמין', async () => {
  const storage = mem();
  const store = createStore(storage);
  store.createCourse('גאוגרפיה');
  const drive = fakeDrive();
  const g = createGoogle({ native, store, storage, fetchImpl: drive.fetch, syncDelayMs: 1e9 });
  await g.signIn();
  await g.signOut();
  assert.equal(g.signedIn, false);
  assert.equal(storage.getItem(ACCOUNT_KEY), null);
  assert.equal(store.state.courses.length, 1);
  assert.ok(drive.calls.some((c) => c.includes('oauth2.googleapis.com/revoke')));

  const web = createGoogle({ native: null, store, storage, fetchImpl: drive.fetch });
  assert.equal(web.available, false);
  await assert.rejects(web.signIn(), /not-available/);
});

test('שגיאות כניסה ← הודעה מתאימה', () => {
  assert.equal(signInErrorKey({ code: 'canceled', message: 'canceled' }), 'googleCanceled');
  assert.equal(signInErrorKey({ code: 'not-configured' }), 'googleNotConfigured');
  assert.equal(signInErrorKey({ message: 'network' }), 'googleNetwork');
  assert.equal(signInErrorKey(new Error('failed:8')), 'googleFailed');
});
