import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioSearchUrl, buildBookSearchUrl, buildScannedSearchUrl, parseArchiveItems, parseAudioChapters, pickBookText, cleanBookText, paginate, textDir, itemHash } from '../www/js/media.js';
import { canDownload } from '../www/js/sources.js';
import { searchMedia, resolveDirectFile } from '../www/js/search.js';
import { defaultState, createStore } from '../www/js/store.js';

test('חיפוש ספרי שמע: LibriVox, בלי ז\'אנרים לא מתאימים, שפה', () => {
  const q = new URL(buildAudioSearchUrl('history', { page: 1, langs: ['en'] })).searchParams.get('q');
  assert.match(q, /collection:librivoxaudio/);
  assert.match(q, /-subject:\("romance"/);
  assert.match(q, /language:\(eng OR english OR en\)/);
  assert.equal(new URL(buildAudioSearchUrl('a b')).searchParams.get('page'), '1');
});

test('חיפוש ספרים: Gutenberg, וסרוקים בלי ספרי השאלה', () => {
  assert.match(new URL(buildBookSearchUrl('algebra')).searchParams.get('q'), /collection:gutenberg/);
  const sq = new URL(buildScannedSearchUrl('דקדוק')).searchParams.get('q');
  assert.match(sq, /NOT access-restricted-item:true/);
  assert.match(sq, /\(דקדוק\)/);
  assert.throws(() => buildBookSearchUrl('  ()'), /empty-query/);
});

test('פירוק תוצאות: סוג, מקור, ופסילה לפי נושא', () => {
  const { items, next } = parseArchiveItems({ response: { numFound: 30, docs: [
    { identifier: 'abc_gut', title: 'Algebra', creator: ['Boyden'], collection: ['gutenberg'], subject: ['Mathematics'] },
    { identifier: 'xyz', title: 'Bad', subject: ['Love stories'] },
    { identifier: 'bad id/../x', title: 'x' },
  ] } }, 'book');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'book:abc_gut');
  assert.equal(items[0].kind, 'book');
  assert.equal(items[0].sourceName, 'Project Gutenberg');
  assert.equal(items[0].author, 'Boyden');
  assert.equal(next, 1);
  assert.equal(parseArchiveItems({ response: { numFound: 1, docs: [{ identifier: 'a', title: 'A' }] } }, 'audiobook').items[0].id, 'audio:a');
});

test('פרקים: MP3 אחד לפרק (64kbps), לפי הסדר', () => {
  const book = { id: 'audio:mal', nativeId: 'mal', sourceName: 'LibriVox' };
  const meta = { files: [
    { name: 'mal_01_jones.mp3', format: 'VBR MP3', size: '16767844', length: '1107.31', title: '01 - Introduction', track: '2' },
    { name: 'mal_01_jones_64kb.mp3', format: '64Kbps MP3', size: '8869001', length: '1107.33', title: '01 - Introduction', track: '2' },
    { name: 'mal_00_jones_64kb.mp3', size: '1146798', length: '143.02', title: '00 - Preface', track: '1' },
    { name: 'mal_00_jones_128kb.mp3', size: '2292595', length: '142.99', title: '00 - Preface', track: '1' },
    { name: 'cover.jpg' },
  ] };
  const ch = parseAudioChapters(book, meta);
  assert.equal(ch.length, 2);
  assert.deepEqual(ch.map((c) => c.title), ['00 - Preface', '01 - Introduction']);
  assert.equal(ch[1].url, 'https://archive.org/download/mal/mal_01_jones_64kb.mp3');
  assert.equal(ch[1].id, 'audio:mal#2');
  assert.equal(ch[1].duration, 1107);
  assert.equal(ch[1].size, 8869001);
  assert.equal(canDownload(ch[0]), true);
  assert.equal(itemHash(ch[1]), '#/listen/audio%3Amal?ch=1');
});

test('קובץ טקסט: רגיל לפני OCR; אין ← null', () => {
  const b = { nativeId: 'g' };
  assert.deepEqual(pickBookText(b, { files: [{ name: 'g_djvu.txt', format: 'DjVuTXT', size: '9' }, { name: '38536.txt', format: 'Text', size: '5' }, { name: 'g_meta.txt' }] }),
    { url: 'https://archive.org/download/g/38536.txt', size: 5, ocr: false });
  assert.equal(pickBookText(b, { files: [{ name: 'g_djvu.txt', format: 'DjVuTXT', size: '9' }] }).ocr, true);
  assert.equal(pickBookText(b, { files: [{ name: 'a.pdf' }] }), null);
});

test('ניקוי טקסט Gutenberg ושבירות שורה', () => {
  const raw = 'Header junk\r\n*** START OF THE PROJECT GUTENBERG EBOOK ALGEBRA ***\r\nCHAPTER I\r\n\r\nThis is a long line of the book that the printer broke at seventy\r\ncharacters for the old terminals.\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK ***\r\nLicense';
  const t = cleanBookText(raw);
  assert.ok(!t.includes('Header') && !t.includes('License'));
  assert.match(t, /seventy characters/);
  assert.match(t, /^CHAPTER I\n\nThis/);
});

test('חלוקה לעמודים ושמירת כל הטקסט', () => {
  const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} `.repeat(20).trim()).join('\n\n');
  const pages = paginate(text, 1000);
  assert.ok(pages.length > 5);
  assert.ok(pages.every((p) => p.length <= 1000));
  assert.equal(pages.join(' ').replace(/\s+/g, ' ').length, text.replace(/\s+/g, ' ').length);
  assert.deepEqual(paginate(''), ['']);
});

test('כיוון טקסט', () => {
  assert.equal(textDir('בראשית ברא אלהים'), 'rtl');
  assert.equal(textDir('In the beginning'), 'ltr');
});

test('חיפוש ספרים: Gutenberg ראשון, וסרוקים — מקור שנכשל לא מפיל', async () => {
  const st = defaultState().settings;
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get('q');
    if (q.startsWith('mediatype:texts AND collection:gutenberg')) return { ok: true, json: async () => ({ response: { numFound: 1, docs: [{ identifier: 'g1', title: 'Algebra lesson', collection: ['gutenberg'] }] } }) };
    return { ok: true, json: async () => ({ response: { numFound: 1, docs: [{ identifier: 's1', title: 'Algebra scanned' }] } }) };
  };
  const r = await searchMedia('book', 'algebra', st, { fetchImpl });
  assert.deepEqual(r.items.map((v) => v.id), ['book:g1', 'book:s1']);
  const r2 = await searchMedia('book', 'algebra', { ...st, bookScanned: false }, { fetchImpl });
  assert.deepEqual(r2.items.map((v) => v.id), ['book:g1']);
  const half = async (url) => (new URL(url).searchParams.get('q').startsWith('mediatype:texts AND collection:gutenberg') ? fetchImpl(url) : Promise.reject(new Error('down')));
  assert.deepEqual((await searchMedia('book', 'algebra', st, { fetchImpl: half })).items.map((v) => v.id), ['book:g1']);
});

test('הורדת ספר: קובץ הטקסט מהמטא-דאטה', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ files: [{ name: '1.txt', format: 'Text', size: '100' }] }) });
  assert.deepEqual(await resolveDirectFile({ sourceType: 'book', nativeId: 'b', kind: 'book' }, { fetchImpl }), { url: 'https://archive.org/download/b/1.txt', size: 100 });
});

test('מטמון פרקים נשמר ומוגבל', () => {
  const m = new Map();
  const s = createStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) });
  const ch = [{ id: 'audio:a#1', title: 'P', play: { kind: 'audio', url: 'https://archive.org/download/a/1.mp3' }, sourceType: 'audio', kind: 'chapter', bookId: 'audio:a', index: 0 }];
  s.setChapters('audio:a', ch);
  const s2 = createStore({ getItem: (k) => m.get(k) ?? null, setItem: () => {} });
  assert.equal(s2.getChapters('audio:a')[0].play.kind, 'audio');
  assert.equal(s2.getChapters('audio:a')[0].bookId, 'audio:a');
});
