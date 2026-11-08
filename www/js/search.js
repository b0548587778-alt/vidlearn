// חיפוש מקביל בכל המקורות הפעילים. מקור שנכשל לא מפיל את החיפוש.
import { buildSearchUrl, parseResults, sourceReady, needsKeywordFilter, buildResolveUrl, resolveFile, buildYoutubeDetailsUrl, parseYoutubeDurations } from './sources.js';
import { safeUrl } from './util.js';
import { buildAudioSearchUrl, buildBookSearchUrl, buildScannedSearchUrl, parseArchiveItems, metadataUrl, pickBookText } from './media.js';
import { isAllowed, mergeResults } from './filter.js';

export const TIMEOUT_MS = 12000;

// זמן קצוב עם Promise.race: באפליקציה fetch עובר דרך CapacitorHttp (native),
// שעלול להתעלם מ-AbortSignal — בלי זה שרת שלא עונה היה תוקע את כל החיפוש
async function getJson(url, fetchImpl, timeoutMs = TIMEOUT_MS) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ctl?.abort(); reject(new Error('timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(url, { signal: ctl?.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`http-${res.status}`);
        return res.json();
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// cursors: { [sourceId]: cursor } — לעמוד הבא; מקור שסיים (null) מדולג
export async function searchAll(query, settings, { cursors = null, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const active = settings.sources.filter(sourceReady).filter((s) => !cursors || (s.id in cursors && cursors[s.id] !== null));
  const extraBlock = settings.extraBlock || [];
  const results = await Promise.allSettled(active.map(async (s) => {
    const cursor = cursors ? cursors[s.id] : 0;
    const url = buildSearchUrl(s, query, { cursor, langs: settings.contentLangs || [] });
    const json = await getJson(url, fetchImpl, timeoutMs);
    const { items, next } = parseResults(s, json, cursor);
    if (s.type === 'youtube' && items.length) {
      // משכים — לסינון לפי אורך ולתצוגה; כשל לא מפיל את התוצאות
      try {
        const durs = parseYoutubeDurations(await getJson(buildYoutubeDetailsUrl(s, items.map((v) => v.nativeId)), fetchImpl, timeoutMs));
        items.forEach((v) => { if (durs[v.nativeId]) v.duration = durs[v.nativeId]; });
      } catch { /* בלי משך */ }
    }
    const allowed = items.filter((v) => isAllowed(v, { extraBlock, keywordFilter: needsKeywordFilter(s), strict: settings.strict }));
    return { source: s, items: allowed, next, filtered: items.length - allowed.length };
  }));

  const lists = [];
  const nextCursors = {};
  const errors = [];
  let filtered = 0;
  results.forEach((r, i) => {
    const s = active[i];
    if (r.status === 'fulfilled') {
      lists.push(r.value.items);
      nextCursors[s.id] = r.value.next;
      filtered += r.value.filtered;
    } else {
      errors.push({ source: s, message: String(r.reason?.message || r.reason) });
      nextCursors[s.id] = null;
    }
  });
  const hasMore = Object.values(nextCursors).some((c) => c !== null);
  return { items: mergeResults(lists), cursors: nextCursors, hasMore, errors, filtered, searched: active.length };
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

// חיפוש ספרי שמע / ספרי קריאה (Internet Archive) ← { items, next, filtered }.
// ספרים: Gutenberg (טקסט נקי) קודם, ואחריו ספרים סרוקים — לסירוגין, מקור שנכשל לא מפיל
export async function searchMedia(kind, query, settings, { page = 0, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const opts = { page, langs: settings.contentLangs || [] };
  const urls = kind === 'audiobook'
    ? [buildAudioSearchUrl(query, opts)]
    : [buildBookSearchUrl(query, opts), ...(settings.bookScanned !== false ? [buildScannedSearchUrl(query, opts)] : [])];
  const results = await Promise.allSettled(urls.map(async (u) => parseArchiveItems(await getJson(u, fetchImpl, timeoutMs), kind, page)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw results[0].reason;
  const items = mergeResults(ok.map((r) => r.items));
  const extraBlock = settings.extraBlock || [];
  const allowed = items.filter((v) => isAllowed(v, { extraBlock, strict: settings.strict }));
  return { items: allowed, next: ok.some((r) => r.next !== null) ? page + 1 : null, filtered: items.length - allowed.length };
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
