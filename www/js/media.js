// ספרי שמע וספרי קריאה — מ-Internet Archive (LibriVox, Project Gutenberg, ספרים סרוקים).
// טהור: בונה כתובות ומפרק תשובות; נבדק ב-tests/media.test.mjs.
import { stripHtml, parseDuration, safeUrl } from './util.js';
import { PAGE_SIZE } from './sources.js';

export const KINDS = ['video', 'audiobook', 'podcast', 'book'];

// ז'אנרים שלא מתאימים לאפליקציית לימוד — נפסלים לפי שדה הנושא של הספר
export const BOOK_EXCLUDE_SUBJECTS = [
  'romance', 'love stories', 'love story', 'erotica', 'erotic', 'horror', 'ghost stories', 'vampire',
  'thriller', 'crime fiction', 'detective', 'gothic',
];

function cleanQuery(q) {
  return String(q || '').replace(/[():"\\[\]{}^~*?!+\-&|/]/g, ' ').replace(/\s+/g, ' ').trim();
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.append(k, String(v));
  }
  return sp.toString();
}

const FIELDS = ['identifier', 'title', 'creator', 'description', 'subject', 'language', 'runtime', 'year', 'collection'];
const EXCLUDE = `-subject:(${BOOK_EXCLUDE_SUBJECTS.map((s) => `"${s}"`).join(' OR ')})`;

// שפות התוכן מההגדרות (he, en...) ← קודי השפה של הארכיון
const LANG_CODES = { he: ['heb', 'hebrew', 'he'], en: ['eng', 'english', 'en'], fr: ['fre', 'french', 'fr'], de: ['ger', 'german', 'de'], es: ['spa', 'spanish', 'es'], ar: ['ara', 'arabic', 'ar'], ru: ['rus', 'russian', 'ru'] };
function langClause(langs) {
  const codes = (langs || []).flatMap((l) => LANG_CODES[l] || [l]);
  return codes.length ? ` AND language:(${codes.join(' OR ')})` : '';
}

export function buildAudioSearchUrl(query, { page = 0, langs = [] } = {}) {
  const q = cleanQuery(query);
  if (!q) throw new Error('empty-query');
  return 'https://archive.org/advancedsearch.php?' + qs({
    q: `collection:librivoxaudio AND (title:(${q}) OR subject:(${q}) OR creator:(${q}) OR description:(${q})) ${EXCLUDE}${langClause(langs)}`,
    'fl[]': FIELDS,
    rows: PAGE_SIZE,
    page: page + 1,
    output: 'json',
  });
}

// ספרי Project Gutenberg — טקסט נקי לקריאה
export function buildBookSearchUrl(query, { page = 0, langs = [] } = {}) {
  const q = cleanQuery(query);
  if (!q) throw new Error('empty-query');
  return 'https://archive.org/advancedsearch.php?' + qs({
    q: `mediatype:texts AND collection:gutenberg AND (title:(${q}) OR subject:(${q}) OR creator:(${q})) ${EXCLUDE}${langClause(langs)}`,
    'fl[]': FIELDS,
    rows: PAGE_SIZE,
    page: page + 1,
    output: 'json',
  });
}

// ספרים סרוקים (כולל עברית — כותרות רבות בתעתיק, לכן חיפוש בכל השדות).
// בלי ספרים להשאלה בלבד (access-restricted) — אותם אי אפשר לקרוא
export function buildScannedSearchUrl(query, { page = 0, langs = [] } = {}) {
  const q = cleanQuery(query);
  if (!q) throw new Error('empty-query');
  return 'https://archive.org/advancedsearch.php?' + qs({
    q: `mediatype:texts AND (${q}) AND NOT collection:gutenberg AND NOT access-restricted-item:true ${EXCLUDE}${langClause(langs)}`,
    'fl[]': FIELDS,
    rows: PAGE_SIZE,
    page: page + 1,
    output: 'json',
  });
}

const first = (x) => (Array.isArray(x) ? x[0] : x);
const list = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(String);

// תוצאת חיפוש בארכיון ← פריט אחיד (כמו סרטון, עם kind)
export function parseArchiveItems(json, kind, page = 0) {
  const docs = json?.response?.docs;
  const items = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || !d.identifier || !/^[\w.-]+$/.test(d.identifier)) continue;
    const subjects = list(d.subject);
    if (subjects.some((s) => BOOK_EXCLUDE_SUBJECTS.some((x) => s.toLowerCase().includes(x)))) continue;
    const id = encodeURIComponent(d.identifier);
    const collections = list(d.collection);
    const gutenberg = collections.includes('gutenberg');
    items.push({
      id: `${kind === 'audiobook' ? 'audio' : 'book'}:${d.identifier}`,
      kind,
      nativeId: d.identifier,
      sourceType: kind === 'audiobook' ? 'audiobook' : 'book',
      sourceId: 'archive',
      sourceName: kind === 'audiobook' ? 'LibriVox' : gutenberg ? 'Project Gutenberg' : 'Internet Archive',
      title: String(first(d.title) || d.identifier),
      description: stripHtml(Array.isArray(d.description) ? d.description.join(' ') : d.description),
      author: String(first(d.creator) || ''),
      duration: parseDuration(d.runtime),
      thumb: `https://archive.org/services/img/${id}`,
      play: { kind: 'iframe', url: `https://archive.org/embed/${id}` },
      pageUrl: `https://archive.org/details/${id}`,
      lang: String(first(d.language) || ''),
      tags: subjects,
      gutenberg,
    });
  }
  const found = Number(json?.response?.numFound) || 0;
  return { items, next: (page + 1) * PAGE_SIZE < found ? page + 1 : null };
}

export function metadataUrl(item) {
  return `https://archive.org/metadata/${encodeURIComponent(item.nativeId)}`;
}

// פרקי ספר שמע מהמטא-דאטה: MP3 אחד לכל פרק (64kbps — חוסך נפח), לפי סדר הרצועות
export function parseAudioChapters(item, meta, { quality = 'low' } = {}) {
  const files = Array.isArray(meta?.files) ? meta.files : [];
  const mp3 = files.filter((f) => f && typeof f.name === 'string' && /\.mp3$/i.test(f.name));
  const prefer = quality === 'low' ? /64kb/i : /128kb/i;
  // קבוצה לפי הפרק: שם הקובץ בלי סיומת האיכות
  const byChapter = new Map();
  for (const f of mp3) {
    const key = f.name.replace(/_(64|128)kb\.mp3$/i, '.mp3');
    const cur = byChapter.get(key);
    const score = (x) => (prefer.test(x.name) ? 0 : /_(64|128)kb/i.test(x.name) ? 1 : 2);
    if (!cur || score(f) < score(cur)) byChapter.set(key, f);
  }
  const base = `https://archive.org/download/${encodeURIComponent(item.nativeId)}/`;
  return [...byChapter.values()]
    .map((f, i) => ({
      track: Number(String(f.track || '').split('/')[0]) || i + 1,
      title: stripHtml(f.title) || f.name.replace(/\.mp3$/i, '').replace(/_/g, ' '),
      duration: parseDuration(f.length),
      size: Number(f.size) || 0,
      url: base + f.name.split('/').map(encodeURIComponent).join('/'),
    }))
    .sort((a, b) => a.track - b.track || a.url.localeCompare(b.url))
    .map((c, i) => ({
      ...c,
      // כל פרק הוא פריט בפני עצמו: התקדמות, הערות ושמירה בטלפון לכל פרק
      id: `${item.id}#${i + 1}`,
      kind: 'chapter',
      index: i,
      sourceType: 'audio',
      sourceName: item.sourceName,
      bookId: item.id,
      play: { kind: 'audio', url: c.url },
    }));
}

// קובץ הטקסט הנקי ביותר לקריאה: טקסט רגיל ← טקסט OCR (DjVuTXT). אין ← צפייה בעמודים הסרוקים
export function pickBookText(item, meta) {
  const files = Array.isArray(meta?.files) ? meta.files : [];
  const txt = files.filter((f) => f && typeof f.name === 'string' && /\.txt$/i.test(f.name) && !/_meta\.txt$|_files\.txt$/i.test(f.name));
  if (!txt.length) return null;
  const rank = (f) => (/djvu/i.test(f.format || f.name) ? 1 : 0);
  txt.sort((a, b) => rank(a) - rank(b) || (Number(b.size) || 0) - (Number(a.size) || 0));
  const f = txt[0];
  return {
    url: `https://archive.org/download/${encodeURIComponent(item.nativeId)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
    size: Number(f.size) || 0,
    ocr: rank(f) === 1,
  };
}

// מסיר את הכותרת והסיומת המשפטית של Project Gutenberg ומנרמל שורות
export function cleanBookText(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const start = t.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (start >= 0) t = t.slice(t.indexOf('\n', start) + 1);
  const end = t.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end >= 0) t = t.slice(0, end);
  // שבירת שורות קבועה (~70 תווים) בתוך פסקה ← רווח, כדי שהטקסט יזרום ברוחב המסך.
  // שורות קצרות מאוד (כותרות, שירה) נשארות שורות
  return t
    .replace(/[ \t]+\n/g, '\n')
    .replace(/([^\n])\n(?!\n)(?=[^\n])/g, (m, ch, off, all) => {
      const lineStart = all.lastIndexOf('\n', off - 1) + 1;
      return off - lineStart + 1 < 45 ? m : `${ch} `;
    })
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// חלוקה לעמודים לפי פסקאות (לא חותכים באמצע פסקה, אלא אם היא ארוכה מעמוד)
export function paginate(text, pageChars = 2200) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pages = [];
  let cur = '';
  const push = () => { if (cur) { pages.push(cur); cur = ''; } };
  for (let p of paras) {
    while (p.length > pageChars) {
      push();
      const cut = p.lastIndexOf(' ', pageChars) > pageChars / 2 ? p.lastIndexOf(' ', pageChars) : pageChars;
      pages.push(p.slice(0, cut));
      p = p.slice(cut).trim();
    }
    if (cur && cur.length + p.length + 2 > pageChars) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return pages.length ? pages : [''];
}

// כיוון הטקסט לפי האותיות הראשונות (עברית / ערבית ← מימין לשמאל)
export function textDir(text) {
  const sample = String(text || '').slice(0, 2000);
  const rtl = (sample.match(/[\u0590-\u05FF\u0600-\u06FF]/g) || []).length;
  const ltr = (sample.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
  return rtl > ltr ? 'rtl' : 'ltr';
}

export function isMediaItem(v) {
  return v?.kind === 'audiobook' || v?.kind === 'podcast' || v?.kind === 'book';
}

// כתובת המסך של פריט, לפי סוגו
export function itemHash(v, courseId) {
  const c = courseId ? `?course=${encodeURIComponent(courseId)}` : '';
  if (v.kind === 'chapter') return `#/listen/${encodeURIComponent(v.bookId)}?ch=${Number(v.index) || 0}`;
  if (v.kind === 'audiobook' || v.kind === 'podcast') return `#/listen/${encodeURIComponent(v.id)}${c}`;
  if (v.kind === 'book') return `#/read/${encodeURIComponent(v.id)}${c}`;
  return `#/watch/${encodeURIComponent(v.id)}${c}`;
}

export { safeUrl };
