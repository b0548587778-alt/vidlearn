// מקורות הסרטונים: כל סוג יודע לבנות כתובת חיפוש ולפרק את התשובה
// לצורה אחידה. טהור — בלי fetch, נבדק ב-tests/sources.test.mjs.
import { safeUrl, isHebrew, hostOf, normalizeBase, stripHtml, parseDuration, parseIsoDuration } from './util.js';

export const PAGE_SIZE = 12;

// קטגוריית "חינוך" בכל שרת PeerTube
export const PEERTUBE_EDUCATION = 13;
// קטגוריית "Education" ביוטיוב
export const YOUTUBE_EDUCATION = 27;

export const SOURCE_TYPES = {
  peertube: {
    label: { he: 'PeerTube (שרת או חיפוש מאוחד)', en: 'PeerTube (instance or federated search)' },
    needsUrl: true,
    eduFilter: 'category', // הסינון לפי קטגוריית חינוך בשרת עצמו
  },
  archive: {
    label: { he: 'ארכיון האינטרנט (archive.org)', en: 'Internet Archive' },
    needsUrl: false,
    eduFilter: 'subject',
  },
  commons: {
    label: { he: 'ויקישיתוף (Wikimedia Commons)', en: 'Wikimedia Commons' },
    needsUrl: false,
    eduFilter: 'keywords',
  },
  youtube: {
    label: { he: 'יוטיוב (כניסה עם Google או מפתח API)', en: 'YouTube (Google sign-in or API key)' },
    needsKey: true,
    eduFilter: 'category',
  },
  invidious: {
    label: { he: 'Invidious (שרת חלופי ליוטיוב)', en: 'Invidious (YouTube front-end)' },
    needsUrl: true,
    eduFilter: 'keywords',
  },
};

export const DEFAULT_SOURCES = [
  { id: 'sepia', type: 'peertube', name: 'PeerTube — Sepia Search', url: 'https://sepiasearch.org', enabled: true, builtin: true },
  { id: 'archive', type: 'archive', name: 'Internet Archive', url: 'https://archive.org', enabled: true, builtin: true },
  { id: 'commons', type: 'commons', name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org', enabled: true, builtin: true },
  { id: 'youtube', type: 'youtube', name: 'YouTube', url: 'https://www.googleapis.com', key: '', enabled: false, builtin: true },
];

// מקורות שאין להם סינון חינוך בשרת — דורשים מילת לימוד בכותרת/בתיאור
export function needsKeywordFilter(source) {
  return SOURCE_TYPES[source.type]?.eduFilter === 'keywords';
}

// ctx.google: מחוברים עם חשבון Google — יוטיוב עובד עם הכניסה, בלי מפתח API
export function sourceReady(source, ctx = {}) {
  if (!source.enabled || !SOURCE_TYPES[source.type]) return false;
  if (SOURCE_TYPES[source.type].needsKey && !String(source.key || '').trim() && !(source.type === 'youtube' && ctx?.google)) return false;
  return true;
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

// cursor: מספר עמוד (0..) או pageToken של יוטיוב
export function buildSearchUrl(source, query, { cursor = 0, langs = [], pageSize = PAGE_SIZE } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty-query');
  const page = typeof cursor === 'number' ? cursor : 0;
  switch (source.type) {
    case 'peertube': {
      const base = normalizeBase(source.url);
      return `${base}/api/v1/search/videos?` + qs({
        search: q,
        categoryOneOf: PEERTUBE_EDUCATION,
        nsfw: 'false',
        count: pageSize,
        start: page * pageSize,
        languageOneOf: langs.length ? langs : undefined,
      });
    }
    case 'archive': {
      const safeQ = q.replace(/[():"\\[\]{}^~*?!+\-&|/]/g, ' ').trim() || 'lesson';
      const edu = '(subject:(education OR educational OR lecture OR lectures OR course OR tutorial OR lesson OR lessons OR "online course") OR collection:(educationalfilms OR academic_lectures OR mitocw OR opencourseware))';
      return 'https://archive.org/advancedsearch.php?' + qs({
        q: `(title:(${safeQ}) OR subject:(${safeQ}) OR description:(${safeQ})) AND mediatype:movies AND ${edu}`,
        'fl[]': ['identifier', 'title', 'description', 'creator', 'runtime', 'year', 'subject', 'language'],
        rows: pageSize,
        page: page + 1,
        output: 'json',
      });
    }
    case 'commons': {
      return 'https://commons.wikimedia.org/w/api.php?' + qs({
        action: 'query',
        generator: 'search',
        gsrsearch: `${q} filetype:video`,
        gsrnamespace: 6,
        gsrlimit: pageSize,
        gsroffset: page * pageSize,
        prop: 'imageinfo',
        iiprop: 'url|mediatype|extmetadata|size',
        iiurlwidth: 320,
        iiextmetadatafilter: 'ImageDescription|Artist|ObjectName',
        format: 'json',
        origin: '*',
      });
    }
    case 'youtube': {
      return 'https://www.googleapis.com/youtube/v3/search?' + qs({
        part: 'snippet',
        type: 'video',
        videoCategoryId: YOUTUBE_EDUCATION,
        safeSearch: 'strict',
        videoEmbeddable: 'true',
        maxResults: pageSize,
        q,
        relevanceLanguage: langs[0] || (isHebrew(q) ? 'he' : undefined),
        pageToken: typeof cursor === 'string' ? cursor : undefined,
        key: String(source.key || '').trim(),
      });
    }
    case 'invidious': {
      const base = normalizeBase(source.url);
      return `${base}/api/v1/search?` + qs({ q, type: 'video', page: page + 1 });
    }
    default:
      throw new Error('unknown-source');
  }
}

function video(fields) {
  return {
    id: '',
    sourceId: '',
    sourceType: '',
    sourceName: '',
    title: '',
    description: '',
    author: '',
    duration: 0,
    thumb: '',
    play: { kind: 'iframe', url: '' },
    pageUrl: '',
    lang: '',
    tags: [],
    ...fields,
  };
}

function srcFields(source) {
  return { sourceId: source.id, sourceType: source.type, sourceName: source.name };
}

// ← { items, next } — next = הסמן לעמוד הבא, או null
export function parseResults(source, json, cursor = 0) {
  const page = typeof cursor === 'number' ? cursor : 0;
  const items = [];
  let next = null;
  if (!json || typeof json !== 'object') return { items, next };

  switch (source.type) {
    case 'peertube': {
      const base = (() => { try { return normalizeBase(source.url); } catch { return ''; } })();
      for (const v of Array.isArray(json.data) ? json.data : []) {
        if (!v || v.nsfw) continue;
        if (v.category && v.category.id !== PEERTUBE_EDUCATION) continue;
        const watch = safeUrl(v.url) || (base && v.uuid ? `${base}/videos/watch/${v.uuid}` : '');
        const host = hostOf(watch) || hostOf(base);
        const embed = safeUrl(v.embedUrl) || (v.embedPath ? safeUrl(`https://${host}${v.embedPath}`) : '');
        if (!v.uuid || !host || !embed) continue;
        items.push(video({
          ...srcFields(source),
          id: `peertube:${host}:${v.uuid}`,
          nativeId: v.uuid,
          host,
          title: String(v.name || ''),
          description: stripHtml(v.truncatedDescription || v.description),
          author: String(v.channel?.displayName || v.account?.displayName || ''),
          duration: parseDuration(v.duration),
          thumb: safeUrl(v.thumbnailUrl) || (v.thumbnailPath ? safeUrl(`https://${host}${v.thumbnailPath}`) : ''),
          play: { kind: 'iframe', url: embed },
          pageUrl: watch,
          lang: v.language?.id || '',
          tags: Array.isArray(v.tags) ? v.tags.map(String) : [],
        }));
      }
      const total = Number(json.total) || 0;
      if ((page + 1) * PAGE_SIZE < total) next = page + 1;
      break;
    }
    case 'archive': {
      const docs = json.response?.docs;
      for (const d of Array.isArray(docs) ? docs : []) {
        if (!d || !d.identifier) continue;
        const id = encodeURIComponent(d.identifier);
        const desc = Array.isArray(d.description) ? d.description.join(' ') : d.description;
        items.push(video({
          ...srcFields(source),
          id: `archive:${d.identifier}`,
          nativeId: d.identifier,
          title: String(Array.isArray(d.title) ? d.title[0] : d.title || d.identifier),
          description: stripHtml(desc),
          author: String(Array.isArray(d.creator) ? d.creator[0] : d.creator || ''),
          duration: parseDuration(d.runtime),
          thumb: `https://archive.org/services/img/${id}`,
          play: { kind: 'iframe', url: `https://archive.org/embed/${id}` },
          resolvable: true,
          pageUrl: `https://archive.org/details/${id}`,
          lang: String(Array.isArray(d.language) ? d.language[0] : d.language || ''),
          tags: (Array.isArray(d.subject) ? d.subject : d.subject ? [d.subject] : []).map(String),
        }));
      }
      const found = Number(json.response?.numFound) || 0;
      if ((page + 1) * PAGE_SIZE < found) next = page + 1;
      break;
    }
    case 'commons': {
      const pages = Object.values(json.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const p of pages) {
        const info = p.imageinfo?.[0];
        if (!info || info.mediatype !== 'VIDEO') continue;
        const url = safeUrl(info.url);
        if (!url) continue;
        const meta = info.extmetadata || {};
        const name = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ');
        items.push(video({
          ...srcFields(source),
          id: `commons:${p.pageid}`,
          nativeId: String(p.pageid),
          title: stripHtml(meta.ObjectName?.value) || name,
          description: stripHtml(meta.ImageDescription?.value),
          author: stripHtml(meta.Artist?.value),
          duration: parseDuration(info.duration),
          thumb: safeUrl(info.thumburl),
          play: { kind: 'video', url },
          pageUrl: safeUrl(info.descriptionurl),
        }));
      }
      if (json.continue && json.continue.gsroffset !== undefined) next = page + 1;
      break;
    }
    case 'youtube': {
      for (const it of Array.isArray(json.items) ? json.items : []) {
        const vid = it?.id?.videoId;
        if (!vid || !/^[\w-]{6,20}$/.test(vid)) continue;
        const sn = it.snippet || {};
        items.push(video({
          ...srcFields(source),
          id: `youtube:${vid}`,
          nativeId: vid,
          title: stripHtml(sn.title),
          description: stripHtml(sn.description),
          author: stripHtml(sn.channelTitle),
          thumb: safeUrl(sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url),
          play: { kind: 'iframe', url: `https://www.youtube-nocookie.com/embed/${vid}?rel=0&modestbranding=1&playsinline=1` },
          pageUrl: `https://www.youtube.com/watch?v=${vid}`,
          lang: sn.defaultAudioLanguage || '',
        }));
      }
      next = typeof json.nextPageToken === 'string' ? json.nextPageToken : null;
      break;
    }
    case 'invidious': {
      const base = (() => { try { return normalizeBase(source.url); } catch { return ''; } })();
      const list = Array.isArray(json) ? json : [];
      for (const v of list) {
        if (!v || v.type !== 'video' || !/^[\w-]{6,20}$/.test(v.videoId || '')) continue;
        const thumbs = Array.isArray(v.videoThumbnails) ? v.videoThumbnails : [];
        const t = thumbs.find((x) => x.quality === 'medium') || thumbs[0];
        let thumb = t ? String(t.url || '') : '';
        if (thumb.startsWith('/')) thumb = base + thumb;
        items.push(video({
          ...srcFields(source),
          id: `youtube:${v.videoId}`, // אותו סרטון כמו ביוטיוב — מאוחד בכפילויות
          nativeId: v.videoId,
          title: String(v.title || ''),
          description: stripHtml(v.description),
          author: String(v.author || ''),
          duration: parseDuration(v.lengthSeconds),
          thumb: safeUrl(thumb),
          play: { kind: 'iframe', url: `${base}/embed/${v.videoId}` },
          pageUrl: `${base}/watch?v=${v.videoId}`,
        }));
      }
      if (list.length) next = page + 1;
      break;
    }
  }
  return { items, next };
}

// יוטיוב לא מחזיר משך בחיפוש — בקשה אחת נוספת לכל עמוד (יחידת מכסה אחת)
export function buildYoutubeDetailsUrl(source, ids) {
  const clean = ids.filter((id) => /^[\w-]{6,20}$/.test(id)).slice(0, 50);
  if (!clean.length) return '';
  return 'https://www.googleapis.com/youtube/v3/videos?' + qs({ part: 'contentDetails', id: clean.join(','), key: String(source.key || '').trim() });
}

export function parseYoutubeDurations(json) {
  const out = {};
  for (const it of Array.isArray(json?.items) ? json.items : []) {
    if (it?.id) out[it.id] = parseIsoDuration(it.contentDetails?.duration);
  }
  return out;
}

// כתובת לקבלת קובץ וידאו ישיר (נגן מקומי: מהירות, המשך מהמקום, הערות לפי זמן)
export function buildResolveUrl(v) {
  if (v.sourceType === 'archive' && v.nativeId) {
    return `https://archive.org/metadata/${encodeURIComponent(v.nativeId)}`;
  }
  if (v.sourceType === 'peertube' && v.host && v.nativeId) {
    return `https://${v.host}/api/v1/videos/${encodeURIComponent(v.nativeId)}`;
  }
  if (v.sourceType === 'commons' && /^\d+$/.test(String(v.nativeId || ''))) {
    return `https://commons.wikimedia.org/w/api.php?action=query&prop=videoinfo&viprop=derivatives%7Csize%7Curl&pageids=${v.nativeId}&format=json&origin=*`;
  }
  return '';
}

const MAX_HEIGHT = { low: 480, normal: 720 };

// ← { url, size } של הקובץ המתאים לאיכות (size משוער, 0 = לא ידוע), או { url: '' }
// quality: 'normal' (עד 720p) לצפייה ולהורדה רגילה, 'low' (עד 480p / 512kb) לחיסכון במקום
export function resolveFile(v, json, quality = 'normal') {
  const none = { url: '', size: 0 };
  if (!json || typeof json !== 'object') return none;
  const low = quality === 'low';
  const max = MAX_HEIGHT[low ? 'low' : 'normal'];
  if (v.sourceType === 'archive') {
    const files = Array.isArray(json.files) ? json.files : [];
    const mp4 = files.filter((f) => f && typeof f.name === 'string' && /\.mp4$/i.test(f.name));
    if (!mp4.length) return none;
    const is512 = (f) => /512kb/i.test(f.name) || /512kb/i.test(f.format || '');
    // רגיל: נגזרת h.264 (איכות טובה, גודל סביר) ← 512kb ← מקור; חסכוני: 512kb קודם
    const rank = (f) => (low
      ? (is512(f) ? 0 : 1)
      : (!is512(f) && f.source === 'derivative' ? 0 : is512(f) ? 1 : 2));
    mp4.sort((a, b) => rank(a) - rank(b) || (Number(a.size) || 0) - (Number(b.size) || 0));
    const path = mp4[0].name.split('/').map(encodeURIComponent).join('/');
    return { url: `https://archive.org/download/${encodeURIComponent(v.nativeId)}/${path}`, size: Number(mp4[0].size) || 0 };
  }
  if (v.sourceType === 'peertube') {
    let files = Array.isArray(json.files) ? json.files : [];
    if (!files.length && Array.isArray(json.streamingPlaylists)) {
      files = json.streamingPlaylists.flatMap((p) => (Array.isArray(p.files) ? p.files : []));
    }
    const res = (f) => Number(f.resolution?.id ?? f.resolution) || 0;
    const usable = files.filter((f) => safeUrl(f.fileUrl) && res(f) > 0);
    if (!usable.length) return none;
    const atMost = usable.filter((f) => res(f) <= max).sort((a, b) => res(b) - res(a));
    const pick = atMost[0] || usable.sort((a, b) => res(a) - res(b))[0];
    return { url: safeUrl(pick.fileUrl), size: Number(pick.size) || 0 };
  }
  if (v.sourceType === 'commons') {
    const info = Object.values(json.query?.pages || {})[0]?.videoinfo?.[0];
    if (!info) return none;
    const duration = Number(info.duration) || Number(v.duration) || 0;
    // גרסאות מוקטנות של ויקישיתוף (webm); mov לא מתנגן בטלפון
    const derivs = (Array.isArray(info.derivatives) ? info.derivatives : [])
      .filter((d) => safeUrl(d.src) && /webm/i.test(d.type || d.src) && Number(d.height) > 0 && Number(d.height) <= max)
      .sort((a, b) => Number(b.height) - Number(a.height));
    if (derivs.length) {
      const d = derivs[0];
      return { url: safeUrl(d.src), size: Math.round(((Number(d.bandwidth) || 0) * duration) / 8) };
    }
    const orig = safeUrl(info.url) || safeUrl(v.play?.url);
    return { url: orig, size: Number(info.size) || 0 };
  }
  return none;
}

// ← כתובת קובץ ישירה בלבד, או '' (ואז נשארים עם הנגן המוטמע)
export function parseResolve(v, json, quality = 'normal') {
  return resolveFile(v, json, quality).url;
}

// אפשר לשמור בטלפון רק סרטון עם קובץ ישיר (לא יוטיוב / Invidious)
export function canDownload(v) {
  if (!v) return false;
  if (v.sourceType === 'audio') return v.play?.kind === 'audio' && !!safeUrl(v.play.url); // פרק בספר שמע
  if (v.sourceType === 'book') return !!v.nativeId; // ספר קריאה — קובץ הטקסט
  if (v.sourceType === 'commons') return v.play?.kind === 'video' && !!safeUrl(v.play.url) && /^\d+$/.test(String(v.nativeId || ''));
  if (v.sourceType === 'archive') return !!v.nativeId;
  if (v.sourceType === 'peertube') return !!(v.host && v.nativeId);
  return false;
}
