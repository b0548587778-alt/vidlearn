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
