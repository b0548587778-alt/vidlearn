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

test('סקירה: גיבוי פגום לא שובר את המסכים', () => {
  const s = createStore(mem());
  s.importJson(JSON.stringify({
    settings: {},
    favorites: [{ id: 'x' }, { id: 'ok', title: 'T', play: { kind: 'video', url: 'https://a/b.mp4' } }],
    courses: [{ id: 'c', name: 'C', lessons: [{ id: 'bad' }] }],
    notes: { x: 'text', y: [{ text: 'טוב', t: 5 }, { nope: 1 }] },
    progress: { a: 'x', b: { pos: '10', done: 1 } },
  }));
  assert.deepEqual(s.state.favorites.map((f) => f.id), ['ok']);
  assert.equal(s.state.courses[0].lessons.length, 0);
  assert.deepEqual(s.notesFor('x'), []);
  assert.deepEqual(s.notesFor('y').map((n) => n.text), ['טוב']);
  assert.deepEqual(s.getProgress('b'), { pos: 10, dur: 0, done: true, at: 0 });
  assert.equal(s.getProgress('a'), null);
});

test('סקירה: מפתח API לא יוצא בגיבוי, ונשמר בייבוא', () => {
  const s = createStore(mem());
  s.updateSource('youtube', { key: 'SECRET', enabled: true });
  const json = s.exportJson();
  assert.ok(!json.includes('SECRET'));
  s.importJson(json);
  assert.equal(s.state.settings.sources.find((x) => x.id === 'youtube').key, 'SECRET');
});

test('סקירה: רשומות התקדמות מוגבלות, בלי לגעת בשיעורי קורס', async () => {
  const { MAX_PROGRESS } = await import('../www/js/store.js');
  const s = createStore(mem());
  const c = s.createCourse('ק');
  s.addLesson(c.id, vid('course-lesson'));
  s.setPosition('course-lesson', 1, 100);
  for (let i = 0; i < MAX_PROGRESS + 5; i++) s.state.progress['v' + i] = { pos: 1, dur: 10, at: i + 10 };
  s.setPosition('newest', 1, 100);
  assert.equal(Object.keys(s.state.progress).length, MAX_PROGRESS);
  assert.ok(s.getProgress('course-lesson'), 'שיעור בקורס נשמר');
  assert.ok(s.getProgress('newest'));
  assert.equal(s.getProgress('v0'), null, 'הישן ביותר נמחק');
});
