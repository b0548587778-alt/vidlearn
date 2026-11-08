// חיפוש מקביל בכל המקורות הפעילים. מקור שנכשל לא מפיל את החיפוש.
import { buildSearchUrl, parseResults, sourceReady, needsKeywordFilter, buildResolveUrl, resolveFile, buildYoutubeDetailsUrl, parseYoutubeDurations } from './sources.js';
import { safeUrl } from './util.js';
import { buildAudioSearchUrl, buildBookSearchUrl, buildScannedSearchUrl, parseArchiveItems, metadataUrl, pickBookText } from './media.js';
import { buildPodcastSearchUrl, parsePodcastResults, parsePodcastFeed } from './podcasts.js';
import { buildWikiSummaryUrl, parseWikiSummary, buildWikiArticleUrl, parseWikiArticle, wikiLang } from './wiki.js';
import { isAllowed, mergeResults, blockedBy } from './filter.js';

export const TIMEOUT_MS = 12000;

// זמן קצוב עם Promise.race: באפליקציה fetch עובר דרך CapacitorHttp (native),
// שעלול להתעלם מ-AbortSignal — בלי זה שרת שלא עונה היה תוקע את כל החיפוש
async function getJson(url, fetchImpl, timeoutMs = TIMEOUT_MS, { text = false, headers = {} } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ctl?.abort(); reject(new Error('timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, { signal: ctl?.signal, headers: { Accept: text ? '*/*' : 'application/json', ...headers } });
        if (!res.ok) throw new Error(`http-${res.status}`);
        return text ? res.text() : res.json();
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// המשימות של חיפוש: כל מקור עם השאילתה המקורית, ובחיפוש בעברית — גם עם המונח באנגלית
// (מקור.id + '~alt'). יוטיוב לא מקבל את החיפוש הנוסף: הוא מוצא עברית לבד, וחבל על המכסה
export const ALT_SUFFIX = '~alt';
const altEligible = (s) => s.type !== 'youtube';

// cursors: { [taskId]: cursor } — לעמוד הבא; משימה שסיימה (null) מדולגת.
// alt: המונח באנגלית (מחרוזת או Promise שלה)
// altOnly: רק החיפוש הנוסף (הממשק מציג קודם את תוצאות העברית ומוסיף את האנגלית כשהן מגיעות)
export async function searchAll(query, settings, { cursors = null, alt = null, altOnly = false, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ready = settings.sources.filter(sourceReady);
  const tasks = [
    ...(altOnly ? [] : ready.map((s) => ({ id: s.id, source: s, alt: false }))),
    ...(alt ? ready.filter(altEligible).map((s) => ({ id: s.id + ALT_SUFFIX, source: s, alt: true })) : []),
  ].filter((t) => !cursors || (t.id in cursors && cursors[t.id] !== null));
  const extraBlock = settings.extraBlock || [];
  const altQuery = Promise.resolve(alt).catch(() => null);
  const results = await Promise.allSettled(tasks.map(async (t) => {
    const s = t.source;
    let q = query;
    if (t.alt) {
      q = await altQuery;
      if (!q || q.trim().toLowerCase() === String(query).trim().toLowerCase()) return { items: [], next: null, filtered: 0 };
    }
    const cursor = cursors && t.id in cursors ? cursors[t.id] : 0;
    const url = buildSearchUrl(s, q, { cursor, langs: settings.contentLangs || [] });
    const json = await getJson(url, fetchImpl, timeoutMs);
    const { items, next } = parseResults(s, json, cursor);
    if (s.type === 'youtube' && items.length) {
      // משכים — לסינון לפי אורך ולתצוגה; כשל לא מפיל את התוצאות
      try {
        const durs = parseYoutubeDurations(await getJson(buildYoutubeDetailsUrl(s, items.map((v) => v.nativeId)), fetchImpl, timeoutMs));
        items.forEach((v) => { if (durs[v.nativeId]) v.duration = durs[v.nativeId]; });
      } catch { /* בלי משך */ }
    }
    if (t.alt) items.forEach((v) => { v.altQuery = q; });
    const allowed = items.filter((v) => isAllowed(v, { extraBlock, keywordFilter: needsKeywordFilter(s), strict: settings.strict }));
    return { items: allowed, next, filtered: items.length - allowed.length };
  }));

  const primary = [];
  const secondary = [];
  const nextCursors = {};
  const errors = [];
  let filtered = 0;
  results.forEach((r, i) => {
    const t = tasks[i];
    if (r.status === 'fulfilled') {
      (t.alt ? secondary : primary).push(r.value.items);
      nextCursors[t.id] = r.value.next;
      filtered += r.value.filtered;
    } else {
      // שגיאה בחיפוש הנוסף לא מוצגת — המקור עצמו כבר דווח (או ענה) בחיפוש המקורי
      if (!t.alt) errors.push({ source: t.source, message: String(r.reason?.message || r.reason) });
      nextCursors[t.id] = null;
    }
  });
  const hasMore = Object.values(nextCursors).some((c) => c !== null);
  // התוצאות בשפת החיפוש קודם, אחריהן התוצאות מהמונח באנגלית (בלי כפילויות)
  const items = mergeResults([[...mergeResults(primary), ...mergeResults(secondary)]]);
  return { items, cursors: nextCursors, hasMore, errors, filtered, searched: ready.length, alt: await altQuery };
}

// הקובץ הישיר לסרטון ← { url, size }; כשל ← { url: '' } (נשארים עם הנגן המוטמע)
export async function resolveDirectFile(v, { fetchImpl = fetch, quality = 'normal' } = {}) {
  if (v.sourceType === 'audio') return { url: safeUrl(v.play?.url), size: Number(v.size) || 0 };
  if (v.sourceType === 'book') {
    try {
      const t = pickBookText(v, await getJson(metadataUrl(v), fetchImpl, 10000));
      return t ? { url: t.url, size: t.size } : { url: '', size: 0 };
    } catch {
      return { url: '', size: 0 };
    }
  }
  const url = buildResolveUrl(v);
  if (url) {
    try {
      const r = resolveFile(v, await getJson(url, fetchImpl, 8000), quality);
      if (r.url) return r;
    } catch { /* ממשיכים לגיבוי */ }
  }
  // Commons: אם ה-API לא ענה — הקובץ המקורי מהחיפוש
  if (v.sourceType === 'commons' && v.play?.kind === 'video') return { url: safeUrl(v.play.url), size: 0 };
  return { url: '', size: 0 };
}

// לנגן: רק הכתובת. Commons מתנגן ישר מהקובץ שבחיפוש, בלי פנייה נוספת
export async function resolveDirect(v, opts = {}) {
  if (v.sourceType === 'commons') return v.play?.kind === 'video' ? safeUrl(v.play.url) : '';
  return (await resolveDirectFile(v, opts)).url;
}

// חיפוש ספרי שמע / ספרי קריאה (Internet Archive) / פודקאסטים (Apple) ← { items, next, filtered }.
// ספרים: Gutenberg (טקסט נקי) קודם, ואחריו ספרים סרוקים — לסירוגין, מקור שנכשל לא מפיל.
// alt: המונח באנגלית — עוד חיפוש (ספרי השמע וספרי Gutenberg כמעט כולם באנגלית)
export async function searchMedia(kind, query, settings, { page = 0, alt = '', fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const extraBlock = settings.extraBlock || [];
  const filterAll = (items) => items.filter((v) => isAllowed(v, { extraBlock, strict: settings.strict }));
  if (kind === 'podcast') {
    const r = parsePodcastResults(await getJson(buildPodcastSearchUrl(query, { page, langs: settings.contentLangs || [] }), fetchImpl, timeoutMs), page);
    const allowed = filterAll(r.items);
    return { items: allowed, next: r.next, filtered: r.filtered + r.items.length - allowed.length };
  }
  const opts = { page, langs: settings.contentLangs || [] };
  const build = (q) => (kind === 'audiobook'
    ? [buildAudioSearchUrl(q, opts)]
    : [buildBookSearchUrl(q, opts), ...(settings.bookScanned !== false ? [buildScannedSearchUrl(q, opts)] : [])]);
  const altOk = alt && alt.trim().toLowerCase() !== String(query).trim().toLowerCase();
  const groups = [build(query), altOk ? build(alt) : []];
  const run = (urls) => Promise.allSettled(urls.map(async (u) => parseArchiveItems(await getJson(u, fetchImpl, timeoutMs), kind, page)));
  const [main, extra] = await Promise.all(groups.map(run));
  const ok = (rs) => rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok(main).length && !ok(extra).length) throw main[0].reason;
  const items = mergeResults([[...mergeResults(ok(main).map((r) => r.items)), ...mergeResults(ok(extra).map((r) => r.items))]]);
  const allowed = filterAll(items);
  const next = [...ok(main), ...ok(extra)].some((r) => r.next !== null) ? page + 1 : null;
  return { items: allowed, next, filtered: items.length - allowed.length };
}

// ---------- ויקיפדיה ----------
// Wikimedia מבקשים לזהות את האפליקציה (Api-User-Agent עובר גם בדפדפן)
const WIKI_HEADERS = { 'Api-User-Agent': 'VidLearn/0.1 (https://github.com/b0548587778-alt/vidlearn)' };

// ← ערך לנושא החיפוש, או null (אין / לא הולם / שגיאה — לא מפיל כלום)
export async function fetchWikiSummary(query, settings, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  try {
    const lang = wikiLang(query, settings.lang);
    const w = parseWikiSummary(await getJson(buildWikiSummaryUrl(query, lang), fetchImpl, timeoutMs, { headers: WIKI_HEADERS }), lang, query);
    if (!w) return null;
    if (blockedBy({ title: w.title, description: w.extract.slice(0, 1500) }, settings.extraBlock || [])) return null;
    return w;
  } catch {
    return null;
  }
}

export async function fetchWikiArticle(w, { fetchImpl = fetch } = {}) {
  return parseWikiArticle(await getJson(buildWikiArticleUrl(w.pageid, w.lang), fetchImpl, 15000, { headers: WIKI_HEADERS }));
}

// ---------- פודקאסטים ----------
export async function fetchPodcastEpisodes(podcast, { fetchImpl = fetch } = {}) {
  const url = safeUrl(podcast.play?.url);
  if (!url) throw new Error('no-feed');
  const xml = await getJson(url, fetchImpl, 15000, { text: true });
  if (xml.length > 15 * 1024 * 1024) throw new Error('too-big');
  return parsePodcastFeed(podcast, xml);
}

// מטא-דאטה של פריט בארכיון (פרקים / קובץ טקסט)
export function fetchArchiveMetadata(item, { fetchImpl = fetch } = {}) {
  return getJson(metadataUrl(item), fetchImpl, 12000);
}

// טקסט הספר (מהרשת או מקובץ שמור). תקרה של 8MB — ספר גדול מזה לא נטען לזיכרון
export async function fetchText(url, { fetchImpl = fetch, maxBytes = 8 * 1024 * 1024 } = {}) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`http-${res.status}`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error('too-big');
  return text;
}
