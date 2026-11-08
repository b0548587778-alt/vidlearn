import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiLang, topicOf, topicVariants, buildWikiSummaryUrl, parseWikiSummary, parseWikiArticle, articleBlocks } from '../www/js/wiki.js';
import { searchAll, searchMedia, fetchWikiSummary } from '../www/js/search.js';
import { defaultState } from '../www/js/store.js';

test('שפת הוויקיפדיה לפי השאילתה', () => {
  assert.equal(wikiLang('מתמטיקה'), 'he');
  assert.equal(wikiLang('math', 'he'), 'en');
  assert.equal(wikiLang('123', 'en'), 'en');
});

test('נושא החיפוש: בלי מילות לימוד; ראשי תיבות; גרסה בלי אות שימוש', () => {
  assert.equal(topicOf('שיעור במתמטיקה'), 'במתמטיקה');
  assert.equal(topicOf('physics lecture'), 'physics');
  assert.equal(topicOf('תנ"ך'), 'תנ״ך');
  assert.equal(topicOf('שיעור'), 'שיעור', 'רק מילת לימוד — נשארת');
  assert.deepEqual(topicVariants('מבוא לכלכלה'), ['לכלכלה', 'כלכלה']);
  assert.deepEqual(topicVariants('math'), ['math']);
  const u = new URL(buildWikiSummaryUrl('שיעור בפיזיקה', 'he'));
  assert.equal(u.host, 'he.wikipedia.org');
  assert.equal(u.searchParams.get('gsrsearch'), '(בפיזיקה) OR (פיזיקה)');
  assert.equal(u.searchParams.get('lllang'), 'en');
});

const pages = (list) => ({ query: { pages: list } });
const page = (o) => ({ pageid: 1, index: 1, title: 'x', extract: 'טקסט ארוך מספיק כדי להיחשב תקציר אמיתי של ערך בוויקיפדיה.', fullurl: 'https://he.wikipedia.org/wiki/x', ...o });

test('פירוק התקציר: התאמה מדויקת קודם, המונח באנגלית, דפי פירושונים נפסלים', () => {
  const json = pages([
    page({ pageid: 1, index: 1, title: 'פיזיקת חלקיקים', langlinks: [{ lang: 'en', title: 'Particle physics' }] }),
    page({ pageid: 2, index: 2, title: 'פיזיקה', langlinks: [{ lang: 'en', title: 'Physics' }], thumbnail: { source: 'https://up.wikimedia.org/a.jpg' } }),
  ]);
  const w = parseWikiSummary(json, 'he', 'שיעור בפיזיקה');
  assert.equal(w.title, 'פיזיקה');
  assert.equal(w.alt, 'Physics');
  assert.equal(w.thumb, 'https://up.wikimedia.org/a.jpg');
  assert.equal(w.pageid, 2);
  // אין התאמה מדויקת ← התוצאה הראשונה
  assert.equal(parseWikiSummary(json, 'he', 'משהו').title, 'פיזיקת חלקיקים');
  assert.equal(parseWikiSummary(pages([page({ extract: 'קצר' })]), 'he', 'x'), null);
  assert.equal(parseWikiSummary(pages([page({ extract: 'Mercury may refer to: a planet, an element, a god and more things.' })]), 'en', 'x'), null);
  assert.equal(parseWikiSummary({}, 'he'), null);
  assert.equal(parseWikiSummary(pages([page({ thumbnail: { source: 'javascript:alert(1)' } })]), 'he', 'x').thumb, '');
});

test('הערך המלא: בלי הערות שוליים / קישורים חיצוניים; כותרות ופסקאות', () => {
  const text = 'פתיחה.\n\n== היסטוריה ==\nתוכן.\n=== תת ===\nעוד.\n\n== הערות שוליים ==\nזבל';
  const clean = parseWikiArticle(pages([{ extract: text }]));
  assert.ok(!clean.includes('זבל'));
  assert.deepEqual(articleBlocks(clean), [
    { type: 'p', text: 'פתיחה.' }, { type: 'h', level: 2, text: 'היסטוריה' }, { type: 'p', text: 'תוכן.' },
    { type: 'h', level: 3, text: 'תת' }, { type: 'p', text: 'עוד.' },
  ]);
});

test('ערך עם מילה אסורה לא מוצג; שגיאה ← null', async () => {
  const settings = defaultState().settings;
  const bad = async () => ({ ok: true, json: async () => pages([page({ title: 'קזינו' })]) });
  assert.equal(await fetchWikiSummary('קזינו', settings, { fetchImpl: bad }), null);
  assert.equal(await fetchWikiSummary('x', settings, { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

const archive = (docs) => ({ ok: true, json: async () => ({ response: { numFound: docs.length, docs } }) });

test('חיפוש בעברית מורחב למונח באנגלית: תוצאות העברית קודם, דפדוף לכל משימה', async () => {
  const settings = defaultState().settings;
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(decodeURIComponent(url));
    if (!url.includes('archive.org')) return { ok: true, json: async () => ({}) };
    return url.includes('Mathematics')
      ? archive([{ identifier: 'en1', title: 'Mathematics lesson' }, { identifier: 'he1', title: 'שיעור מתמטיקה' }])
      : archive([{ identifier: 'he1', title: 'שיעור מתמטיקה' }]);
  };
  const r = await searchAll('מתמטיקה', settings, { fetchImpl, alt: Promise.resolve('Mathematics') });
  assert.deepEqual(r.items.map((v) => v.id), ['archive:he1', 'archive:en1'], 'עברית קודם, בלי כפילות');
  assert.equal(r.alt, 'Mathematics');
  assert.ok('archive~alt' in r.cursors);
  assert.ok(!asked.some((u) => u.includes('googleapis')), 'יוטיוב כבוי');
  // בלי מונח (ויקיפדיה לא מצאה) ← רק החיפוש המקורי
  const r2 = await searchAll('מתמטיקה', settings, { fetchImpl, alt: Promise.resolve(null) });
  assert.deepEqual(r2.items.map((v) => v.id), ['archive:he1']);
  // ויקיפדיה נכשלה — החיפוש לא נופל
  const r3 = await searchAll('מתמטיקה', settings, { fetchImpl, alt: Promise.reject(new Error('x')) });
  assert.deepEqual(r3.items.map((v) => v.id), ['archive:he1']);
});

test('ספרי שמע: גם המונח באנגלית (LibriVox כמעט כולו באנגלית)', async () => {
  const settings = defaultState().settings;
  const fetchImpl = async (url) => (decodeURIComponent(url).includes('History')
    ? archive([{ identifier: 'lv1', title: 'History of Rome', collection: ['librivoxaudio'] }])
    : archive([]));
  const r = await searchMedia('audiobook', 'היסטוריה', settings, { fetchImpl, alt: 'History' });
  assert.deepEqual(r.items.map((v) => v.id), ['audio:lv1']);
});

test('סקירה: דף שם פרטי בעברית לא מוצג כערך', () => {
  assert.equal(parseWikiSummary(pages([page({ extract: 'דוד הוא שם פרטי עברי נפוץ, שמקורו בתנ"ך ובדמותו של דוד המלך.' })]), 'he', 'דוד'), null);
  assert.ok(parseWikiSummary(pages([page({ extract: 'דוד המלך היה מלך ישראל השני, אחרי שאול, ומייסד בית דוד בירושלים.' })]), 'he', 'דוד'));
});

test('סקירה: altOnly — רק החיפוש באנגלית (העברית כבר מוצגת)', async () => {
  const settings = defaultState().settings;
  const asked = [];
  const fetchImpl = async (url) => { asked.push(decodeURIComponent(url)); return archive([{ identifier: 'en1', title: 'Mathematics lesson' }]); };
  const r = await searchAll('מתמטיקה', settings, { fetchImpl, alt: 'Mathematics', altOnly: true });
  assert.ok(asked.every((u) => !u.includes('מתמטיקה')));
  assert.ok(Object.keys(r.cursors).every((k) => k.endsWith('~alt')));
  assert.ok(r.items.some((v) => v.id === 'archive:en1'));
});
