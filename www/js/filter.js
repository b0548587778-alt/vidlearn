// סינון: רק סרטוני למידה, בלי תוכן לא הולם. טהור.
//
// שכבות:
// 1. נרמול הטקסט לפני הבדיקה — אותיות מסוגננות (𝐬𝐞𝐱, ｓｅｘ), ניקוד, תווים נסתרים, "s.e.x" / "ס.ק.ס",
//    ספרות במקום אותיות (p0rn, s3x) — כך שטריקים נפוצים לא עוקפים את הרשימה.
// 2. רשימת מילים אסורות (אנגלית + עברית) ואימוג'י, + מילים של המשתמש.
// 3. סימונים של המקור עצמו: nsfw, explicit, "לא מתאים למשפחה".
// 4. במקורות בלי קטגוריית חינוך / במצב מחמיר — נדרשת מילת לימוד.
// 5. גם מילות החיפוש עצמן נבדקות (queryBlocked) — חיפוש אסור לא נשלח בכלל.

// מילים שפוסלות סרטון (כותרת, תיאור, תגיות, ערוץ). המשתמש יכול להוסיף מילים בהגדרות.
export const BLOCKLIST = [
  // תוכן מיני / לא צנוע
  'porn', 'porno', 'pornography', 'pornographic', 'pornhub', 'xvideos', 'xnxx', 'xhamster', 'redtube', 'brazzers',
  'xxx', 'nsfw', 'nsfl', '18+', 'adults only', 'adult content', 'adult video',
  'nude', 'nudes', 'nudity', 'naked', 'topless', 'erotic', 'erotica', 'sexy', 'sex', 'sexual', 'sexuality', 'sexting',
  'seduce', 'seduction', 'seductive', 'onlyfans', 'fansly', 'playboy', 'hentai', 'fetish', 'bdsm', 'kinky', 'milf',
  'bikini', 'bikinis', 'lingerie', 'underwear', 'swimsuit', 'swimwear', 'thong', 'cleavage', 'boobs', 'booty',
  'strip club', 'stripper', 'striptease', 'lap dance', 'pole dance', 'twerk', 'twerking',
  'dating', 'hookup', 'tinder', 'escort', 'camgirl', 'cam girl', 'webcam girl', 'hot girl', 'hot girls',
  'kissing', 'make out', 'love story', 'girlfriend', 'boyfriend',
  // הימורים
  'casino', 'gambling', 'betting', 'poker', 'slot machine',
  // אלימות / אימה / אוקולטיזם
  'gore', 'beheading', 'torture', 'execution video', 'suicide', 'self harm',
  'horror', 'scary', 'creepy', 'jumpscare', 'satan', 'satanic', 'occult', 'witchcraft', 'ouija',
  // סמים
  'weed', 'marijuana', 'cannabis', 'cocaine', 'heroin',
  // בידור שאינו לימוד
  'prank', 'music video', 'official video', 'official audio', 'lyric video', 'lyrics', 'trailer', 'movie trailer',
  'gameplay', 'let\'s play', 'walkthrough', 'asmr', 'tiktok', 'remix', 'dj set', 'nightclub', 'clubbing', 'concert',
  'celebrity', 'gossip', 'reality show',
  // גסויות
  'fuck', 'fucking', 'shit', 'bitch', 'wtf',
  // מיסיון
  'jesus', 'christ', 'new testament', 'gospel', 'missionary', 'messianic', 'evangelical', 'yeshua',
  // עברית
  // (בכוונה בלי מילים שמופיעות בשיעורי תורה: "מיני מזונות", "סמי הקטורת", "מנשיקות פיהו", "באימה וביראה",
  //  "רכילות", "מסיבה זו", "קליפה" — אחרת שיעורים כשרים היו נחסמים)
  'פורנו', 'פורנוגרפיה', 'סקס', 'סקסי', 'סקסית', 'מינית', 'מיניות', 'עירום', 'עירומה', 'עירומים',
  'ארוטי', 'ארוטית', 'חושפנית', 'חשפנות', 'חשופה', 'זנות', 'ביקיני', 'הלבשה תחתונה', 'בגד ים', 'בגדי ים',
  'מתנשקים', 'רומנטי', 'רומנטית', 'דייט', 'דייטים', 'הכרויות',
  'הימורים', 'קזינו', 'פוקר', 'קנאביס', 'גראס',
  'קליפ', 'טיקטוק', 'ריאליטי', 'דיסקו', 'הופעה חיה',
  'ישו', 'הברית החדשה', 'מיסיון', 'מיסיונר', 'משיחיים',
];

// אימוג'י שמסמנים תוכן לא הולם — נבדקים כתווים, בלי גבולות מילה
export const BLOCKED_EMOJI = ['🔞', '🍑', '🍆', '💋', '👙', '👅', '💦', '🥵', '😈', '🍌'];

// כתובות של אתרי תוכן למבוגרים / הימורים — לא מורידים מהם (חלק משם המארח)
export const BLOCKED_HOST_PARTS = [
  'porn', 'xxx', 'xvideos', 'xnxx', 'xhamster', 'redtube', 'youporn', 'brazzers', 'onlyfans', 'fansly', 'hentai',
  'nude', 'naked', 'sex', 'escort', 'camgirl', 'chaturbate', 'stripchat', 'casino', 'bet365', 'poker', 'tiktok',
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

// ---------- נרמול ----------
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿]/g;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

// אותיות בודדות מופרדות בנקודה / רווח / מקף / כוכבית ("s.e.x", "p o r n", "ס-ק-ס") ← מילה אחת
function collapseSpaced(text) {
  return text.replace(/(?:^|(?<=[^a-z0-9א-ת]))(?:[a-z0-9@$א-ת][\s.\-_*•·|/\\]+){2,}[a-z0-9@$א-ת](?=[^a-z0-9א-ת]|$)/g,
    (m) => m.replace(/[\s.\-_*•·|/\\]+/g, ''));
}

// טקסט ← גרסאות מנורמלות לבדיקה: [רגילה, אחרי איחוד אותיות מופרדות + ספרות כאותיות]
export function normalizeText(s) {
  const base = String(s || '')
    .normalize('NFKC') // 𝐬𝐞𝐱 / ｓｅｘ ← sex
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // סימנים מעל אותיות לטיניות (séx)
    .replace(/[֑-ֽֿ-ׇ]/g, '') // ניקוד וטעמים
    .replace(/־/g, ' ') // מקף עברי
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .toLowerCase();
  // ספרות במקום אותיות — רק בתוך מילה שיש בה אותיות (כדי ש-"18+" ו-"1999" יישארו)
  const leet = collapseSpaced(base).replace(/[a-z0-9@$!]*[a-z][a-z0-9@$!]*/g,
    (w) => w.replace(/[013457@$!]/g, (c) => LEET[c] || c));
  return leet === base ? [base] : [base, leet];
}

function haystack(v) {
  return [v.title, v.description, v.author, ...(v.tags || [])].join(' \u0001 ');
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

// מילים מצונזרות בכוכבית / בנקודות: p*rn, s*x, f**k, p.rn
const CENSORED = [/(^|[^a-z])p[*.#]+r?n/, /(^|[^a-z])s[*.#]+x([^a-z]|$)/, /(^|[^a-z])f[*.#]+c?k/, /(^|[^a-z])n[*.#]+de/];

// ← המילה שפסלה (לתצוגה / בדיקות), או null
export function blockedText(text, extraWords = []) {
  const raw = String(text || '');
  if (!raw) return null;
  const emoji = BLOCKED_EMOJI.find((e) => raw.includes(e));
  if (emoji) return emoji;
  const words = [...BLOCKLIST, ...extraWords];
  for (const t of normalizeText(raw)) {
    const w = words.find((x) => hasWord(t, x, { whole: true }));
    if (w) return w;
    if (CENSORED.some((re) => re.test(t))) return '*';
  }
  return null;
}

export function blockedBy(v, extraWords = []) {
  if (!v) return null;
  return blockedText(haystack(v), extraWords);
}

// מילות חיפוש אסורות — החיפוש לא נשלח בכלל
export function queryBlocked(q, extraWords = []) {
  return blockedText(q, extraWords);
}

// מארח של אתר למבוגרים / הימורים
export function blockedHost(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return BLOCKED_HOST_PARTS.some((p) => host.includes(p));
}

export function looksEducational(v) {
  const texts = normalizeText(haystack(v));
  return EDU_MARKERS.some((w) => texts.some((t) => hasWord(t, w)));
}

// המקור עצמו סימן את הפריט כלא הולם
export function flaggedBySource(v) {
  return !!v && (v.nsfw === true || v.explicit === true || v.familyFriendly === false);
}

// keywordFilter: המקור אינו מסונן לפי קטגוריה בשרת
export function isAllowed(v, { extraBlock = [], keywordFilter = false, strict = false } = {}) {
  if (!v || !v.title) return false;
  if (flaggedBySource(v)) return false;
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
