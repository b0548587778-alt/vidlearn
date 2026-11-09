// הורדה מקישור ומיוטיוב. טהור: מזהה קישורים, בונה כתובות ומפרק תשובות; נבדק ב-tests/links.test.mjs.
//
// יוטיוב לא נותן קובץ להורדה דרך ה-API הרשמי. לכן ההורדה עוברת דרך שרתים פתוחים שמתווכים
// ליוטיוב (Invidious / Piped) — הם מחזירים קובץ MP4 / M4A רגיל. אפשר לשנות את רשימת השרתים
// בהגדרות; שרת שלא עונה מדולג והבא בתור מנוסה.
import { safeUrl, stripHtml, parseDuration } from './util.js';

export const DEFAULT_YT_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
];

const YT_ID = /^[\w-]{11}$/;
const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;
export const MEDIA_EXT = /\.(mp4|webm|m4v|ogv|mp3|m4a|aac|opus|ogg)$/i;

// שרת Piped (API שונה מ-Invidious) — לפי השם
export function instanceKind(base) {
  try { return /(^|\.|-)piped/i.test(new URL(base).hostname) ? 'piped' : 'invidious'; } catch { return ''; }
}

// רשימת שרתים מההגדרות (שורה / פסיק לכל שרת) ← כתובות בסיס https תקינות
export function parseInstances(s) {
  const list = Array.isArray(s) ? s : String(s || '').split(/[\s,]+/);
  const out = [];
  for (const x of list) {
    let u = String(x || '').trim();
    if (!u) continue;
    if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
    try {
      const url = new URL(u);
      if (url.protocol === 'https:' && !out.includes(url.origin)) out.push(url.origin);
    } catch { /* מדלגים */ }
  }
  return out.slice(0, 10);
}

// קישור שהמשתמש הדביק ← { type, ... } או null.
// youtube (גם youtu.be, shorts, וקישור watch?v= של שרת Invidious) / vimeo / peertube / archive / commons / direct
export function parseLink(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  // יוטיוב
  if (host === 'youtu.be' && YT_ID.test(parts[0] || '')) return { type: 'youtube', id: parts[0] };
  if (YT_HOSTS.test(host)) {
    const v = url.searchParams.get('v');
    if (v && YT_ID.test(v)) return { type: 'youtube', id: v };
    if (['shorts', 'embed', 'live', 'v'].includes(parts[0]) && YT_ID.test(parts[1] || '')) return { type: 'youtube', id: parts[1] };
    return null;
  }
  // Vimeo
  if (/^(www\.)?vimeo\.com$/.test(host)) {
    const id = parts.find((p) => /^\d{5,12}$/.test(p));
    return id ? { type: 'vimeo', id } : null;
  }
  if (host === 'player.vimeo.com' && parts[0] === 'video' && /^\d{5,12}$/.test(parts[1] || '')) return { type: 'vimeo', id: parts[1] };
  // Internet Archive
  if (/^(www\.)?archive\.org$/.test(host)) {
    if (parts[0] === 'details' && parts[1]) return { type: 'archive', id: decodeURIComponent(parts[1]) };
    if (parts[0] === 'download' && parts[1] && parts.length > 2 && MEDIA_EXT.test(url.pathname)) return { type: 'direct', url: url.href };
    return null;
  }
  // Wikimedia Commons
  if (host === 'commons.wikimedia.org' && parts[0] === 'wiki' && /^File:/i.test(decodeURIComponent(parts[1] || ''))) {
    return { type: 'commons', title: decodeURIComponent(parts.slice(1).join('/')).replace(/_/g, ' ') };
  }
  // קובץ ישיר
  if (MEDIA_EXT.test(url.pathname)) return { type: 'direct', url: url.href };
  // PeerTube (כל שרת): /w/<id> או /videos/watch/<uuid>
  if (parts[0] === 'w' && /^[\w-]{8,40}$/.test(parts[1] || '') && parts.length === 2) return { type: 'peertube', host: url.host, id: parts[1] };
  if (parts[0] === 'videos' && parts[1] === 'watch' && /^[\w-]{8,40}$/.test(parts[2] || '')) return { type: 'peertube', host: url.host, id: parts[2] };
  // Invidious / Piped (watch?v=)
  const v = url.searchParams.get('v');
  if (parts[0] === 'watch' && v && YT_ID.test(v)) return { type: 'youtube', id: v };
  return null;
}

// ---------- יוטיוב דרך Invidious / Piped ----------
export function buildYtInfoUrl(base, id) {
  if (!YT_ID.test(id)) throw new Error('bad-id');
  return instanceKind(base) === 'piped'
    ? `${base}/streams/${id}`
    : `${base}/api/v1/videos/${id}?local=true`; // local — הקובץ עובר דרך השרת (כתובות יוטיוב קשורות לכתובת ה-IP שלו)
}

const abs = (base, u) => {
  const s = String(u || '');
  return safeUrl(s.startsWith('/') ? base + s : s);
};
const heightOf = (x) => Number(String(x || '').match(/(\d{3,4})p?/)?.[1]) || 0;

// תשובת השרת ← { meta, url, size, ext } לפי האיכות: normal (עד 720p), low (הכי קטן), audio (שמע בלבד, m4a)
export function parseYtInfo(base, json, quality = 'normal') {
  const none = { meta: null, url: '', size: 0, ext: '' };
  if (!json || typeof json !== 'object' || json.error) return none;
  const piped = instanceKind(base) === 'piped';
  const meta = piped ? {
    title: String(json.title || ''),
    description: stripHtml(json.description),
    author: String(json.uploader || ''),
    duration: parseDuration(json.duration),
    tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
    category: String(json.category || ''),
    familyFriendly: json.familyFriendly === false ? false : undefined,
  } : {
    title: String(json.title || ''),
    description: stripHtml(json.description),
    author: String(json.author || ''),
    duration: parseDuration(json.lengthSeconds),
    tags: Array.isArray(json.keywords) ? json.keywords.map(String) : [],
    category: String(json.genre || ''),
    familyFriendly: json.isFamilyFriendly === false ? false : undefined,
  };
  if (!meta.title) return none;

  if (quality === 'audio') {
    const audio = piped
      ? (Array.isArray(json.audioStreams) ? json.audioStreams : []).filter((a) => /audio\/mp4|m4a/i.test(`${a.mimeType} ${a.format}`))
        .map((a) => ({ url: abs(base, a.url), rate: Number(a.bitrate) || 0, size: Number(a.contentLength) || 0 }))
      : (Array.isArray(json.adaptiveFormats) ? json.adaptiveFormats : []).filter((a) => /^audio\/mp4/i.test(a.type || ''))
        .map((a) => ({ url: abs(base, a.url), rate: Number(a.bitrate) || 0, size: Number(a.clen) || 0 }));
    const pick = audio.filter((a) => a.url).sort((a, b) => b.rate - a.rate)[0];
    if (pick) return { meta, url: pick.url, size: pick.size, ext: 'm4a' };
    // אין שמע נפרד — הסרטון הרגיל (גם בו יש קול)
  }
  // קובץ עם תמונה וקול יחד (muxed)
  const muxed = piped
    ? (Array.isArray(json.videoStreams) ? json.videoStreams : []).filter((x) => x.videoOnly === false && /mp4/i.test(`${x.mimeType} ${x.format}`))
      .map((x) => ({ url: abs(base, x.url), h: Number(x.height) || heightOf(x.quality), size: Number(x.contentLength) || 0 }))
    : (Array.isArray(json.formatStreams) ? json.formatStreams : []).filter((x) => /mp4/i.test(`${x.type} ${x.container}`))
      .map((x) => ({ url: abs(base, x.url), h: heightOf(x.resolution || x.qualityLabel || x.size), size: Number(x.clen) || 0 }));
  const usable = muxed.filter((x) => x.url);
  if (!usable.length) return { ...none, meta };
  const max = quality === 'low' ? 0 : 720;
  const pick = quality === 'low'
    ? usable.sort((a, b) => a.h - b.h)[0]
    : (usable.filter((x) => x.h <= max).sort((a, b) => b.h - a.h)[0] || usable.sort((a, b) => a.h - b.h)[0]);
  return { meta, url: pick.url, size: pick.size, ext: 'mp4' };
}

// ---------- Vimeo ----------
export const vimeoInfoUrl = (id) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`;
export const vimeoConfigUrl = (id) => `https://player.vimeo.com/video/${id}/config`;

export function parseVimeoInfo(json) {
  if (!json || !json.title) return null;
  return {
    title: String(json.title),
    description: stripHtml(json.description),
    author: String(json.author_name || ''),
    duration: parseDuration(json.duration),
    thumb: safeUrl(json.thumbnail_url),
  };
}

// קבצי MP4 רגילים (progressive) — לא בכל סרטון יש
export function parseVimeoConfig(json, quality = 'normal') {
  const files = (json?.request?.files?.progressive || []).filter((f) => safeUrl(f.url));
  if (!files.length) return { url: '', size: 0 };
  const h = (f) => Number(f.height) || heightOf(f.quality);
  const pick = quality === 'low'
    ? files.sort((a, b) => h(a) - h(b))[0]
    : (files.filter((f) => h(f) <= 720).sort((a, b) => h(b) - h(a))[0] || files.sort((a, b) => h(a) - h(b))[0]);
  return { url: safeUrl(pick.url), size: 0 };
}

// ---------- Commons: שם קובץ ← מזהה ----------
export const commonsTitleUrl = (title) => 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
  action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|mediatype|extmetadata|size', iiurlwidth: '320',
  iiextmetadatafilter: 'ImageDescription|Artist|ObjectName', format: 'json', origin: '*',
}).toString();

// שם קריא לקובץ ישיר: "lesson_01.mp4" ← "lesson 01"
export function titleFromUrl(u) {
  try {
    const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
    return name.replace(MEDIA_EXT, '').replace(/[_+.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  } catch { return ''; }
}

// טקסט ששותף מאפליקציה אחרת ("צפו בזה: https://youtu.be/…") ← הקישור הראשון
export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : '';
}
