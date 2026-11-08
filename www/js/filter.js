// סינון: רק סרטוני למידה, בלי תוכן לא הולם. טהור.

// מילים שפוסלות סרטון (כותרת, תיאור, תגיות, ערוץ). המשתמש יכול להוסיף מילים בהגדרות.
export const BLOCKLIST = [
  'porn', 'porno', 'xxx', 'nsfw', 'nude', 'nudity', 'naked', 'erotic', 'sexy', 'sex', 'onlyfans',
  'hentai', 'fetish', 'bikini', 'lingerie', 'strip club', 'dating', 'hookup', 'escort',
  'casino', 'gambling', 'betting', 'poker',
  'gore', 'beheading', 'torture',
  'prank', 'twerk', 'music video', 'official video', 'trailer', 'gameplay', 'let\'s play', 'asmr',
  'פורנו', 'סקס', 'עירום', 'ארוטי', 'הימורים', 'קזינו', 'הכרויות', 'קליפ',
];

// מילים שמעידות על סרטון לימודי — נדרשות במקורות בלי קטגוריית חינוך
export const EDU_MARKERS = [
  'lesson', 'lecture', 'course', 'tutorial', 'class', 'learn', 'learning', 'explained', 'explanation',
  'introduction', 'intro to', 'chapter', 'lab', 'experiment', 'exercise', 'how to', 'guide',
  'education', 'educational', 'university', 'school', 'mooc', 'seminar', 'workshop', 'theory',
  'math', 'physics', 'chemistry', 'biology', 'science', 'history', 'grammar', 'programming',
  'שיעור', 'הרצאה', 'קורס', 'לימוד', 'למידה', 'הסבר', 'מבוא', 'פרק', 'תרגול', 'מדריך', 'הדרכה',
  'אוניברסיטה', 'כיתה', 'מתמטיקה', 'פיזיקה', 'כימיה', 'ביולוגיה', 'מדע', 'היסטוריה', 'דקדוק', 'תכנות',
];

function haystack(v) {
  return [v.title, v.description, v.author, ...(v.tags || [])].join(' \u0001 ').toLowerCase();
}

// התאמת מילה שלמה (גם בעברית עם תחיליות ו/ה/ב/ל/כ/מ/ש).
// whole: בעברית גם סוף מילה (עם סיומת רבים) — "קליפ" לא תופס את "קליפורניה"
function hasWord(text, word, { whole = false } = {}) {
  const w = word.toLowerCase().trim();
  if (!w) return false;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hebrew = /[֐-׿]/.test(w);
  const end = whole ? '(ים|ות|י)?([^\\u0590-\\u05FF]|$)' : '';
  const re = hebrew
    ? new RegExp(`(^|[^\\u0590-\\u05FF])[והבלכמש]{0,2}${esc}${end}`, 'u')
    : new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`);
  return re.test(text);
}

export function blockedBy(v, extraWords = []) {
  const text = haystack(v);
  return [...BLOCKLIST, ...extraWords].find((w) => hasWord(text, w, { whole: true })) || null;
}

export function looksEducational(v) {
  const text = haystack(v);
  return EDU_MARKERS.some((w) => hasWord(text, w));
}

// keywordFilter: המקור אינו מסונן לפי קטגוריה בשרת
export function isAllowed(v, { extraBlock = [], keywordFilter = false, strict = false } = {}) {
  if (!v || !v.title) return false;
  if (blockedBy(v, extraBlock)) return false;
  if ((keywordFilter || strict) && !looksEducational(v)) return false;
  return true;
}

export function parseWordList(s) {
  return String(s || '')
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 200);
}

// מיזוג מכמה מקורות: לסירוגין (גיוון), בלי כפילויות לפי id או כותרת+משך
export function mergeResults(lists) {
  const seen = new Set();
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const v = list[i];
      if (!v) continue;
      // אותו סרטון בשני מקורות: אותה כותרת ואותו משך. בלי משך ידוע — רק לפי מזהה
      // (אחרת "שיעור 1" של כמה ערוצים היה מתאחד לאחד)
      const k2 = v.duration ? v.title.toLowerCase().replace(/\s+/g, ' ').trim() + '|' + Math.round(v.duration / 10) : null;
      if (seen.has(v.id) || (k2 && seen.has(k2))) continue;
      seen.add(v.id);
      if (k2) seen.add(k2);
      out.push(v);
    }
  }
  return out;
}
