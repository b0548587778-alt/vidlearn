// חיפוש מקביל בכל המקורות הפעילים. מקור שנכשל לא מפיל את החיפוש.
import { buildSearchUrl, parseResults, sourceReady, needsKeywordFilter, buildResolveUrl, resolveFile } from './sources.js';
import { safeUrl } from './util.js';
import { isAllowed, mergeResults } from './filter.js';

export const TIMEOUT_MS = 12000;

async function getJson(url, fetchImpl, timeoutMs = TIMEOUT_MS) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { signal: ctl?.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`http-${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// cursors: { [sourceId]: cursor } — לעמוד הבא; מקור שסיים (null) מדולג
export async function searchAll(query, settings, { cursors = null, fetchImpl = fetch } = {}) {
  const active = settings.sources.filter(sourceReady).filter((s) => !cursors || (s.id in cursors && cursors[s.id] !== null));
  const extraBlock = settings.extraBlock || [];
  const results = await Promise.allSettled(active.map(async (s) => {
    const cursor = cursors ? cursors[s.id] : 0;
    const url = buildSearchUrl(s, query, { cursor, langs: settings.contentLangs || [] });
    const json = await getJson(url, fetchImpl);
    const { items, next } = parseResults(s, json, cursor);
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
