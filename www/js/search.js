// חיפוש מקביל בכל המקורות הפעילים. מקור שנכשל לא מפיל את החיפוש.
import { buildSearchUrl, parseResults, sourceReady, needsKeywordFilter, buildResolveUrl, parseResolve } from './sources.js';
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

// ניסיון לקבל קובץ וידאו ישיר; כשל ← '' (נשארים עם הנגן המוטמע)
export async function resolveDirect(v, { fetchImpl = fetch, quality = 'normal' } = {}) {
  if (v.sourceType === 'commons') return v.play?.kind === 'video' ? v.play.url : '';
  const url = buildResolveUrl(v);
  if (!url) return '';
  try {
    return parseResolve(v, await getJson(url, fetchImpl, 8000), quality);
  } catch {
    return '';
  }
}
