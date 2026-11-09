// חיפוש מקביל בכל המקורות הפעילים. מקור שנכשל לא מפיל את החיפוש.
import { buildSearchUrl, parseResults, sourceReady, needsKeywordFilter, buildResolveUrl, resolveFile, buildYoutubeDetailsUrl, parseYoutubeDurations, PEERTUBE_EDUCATION } from './sources.js';
import { safeUrl, stripHtml, parseDuration, hostOf } from './util.js';
import { DEFAULT_YT_INSTANCES, parseInstances, parseLink, buildYtInfoUrl, parseYtInfo, vimeoInfoUrl, vimeoConfigUrl, parseVimeoInfo, parseVimeoConfig, commonsTitleUrl, titleFromUrl } from './links.js';
import { buildAudioSearchUrl, buildBookSearchUrl, buildScannedSearchUrl, parseArchiveItems, metadataUrl, pickBookText } from './media.js';
import { buildPodcastSearchUrl, parsePodcastResults, parsePodcastFeed } from './podcasts.js';
import { buildWikiSummaryUrl, parseWikiSummary, buildWikiArticleUrl, parseWikiArticle, wikiLang } from './wiki.js';
import { isAllowed, mergeResults, blockedBy, queryBlocked, blockedHost, flaggedBySource, looksEducational } from './filter.js';

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
// youtubeAuth: ({ refresh }) => טוקן גישה של Google (כשמחוברים) — יוטיוב בלי מפתח API.
// 401 (טוקן שפג) ← טוקן חדש וניסיון אחד נוסף
export async function searchAll(query, settings, { cursors = null, alt = null, altOnly = false, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, youtubeAuth = null } = {}) {
  // מילת חיפוש אסורה — לא שולחים את החיפוש לאף מקור
  if (queryBlocked(query, settings.extraBlock || [])) return { items: [], cursors: {}, hasMore: false, errors: [], filtered: 0, searched: 0, alt: null, blocked: true };
  const ready = settings.sources.filter((s) => sourceReady(s, { google: !!youtubeAuth }));
  // יוטיוב בלי מפתח ← עם הכניסה ל-Google
  const ytGet = async (s, url) => {
    if (String(s.key || '').trim() || !youtubeAuth) return getJson(url, fetchImpl, timeoutMs);
    const call = async (refresh) => getJson(url, fetchImpl, timeoutMs, { headers: { Authorization: `Bearer ${await youtubeAuth({ refresh })}` } });
    try {
      return await call(false);
    } catch (e) {
      if (e?.message !== 'http-401') throw e;
      return call(true);
    }
  };
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
      if (!q || queryBlocked(q, extraBlock) || q.trim().toLowerCase() === String(query).trim().toLowerCase()) return { items: [], next: null, filtered: 0 };
    }
    const cursor = cursors && t.id in cursors ? cursors[t.id] : 0;
    const url = buildSearchUrl(s, q, { cursor, langs: settings.contentLangs || [] });
    const json = s.type === 'youtube' ? await ytGet(s, url) : await getJson(url, fetchImpl, timeoutMs);
    const { items, next } = parseResults(s, json, cursor);
    if (s.type === 'youtube' && items.length) {
      // משכים — לסינון לפי אורך ולתצוגה; כשל לא מפיל את התוצאות
      try {
        const durs = parseYoutubeDurations(await ytGet(s, buildYoutubeDetailsUrl(s, items.map((v) => v.nativeId))));
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
// settings: לשרתי יוטיוב ולסינון (קובץ שנפסל ← שגיאה 'blocked')
// nativeYoutube: { info(id) } — יוטיוב ישירות מהטלפון (התוסף vidlearn-native), לפני השרתים
export async function resolveDirectFile(v, { fetchImpl = fetch, quality = 'normal', settings = {}, nativeYoutube = null } = {}) {
  if (v.sourceType === 'youtube' || v.sourceType === 'invidious') {
    const r = await fetchYoutube(v.nativeId, settings, { fetchImpl, quality, nativeYoutube });
    return { url: r.url, size: r.size, ext: r.ext };
  }
  if (v.sourceType === 'vimeo') {
    try { return parseVimeoConfig(await getJson(vimeoConfigUrl(v.nativeId), fetchImpl, 10000), quality); } catch { return { url: '', size: 0 }; }
  }
  if (v.sourceType === 'direct') return { url: safeUrl(v.play?.url), size: 0 };
  quality = quality === 'audio' ? 'normal' : quality; // שמע בלבד — רק ביוטיוב
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

// ---------- יוטיוב דרך Invidious / Piped ----------
export function ytInstances(settings = {}) {
  const list = parseInstances(settings.ytInstances || []);
  return list.length ? list : DEFAULT_YT_INSTANCES;
}

// סרטון מיוטיוב (שם, תיאור, תגיות, קטגוריה) עובר את אותו סינון; קטגוריות בידור נפסלות
const YT_BLOCKED_CATEGORIES = ['Gaming', 'Comedy'];
export function youtubeAllowed(meta, settings = {}) {
  if (!meta || !meta.title) return false;
  if (flaggedBySource(meta) || blockedBy(meta, settings.extraBlock || [])) return false;
  if (YT_BLOCKED_CATEGORIES.includes(meta.category)) return false;
  if (settings.strict && meta.category !== 'Education' && !looksEducational(meta)) return false;
  return true;
}

// כתובת פנימית להורדה דרך התוסף: הטלפון עצמו מוריד ומחבר תמונה וקול (fsAdapter ב-app.js)
export const NATIVE_YT_SCHEME = 'vidlearn-yt:';
export function nativeYtUrl(id, quality) {
  return `${NATIVE_YT_SCHEME}${id}?q=${['low', 'audio'].includes(quality) ? quality : 'normal'}`;
}

// פרטי הסרטון מהתוסף ← אותה צורה כמו מהשרתים
export function nativeYtMeta(r) {
  if (!r || !r.title) return null;
  return {
    title: String(r.title),
    description: stripHtml(r.description),
    author: String(r.author || ''),
    duration: parseDuration(r.duration),
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    category: String(r.category || ''),
    familyFriendly: Number(r.ageLimit) > 0 ? false : undefined, // מוגבל גיל ← לא מתאים
  };
}

// קודם מהטלפון עצמו (nativeYoutube), ואם לא — השרתים לפי הסדר ← { meta, url, size, ext }.
// סרטון לא הולם ← שגיאה 'blocked'
export async function fetchYoutube(id, settings = {}, { fetchImpl = fetch, quality = 'normal', timeoutMs = 15000, nativeYoutube = null } = {}) {
  if (nativeYoutube) {
    let meta = null;
    try { meta = nativeYtMeta(await nativeYoutube.info(id)); } catch { /* ננסה את השרתים */ }
    if (meta) {
      if (!youtubeAllowed(meta, settings)) throw new Error('blocked');
      return { meta, url: nativeYtUrl(id, quality), size: 0, ext: quality === 'audio' ? 'm4a' : 'mp4' };
    }
  }
  let lastErr = new Error('yt-unavailable');
  for (const base of ytInstances(settings)) {
    try {
      const r = parseYtInfo(base, await getJson(buildYtInfoUrl(base, id), fetchImpl, timeoutMs), quality);
      if (!r.meta) throw new Error('bad-answer');
      if (!youtubeAllowed(r.meta, settings)) throw Object.assign(new Error('blocked'), { final: true });
      if (r.url) return r;
      lastErr = Object.assign(new Error('no-file'), { meta: r.meta });
    } catch (e) {
      if (e.final) throw e;
      lastErr = e;
    }
  }
  throw lastErr.message === 'no-file' ? lastErr : new Error('yt-unavailable');
}

// ---------- הורדה מקישור ----------
const LINK_SOURCE = { sourceId: 'link' };
function linkItem(fields) {
  return { id: '', ...LINK_SOURCE, sourceType: '', sourceName: '', title: '', description: '', author: '', duration: 0, thumb: '', tags: [], lang: '', pageUrl: '', play: { kind: 'iframe', url: '' }, ...fields };
}

// קישור שהמשתמש הדביק ← פריט מוכן לצפייה / להורדה, אחרי סינון.
// שגיאות: 'bad-link' (לא מזוהה), 'blocked' (לא הולם), 'yt-unavailable', 'http-…'
export async function fetchLinkItem(input, settings = {}, { fetchImpl = fetch, nativeYoutube = null } = {}) {
  const link = parseLink(input);
  if (!link) throw new Error('bad-link');
  if ((link.url && blockedHost(link.url)) || (link.host && blockedHost(`https://${link.host}`))) throw new Error('blocked');
  const extraBlock = settings.extraBlock || [];
  const ok = (item, opts = {}) => {
    if (!isAllowed(item, { extraBlock, strict: !!settings.strict, ...opts })) throw new Error('blocked');
    return item;
  };
  switch (link.type) {
    case 'youtube': {
      const { meta } = await fetchYoutube(link.id, settings, { fetchImpl, quality: 'normal', nativeYoutube }).catch((e) => {
        if (e.message === 'no-file') return { meta: e.meta }; // עבר סינון, רק אין קובץ כרגע — ננסה שוב בהורדה
        throw e;
      });
      return linkItem({
        id: `youtube:${link.id}`, sourceType: 'youtube', sourceName: 'YouTube', nativeId: link.id,
        title: meta.title || link.id, description: meta.description || '', author: meta.author || '', duration: meta.duration || 0, tags: meta.tags || [],
        thumb: `https://i.ytimg.com/vi/${link.id}/mqdefault.jpg`,
        play: { kind: 'iframe', url: `https://www.youtube-nocookie.com/embed/${link.id}?rel=0&modestbranding=1&playsinline=1` },
        pageUrl: `https://www.youtube.com/watch?v=${link.id}`,
      });
    }
    case 'vimeo': {
      const info = parseVimeoInfo(await getJson(vimeoInfoUrl(link.id), fetchImpl, 10000));
      if (!info) throw new Error('not-found');
      return ok(linkItem({ ...info, id: `vimeo:${link.id}`, sourceType: 'vimeo', sourceName: 'Vimeo', nativeId: link.id,
        play: { kind: 'iframe', url: `https://player.vimeo.com/video/${link.id}` }, pageUrl: `https://vimeo.com/${link.id}` }));
    }
    case 'peertube': {
      const json = await getJson(`https://${link.host}/api/v1/videos/${encodeURIComponent(link.id)}`, fetchImpl, 10000);
      if (!json || json.nsfw) throw new Error('blocked');
      const src = { id: 'link', type: 'peertube', name: link.host, url: `https://${link.host}` };
      const item = parseResults(src, { data: [{ ...json, category: null }], total: 1 }).items[0];
      if (!item) throw new Error('not-found');
      // לא בקטגוריית חינוך — צריך מילת לימוד, כמו במקור בלי סינון
      return ok({ ...item, ...LINK_SOURCE }, { keywordFilter: json.category?.id !== PEERTUBE_EDUCATION });
    }
    case 'archive': {
      const json = await getJson(`https://archive.org/metadata/${encodeURIComponent(link.id)}`, fetchImpl, 12000);
      const m = json?.metadata;
      if (!m) throw new Error('not-found');
      const first = (x) => (Array.isArray(x) ? x[0] : x);
      const id = encodeURIComponent(link.id);
      return ok(linkItem({
        id: `archive:${link.id}`, sourceType: 'archive', sourceName: 'Internet Archive', nativeId: link.id,
        title: String(first(m.title) || link.id), description: stripHtml([].concat(m.description || []).join(' ')), author: String(first(m.creator) || ''),
        duration: parseDuration(first(m.runtime)), tags: [].concat(m.subject || []).map(String),
        thumb: `https://archive.org/services/img/${id}`, play: { kind: 'iframe', url: `https://archive.org/embed/${id}` },
        resolvable: true, pageUrl: `https://archive.org/details/${id}`,
      }));
    }
    case 'commons': {
      const src = { id: 'link', type: 'commons', name: 'Wikimedia Commons' };
      const item = parseResults(src, await getJson(commonsTitleUrl(link.title), fetchImpl, 10000)).items[0];
      if (!item) throw new Error('not-found');
      return ok({ ...item, ...LINK_SOURCE });
    }
    case 'direct': {
      // קובץ ישיר: אי אפשר לבדוק את התוכן עצמו — רק את שם הקובץ ואת האתר
      const title = titleFromUrl(link.url) || hostOf(link.url);
      return ok(linkItem({ id: `direct:${link.url.slice(0, 300)}`, sourceType: 'direct', sourceName: hostOf(link.url), title,
        play: { kind: 'video', url: link.url }, pageUrl: link.url }));
    }
    default:
      throw new Error('bad-link');
  }
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
  if (queryBlocked(query, extraBlock)) return { items: [], next: null, filtered: 0, blocked: true };
  if (alt && queryBlocked(alt, extraBlock)) alt = '';
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
    if (queryBlocked(query, settings.extraBlock || [])) return null;
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
