// פודקאסטים לימודיים: חיפוש בספריית הפודקאסטים של Apple (iTunes Search API — חינמי, בלי מפתח),
// והפרקים עצמם מה-RSS של הפודקאסט. טהור — בלי fetch ובלי DOM, נבדק ב-tests/podcasts.test.mjs.
import { stripHtml, parseDuration, safeUrl } from './util.js';
import { PAGE_SIZE } from './sources.js';

// קטגוריות לימודיות של Apple (מזהי הקטגוריה הראשית; תת-קטגוריה מגיעה תמיד עם הראשית שלה)
export const PODCAST_EDU_GENRES = {
  1304: 'Education', 1533: 'Science', 1487: 'History', 1318: 'Technology',
  1314: 'Religion & Spirituality', 1305: 'Kids & Family', 1324: 'Society & Culture',
  1321: 'Business', 1512: 'Health & Fitness',
};
// קטגוריות שפוסלות גם אם יש קטגוריה לימודית (בידור, פשע אמיתי, מוזיקה…)
export const PODCAST_BLOCK_GENRES = {
  1303: 'Comedy', 1488: 'True Crime', 1483: 'Fiction', 1309: 'TV & Film', 1310: 'Music',
  1545: 'Sports', 1502: 'Leisure',
};

export const MAX_EPISODES = 300;
const MAX_FETCH = 200; // תקרת התוצאות של iTunes Search

const HEBREW = /[֐-׿]/;

// החנות לפי שפת החיפוש: עברית ← ישראל (שם הפודקאסטים בעברית), אחרת לפי שפת התוכן המועדפת
function country(query, langs = []) {
  if (HEBREW.test(query) || langs[0] === 'he') return 'il';
  return { fr: 'fr', de: 'de', es: 'es', ru: 'ru', ar: 'eg' }[langs[0]] || 'us';
}

// iTunes לא תומך בדפדוף — מבקשים את כל העמודים עד העמוד הנוכחי וחותכים
export function buildPodcastSearchUrl(query, { page = 0, langs = [] } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  if (!q) throw new Error('empty-query');
  const sp = new URLSearchParams({
    media: 'podcast',
    entity: 'podcast',
    term: q,
    country: country(q, langs),
    limit: String(Math.min(MAX_FETCH, (page + 1) * PAGE_SIZE * 2)), // כפול — חלק יסוננו
    explicit: 'No',
  });
  return `https://itunes.apple.com/search?${sp}`;
}

export function isEducationalPodcast(r) {
  const ids = (Array.isArray(r?.genreIds) ? r.genreIds : []).map(Number);
  if (r?.collectionExplicitness === 'explicit') return false;
  if (ids.some((id) => PODCAST_BLOCK_GENRES[id])) return false;
  return ids.some((id) => PODCAST_EDU_GENRES[id]);
}

// ← { items, next, filtered }
export function parsePodcastResults(json, page = 0) {
  const all = Array.isArray(json?.results) ? json.results : [];
  const items = [];
  let filtered = 0;
  for (const r of all) {
    const feed = safeUrl(r?.feedUrl);
    if (!r || r.kind !== 'podcast' || !feed || !r.collectionId) continue;
    if (!isEducationalPodcast(r)) { filtered++; continue; }
    items.push({
      id: `podcast:${r.collectionId}`,
      kind: 'podcast',
      nativeId: String(r.collectionId),
      sourceType: 'podcast',
      sourceId: 'podcasts',
      sourceName: String(r.primaryGenreName || 'Podcast'),
      title: String(r.collectionName || r.trackName || ''),
      description: '',
      author: String(r.artistName || ''),
      duration: 0,
      thumb: safeUrl(r.artworkUrl600) || safeUrl(r.artworkUrl100),
      play: { kind: 'iframe', url: feed }, // הפיד — הפרקים נטענים במסך ההאזנה
      pageUrl: safeUrl(r.collectionViewUrl),
      lang: '',
      tags: Array.isArray(r.genres) ? r.genres.map(String).filter((g) => g !== 'Podcasts') : [],
      count: Number(r.trackCount) || 0,
    });
  }
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  // יש עוד: עוד פריטים מעבר לעמוד, או ש-iTunes החזיר את המקסימום ואולי יש עוד
  const requested = Math.min(MAX_FETCH, (page + 1) * PAGE_SIZE * 2);
  const next = items.length > start + PAGE_SIZE || (all.length >= requested && requested < MAX_FETCH) ? page + 1 : null;
  return { items: slice, next, filtered };
}

// ---------- RSS ----------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function safeChar(n) {
  try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; }
}

// תוכן תגית ראשונה בשם הזה (עם או בלי מאפיינים / רווחים), כולל CDATA
function tag(xml, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = xml.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}\\s*>`, 'i'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(m[1]);
}
function attr(xml, name, attrName) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = xml.match(new RegExp(`<${esc}\\s[^>]*>`, 'i'));
  if (!m) return '';
  const a = m[0].match(new RegExp(`\\s${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return a ? decodeEntities(a[1] ?? a[2]) : '';
}

// פרקי הפודקאסט מתוך ה-RSS — כמו פרקי ספר שמע (התקדמות, הערות ושמירה לכל פרק).
// סדר: כמו בפיד (בדרך כלל החדש ביותר קודם); itunes:type=serial ← מהראשון
export function parsePodcastFeed(podcast, xml) {
  const text = String(xml || '');
  const channel = text.split(/<item[\s>]/i)[0];
  const serial = /serial/i.test(tag(channel, 'itunes:type'));
  const info = {
    description: stripHtml(tag(channel, 'description') || tag(channel, 'itunes:summary')).slice(0, 1500),
    thumb: safeUrl(attr(channel, 'itunes:image', 'href')),
  };
  const raw = text.split(/<item[\s>]/i).slice(1).map((chunk) => chunk.split(/<\/item\s*>/i)[0]);
  let episodes = [];
  for (const it of raw) {
    const url = safeUrl(attr(it, 'enclosure', 'url'));
    const type = attr(it, 'enclosure', 'type');
    if (!url || (type && !/^audio\//i.test(type) && !/\.(mp3|m4a|aac|ogg|opus)(\?|$)/i.test(url))) continue;
    const date = Date.parse(tag(it, 'pubDate')) || 0;
    episodes.push({
      title: stripHtml(tag(it, 'title')) || url.split('/').pop(),
      description: stripHtml(tag(it, 'description') || tag(it, 'itunes:summary')).slice(0, 600),
      duration: parseDuration(tag(it, 'itunes:duration')),
      size: Number(attr(it, 'enclosure', 'length')) || 0,
      url,
      date,
      guid: stripHtml(tag(it, 'guid')).slice(0, 200) || url,
    });
    if (episodes.length >= MAX_EPISODES) break;
  }
  if (serial) episodes.sort((a, b) => a.date - b.date);
  episodes = episodes.map((e, i) => ({
    ...e,
    // לפי מזהה הפרק בפיד (guid) — פרק חדש לא מזיז את ההתקדמות של הישנים, וגם לא החלפת כתובת הקובץ
    id: `${podcast.id}#${e.guid}`,
    kind: 'chapter',
    index: i,
    sourceType: 'audio',
    sourceName: podcast.sourceName,
    bookId: podcast.id,
    track: i + 1,
    play: { kind: 'audio', url: e.url },
  }));
  return { episodes, ...info };
}
