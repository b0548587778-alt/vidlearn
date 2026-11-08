import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, courseProgress, continueWatching, normalizeState, STORAGE_KEY } from '../www/js/store.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}
const vid = (id) => ({ id, title: `T ${id}`, sourceType: 'commons', sourceName: 'C', play: { kind: 'video', url: 'https://x/a.webm' } });

test('קורס: הוספה, סדר, התקדמות והשיעור הבא', () => {
  const s = createStore(mem());
  const c = s.createCourse('אלגברה');
  ['a', 'b', 'c'].forEach((id) => s.addLesson(c.id, vid(id)));
  assert.equal(s.addLesson(c.id, vid('a')), false, 'בלי כפילויות');
  s.moveLesson(c.id, 2, -1);
  assert.deepEqual(s.state.courses[0].lessons.map((l) => l.id), ['a', 'c', 'b']);
  s.setDone('a', true);
  const pr = courseProgress(s.state.courses[0], s.state.progress);
  assert.deepEqual(pr, { done: 1, total: 3, pct: 33, nextIndex: 1 });
});

test('מיקום: 90% = נלמד; המשך לצפות', () => {
  const s = createStore(mem());
  s.addHistory(vid('a'));
  s.addHistory(vid('b'));
  s.setPosition('a', 60, 600);
  s.setPosition('b', 95, 100);
  assert.equal(s.getProgress('b').done, true);
  assert.deepEqual(continueWatching(s.state).map((v) => v.id), ['a']);
});

test('הערות לפי זמן, ממוינות', () => {
  const s = createStore(mem());
  s.addNote('a', 'שני', 120);
  s.addNote('a', 'ראשון', 10.4);
  assert.equal(s.addNote('a', '   '), false);
  assert.deepEqual(s.notesFor('a').map((n) => [n.text, n.t]), [['ראשון', 10], ['שני', 120]]);
});

test('מקורות: הוספת שרת https בלבד, בלי כפילות; מובנה לא נמחק', () => {
  const s = createStore(mem());
  const src = s.addSource({ type: 'peertube', url: 'tube.example.org' });
  assert.equal(src.url, 'https://tube.example.org');
  assert.throws(() => s.addSource({ type: 'peertube', url: 'https://tube.example.org/' }), /duplicate/);
  assert.throws(() => s.addSource({ type: 'peertube', url: 'http://bad.org' }), /https-only/);
  assert.equal(s.removeSource('sepia'), false);
  assert.equal(s.removeSource(src.id), true);
});

test('נשמר וחוזר, וגיבוי JSON', () => {
  const st = mem();
  const a = createStore(st);
  a.toggleFavorite(vid('a'));
  const b = createStore(st);
  assert.equal(b.isFavorite('a'), true);
  const c = createStore(mem());
  c.importJson(a.exportJson());
  assert.equal(c.isFavorite('a'), true);
  assert.throws(() => c.importJson('{}'), /bad-backup/);
});

test('קלט פגום ← מצב ברירת מחדל, ומקור מובנה חסר נוסף', () => {
  const st = mem();
  st.setItem(STORAGE_KEY, '{not json');
  assert.equal(createStore(st).state.settings.sources.length, 4);
  const n = normalizeState({ settings: { lang: 'xx', sources: [{ id: 'evil', type: 'nope' }] } });
  assert.equal(n.settings.lang, 'he');
  assert.deepEqual(n.settings.sources.map((x) => x.id), ['sepia', 'archive', 'commons', 'youtube']);
});

test('כישלון שמירה מדווח', () => {
  let called = 0;
  const s = createStore({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } }, { onSaveError: () => called++ });
  assert.equal(s.createCourse('x').name, 'x');
  assert.equal(called, 1);
});
