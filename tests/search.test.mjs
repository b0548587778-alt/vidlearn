import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAll } from '../www/js/search.js';
import { defaultState } from '../www/js/store.js';

test('מקור שנכשל לא מפיל את החיפוש; תוכן לא הולם מסונן', async () => {
  const settings = defaultState().settings;
  const fetchImpl = async (url) => {
    if (url.includes('sepiasearch')) throw new Error('offline');
    if (url.includes('archive.org')) return { ok: true, json: async () => ({ response: { numFound: 2, docs: [{ identifier: 'ok', title: 'Algebra lesson' }, { identifier: 'bad', title: 'Casino tricks' }] } }) };
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const r = await searchAll('algebra', settings, { fetchImpl });
  assert.deepEqual(r.items.map((v) => v.id), ['archive:ok']);
  assert.equal(r.filtered, 1);
  assert.deepEqual(r.errors.map((e) => e.source.id).sort(), ['commons', 'sepia']);
  assert.equal(r.searched, 3, 'יוטיוב בלי מפתח לא נשאל');
});

test('סקירה: מקור שלא עונה בכלל (fetch שמתעלם מ-signal) לא תוקע את החיפוש', async () => {
  const settings = defaultState().settings;
  const fetchImpl = (url) => (url.includes('sepiasearch')
    ? new Promise(() => {}) // לא עונה לעולם
    : Promise.resolve({ ok: true, json: async () => ({ response: { numFound: 1, docs: [{ identifier: 'ok', title: 'Algebra lesson' }] } }) }));
  const r = await searchAll('algebra', settings, { fetchImpl, timeoutMs: 50 });
  assert.ok(r.items.some((v) => v.id === 'archive:ok'));
  assert.ok(r.errors.some((e) => e.source.id === 'sepia' && e.message === 'timeout'));
});

test('סקירה: יוטיוב מקבל משך מבקשה נוספת', async () => {
  const settings = defaultState().settings;
  settings.sources = settings.sources.map((s) => (s.id === 'youtube' ? { ...s, enabled: true, key: 'K' } : { ...s, enabled: false }));
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => (url.includes('/videos?')
      ? { items: [{ id: 'abcdefghijk', contentDetails: { duration: 'PT1H2M3S' } }] }
      : { items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: 'Physics lecture' } }] }),
  });
  const r = await searchAll('physics', settings, { fetchImpl });
  assert.equal(r.items[0].duration, 3723);
});
