import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSync, syncPayload, samePayload, stableStringify, parseDriveFind, driveFindUrl } from '../www/js/sync.js';
import { createStore } from '../www/js/store.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const vid = (id) => ({ id, title: `T ${id}`, sourceType: 'commons', sourceName: 'C', play: { kind: 'video', url: 'https://x/a.webm' } });

test('סנכרון: בלי מפתחות API, בלי הורדות ובלי הגדרות ההורדה', () => {
  const s = createStore(mem());
  s.updateSource('youtube', { key: 'SECRET', enabled: true });
  s.setSetting('dlLimitMB', 500);
  s.setDownload('a', { video: vid('a'), status: 'done' });
  const p = s.syncPayload();
  assert.ok(!JSON.stringify(p).includes('SECRET'));
  assert.equal(p.downloads, undefined);
  assert.equal(p.settings.dlLimitMB, undefined);
  assert.equal(p.settings.sources.find((x) => x.id === 'youtube').enabled, true);
});

test('מיזוג: איחוד משני המכשירים, החדש גובר, ומחיקה לא חוזרת', () => {
  const a = createStore(mem());
  const b = createStore(mem());
  const c1 = a.createCourse('אלגברה');
  a.addLesson(c1.id, vid('x'));
  a.toggleFavorite(vid('f1'));
  a.addNote('x', 'הערה מ-A', 5);
  a.setPosition('x', 30, 100);
  // B מקבל את המצב של A
  b.applySync(mergeSync(b.syncPayload(), a.syncPayload()));
  assert.equal(b.state.courses[0].name, 'אלגברה');
  // B: מוחק את המועדף ואת הקורס, מתקדם בסרטון; A: מוסיף הערה
  b.toggleFavorite(vid('f1'));
  b.deleteCourse(c1.id);
  b.setPosition('x', 80, 100);
  b.state.progress.x.at += 1000; // מאוחר יותר מ-A גם אם הכול רץ באותה אלפית שנייה
  a.addNote('x', 'עוד הערה', 50);
  const merged = mergeSync(a.syncPayload(), b.syncPayload());
  assert.equal(merged.favorites.length, 0, 'המחיקה ב-B גוברת');
  assert.equal(merged.courses.length, 0);
  assert.equal(merged.progress.x.pos, 80);
  assert.deepEqual(merged.notes.x.map((n) => n.text), ['הערה מ-A', 'עוד הערה']);
});

test('מיזוג: פריט שנוסף אחרי המחיקה נשאר; הגדרות — החדשות יותר', () => {
  const now = 1_000_000_000_000;
  const local = { settings: { lang: 'he', updatedAt: now - 10 }, favorites: [{ ...vid('f'), favAt: now }], deleted: { 'fav:f': now - 5 } };
  const remote = { settings: { lang: 'en', updatedAt: now - 1 }, deleted: { 'course:old': now - 400 * 86400000 } };
  const m = mergeSync(local, remote, now);
  assert.deepEqual(m.favorites.map((f) => f.id), ['f']);
  assert.equal(m.settings.lang, 'en');
  assert.equal(m.deleted['course:old'], undefined, 'סימון ישן מאוד נמחק');
  assert.ok(m.deleted['fav:f']);
});

test('מיזוג עם קובץ ריק / פגום לא מאבד נתונים מקומיים', () => {
  const s = createStore(mem());
  s.createCourse('פיזיקה');
  const m = mergeSync(s.syncPayload(), null);
  assert.equal(m.courses.length, 1);
  assert.equal(mergeSync(s.syncPayload(), { courses: 'garbage', notes: 5 }).courses.length, 1);
});

test('השוואה לא תלויה בסדר מפתחות', () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.ok(samePayload({ a: 1, b: undefined }, { a: 1 }));
});

test('Drive: חיפוש בתיקיית האפליקציה בלבד', () => {
  assert.match(driveFindUrl(), /spaces=appDataFolder/);
  assert.equal(parseDriveFind({ files: [{ id: 'abc' }] }), 'abc');
  assert.equal(parseDriveFind({}), null);
});

test('ייבוא אחרי סנכרון: מפתח ה-API המקומי נשמר', () => {
  const s = createStore(mem());
  s.updateSource('youtube', { key: 'K', enabled: true });
  s.applySync(mergeSync(s.syncPayload(), { settings: { lang: 'en', updatedAt: Date.now() + 1000, sources: [{ id: 'youtube', type: 'youtube', name: 'YouTube', url: 'https://www.googleapis.com', enabled: true, builtin: true }] } }));
  assert.equal(s.state.settings.lang, 'en');
  assert.equal(s.state.settings.sources.find((x) => x.id === 'youtube').key, 'K');
});
