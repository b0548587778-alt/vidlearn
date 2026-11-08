// ערך מוויקיפדיה לנושא החיפוש: תקציר בראש התוצאות, קריאת הערך המלא באפליקציה,
// והמונח המקביל באנגלית (קישור בין-לשוני) — כדי לחפש גם במקורות שכמעט אין בהם עברית.
// טהור — בונה כתובות ומפרק תשובות; נבדק ב-tests/wiki.test.mjs.
import { safeUrl, isHebrew } from './util.js';

// שפת הוויקיפדיה לחיפוש: לפי האותיות בשאילתה, אחרת שפת הממשק
export function wikiLang(query, uiLang = 'he') {
  if (isHebrew(query)) return 'he';
  if (/[؀-ۿ]/.test(query)) return 'ar';
  if (/[Ѐ-ӿ]/.test(query)) return 'ru';
  return /[a-z]/i.test(query) ? 'en' : uiLang;
}

export function isHebrewQuery(q) {
  return isHebrew(q);
}

// "שיעור במתמטיקה" ← "מתמטיקה": מילות לימוד כלליות מפריעות למציאת הערך
const NOISE = /(^|\s)(ש?ה?ל?ב?)(שיעור(ים)?|הרצא(ה|ות)|קורס(ים)?|לימוד|למידה|מבוא|הסבר|מדריך|סרטונ?(ים)?|lessons?|lectures?|courses?|tutorials?|introduction|intro|learn(ing)?|for|to|in|of)(?=\s|$)/giu;
export function topicOf(query) {
  const q = String(query || '')
    // ראשי תיבות: תנ"ך ← תנ״ך (גרשיים — מרכאות רגילות הן "חיפוש ביטוי" בוויקיפדיה)
    .replace(/([\u05D0-\u05EA])"(?=[\u05D0-\u05EA])/g, '$1״')
    .replace(/([\u05D0-\u05EA])'(?=[\u05D0-\u05EA]|\s|$)/g, '$1׳')
    .replace(/["'`]/g, ' ')
    .trim();
  const t = q.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  return t || q.replace(/\s+/g, ' ');
}

// גרסאות לחיפוש: הנושא עצמו, ובעברית — גם בלי אות שימוש בתחילת מילה ("בפיזיקה" ← "פיזיקה").
// לא יודעים מראש אם האות שייכת למילה ("ביולוגיה"), לכן מחפשים את שתיהן ובוחרים התאמה מדויקת
export function topicVariants(query) {
  const t = topicOf(query);
  const out = [t];
  if (isHebrew(t)) {
    const stripped = t.split(' ').map((w) => (w.length > 3 ? w.replace(/^(ו?ה|ו?ב|ו?ל|ו?מ|ש|ו|כ)(?=[\u05D0-\u05EA]{3})/, '') : w)).join(' ');
    if (stripped !== t) out.push(stripped);
  }
  return out;
}

const norm = (s) => String(s || '').replace(/[\u0591-\u05C7]/g, '').replace(/["״]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

// תקציר + תמונה + קישור + המונח באנגלית — בקשה אחת
export function buildWikiSummaryUrl(query, lang = 'he') {
  const variants = topicVariants(query);
  if (!variants[0]) throw new Error('empty-query');
  const sp = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: variants.length > 1 ? variants.map((v) => `(${v})`).join(' OR ') : variants[0],
    gsrlimit: '5',
    gsrnamespace: '0',
    prop: 'extracts|pageimages|info|langlinks',
    exintro: '1',
    explaintext: '1',
    exsentences: '8',
    piprop: 'thumbnail',
    pithumbsize: '240',
    inprop: 'url',
    lllang: lang === 'en' ? 'he' : 'en',
    lllimit: 'max',
    exlimit: 'max',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  return `https://${lang}.wikipedia.org/w/api.php?${sp}`;
}

// ← { title, extract, thumb, url, lang, pageid, alt } או null.
// query: השאילתה המקורית — מעדיפים ערך ששמו הוא בדיוק הנושא, אחרת התוצאה הראשונה בחיפוש
export function parseWikiSummary(json, lang = 'he', query = '') {
  const raw = json?.query?.pages;
  const pages = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(Boolean)
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  // התאמה לנושא כמו שנכתב קודם ("ביולוגיה"), ורק אחריה לגרסה בלי אות השימוש ("בפיזיקה" ← "פיזיקה")
  const exact = topicVariants(query).map(norm).map((v) => pages.find((x) => norm(x.title) === v)).find(Boolean);
  const p = exact || pages[0];
  if (!p || p.missing || !p.title) return null;
  const extract = String(p.extract || '').trim();
  if (extract.length < 40) return null; // דף פירושונים / ריק
  // דף פירושונים / דף שם פרטי (\b של JS לא מכיר אותיות עבריות — לכן (^|\s))
  if (/may refer to:|יכול להתייחס ל|(^|\s)הוא שם (פרטי|משפחה)|^\S+ הוא שם(\s|$)/.test(extract.slice(0, 200))) return null;
  const other = Array.isArray(p.langlinks) ? p.langlinks.find((l) => l && (l.title || l['*'])) : null;
  return {
    title: String(p.title),
    extract,
    thumb: safeUrl(p.thumbnail?.source),
    url: safeUrl(p.fullurl) || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`,
    lang,
    pageid: Number(p.pageid) || 0,
    // המונח בשפה השנייה (בעברית ← באנגלית) — לחיפוש נוסף
    alt: other ? String(other.title || other['*']) : '',
  };
}

// הערך המלא כטקסט (לקריאה באפליקציה)
export function buildWikiArticleUrl(pageid, lang = 'he') {
  const sp = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki',
    pageids: String(Number(pageid) || 0), format: 'json', formatversion: '2', origin: '*',
  });
  return `https://${lang}.wikipedia.org/w/api.php?${sp}`;
}

// ← טקסט הערך בלי הפרקים שאינם תוכן (הערות שוליים, ראו גם, קישורים חיצוניים)
const TAIL = /^(==\s*(ראו גם|הערות שוליים|קישורים חיצוניים|לקריאה נוספת|ביבליוגרפיה|מקורות|See also|References|Notes|External links|Further reading|Bibliography|Sources)\s*==)\s*$/m;
export function parseWikiArticle(json) {
  const p = Array.isArray(json?.query?.pages) ? json.query.pages[0] : null;
  let text = String(p?.extract || '');
  const cut = text.search(TAIL);
  if (cut >= 0) text = text.slice(0, cut);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// מבנה לתצוגה: כותרות (== x ==) ופסקאות
export function articleBlocks(text) {
  return String(text || '').split(/\n+/).map((line) => {
    const m = line.match(/^(={2,6})\s*(.*?)\s*\1$/);
    return m ? { type: 'h', level: m[1].length, text: m[2] } : { type: 'p', text: line.trim() };
  }).filter((b) => b.text);
}
