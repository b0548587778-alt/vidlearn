// סנכרון בין מכשירים דרך חשבון Google: קובץ אחד בתיקייה הנסתרת של האפליקציה ב-Drive
// (appDataFolder — לא נראה ב-Drive של המשתמש ולא נגיש לאפליקציות אחרות).
// טהור — המיזוג וכתובות ה-API, בלי fetch. נבדק ב-tests/sync.test.mjs.

export const SYNC_FILE = 'vidlearn-sync.json';
const MAX_HISTORY = 200;
const MAX_NOTES = 500;
const TOMBSTONE_DAYS = 180; // סימון "נמחק" נשמר חצי שנה — מספיק כדי שכל המכשירים יראו אותו

// הגדרות שעוברות בין מכשירים. הגדרות ההורדה (Wi-Fi, נפח, תיקייה) — של כל טלפון לחוד
// filterPin עובר — נעילת הסינון חלה על כל הטלפונים של החשבון
const SYNCED_SETTINGS = ['lang', 'strict', 'extraBlock', 'contentLangs', 'crossLang', 'bookScanned', 'readerFont', 'sources', 'hideThumbs', 'filterPin', 'ytInstances', 'updatedAt'];

// החלק של המצב שעובר בסנכרון: בלי הורדות, בלי מטמון פרקים ובלי מפתחות API (סוד)
export function syncPayload(state) {
  const settings = {};
  for (const k of SYNCED_SETTINGS) if (state.settings[k] !== undefined) settings[k] = state.settings[k];
  settings.sources = (state.settings.sources || []).map(({ key, ...rest }) => rest);
  return {
    v: 1,
    settings,
    courses: state.courses || [],
    favorites: state.favorites || [],
    history: state.history || [],
    progress: state.progress || {},
    notes: state.notes || {},
    deleted: state.deleted || {},
  };
}

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);

// לכל מזהה — הגרסה עם הזמן המאוחר יותר (בתיקו: המקומית)
function newestById(local, remote, idOf, timeOf) {
  const out = new Map();
  for (const x of arr(remote)) if (x && idOf(x)) out.set(idOf(x), x);
  for (const x of arr(local)) {
    if (!x || !idOf(x)) continue;
    const other = out.get(idOf(x));
    if (!other || (timeOf(x) || 0) >= (timeOf(other) || 0)) out.set(idOf(x), x);
  }
  return [...out.values()];
}

// מיזוג שני מצבים (המקומי ומה שב-Drive). שום דבר לא נמחק רק כי חסר בצד אחד —
// רק סימון "נמחק" שמאוחר מהפריט מוחק אותו.
export function mergeSync(local, remote, now = Date.now()) {
  const L = obj(local);
  const R = obj(remote);

  const deleted = {};
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  for (const src of [obj(R.deleted), obj(L.deleted)]) {
    for (const [k, at] of Object.entries(src)) {
      const t = Number(at) || 0;
      if (t > cutoff && t > (deleted[k] || 0)) deleted[k] = t;
    }
  }
  const alive = (key, t) => !(deleted[key] >= (Number(t) || 0));

  const courseTime = (c) => Number(c.updatedAt) || Number(c.createdAt) || 0;
  const courses = newestById(L.courses, R.courses, (c) => c.id, courseTime)
    .filter((c) => alive(`course:${c.id}`, courseTime(c)))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

  const favorites = newestById(L.favorites, R.favorites, (v) => v.id, (v) => v.favAt)
    .filter((v) => alive(`fav:${v.id}`, v.favAt))
    .sort((a, b) => (Number(b.favAt) || 0) - (Number(a.favAt) || 0));

  const history = newestById(L.history, R.history, (x) => x.video?.id, (x) => x.at)
    .filter((x) => !(deleted.history >= (Number(x.at) || 0)))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_HISTORY);

  const progress = {};
  for (const src of [obj(R.progress), obj(L.progress)]) {
    for (const [id, p] of Object.entries(src)) {
      if (!p || typeof p !== 'object') continue;
      if (!progress[id] || (Number(p.at) || 0) >= (Number(progress[id].at) || 0)) progress[id] = p;
    }
  }

  const notes = {};
  const noteIds = new Set([...Object.keys(obj(L.notes)), ...Object.keys(obj(R.notes))]);
  for (const id of noteIds) {
    const list = newestById(obj(L.notes)[id], obj(R.notes)[id], (n) => n.id, (n) => n.at)
      .filter((n) => alive(`note:${n.id}`, n.at))
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (Number(a.at) || 0) - (Number(b.at) || 0))
      .slice(0, MAX_NOTES);
    if (list.length) notes[id] = list;
  }

  const ls = obj(L.settings);
  const rs = obj(R.settings);
  const settings = (Number(rs.updatedAt) || 0) > (Number(ls.updatedAt) || 0) ? rs : ls;

  return { v: 1, settings, courses, favorites, history, progress, notes, deleted };
}

// השוואה שלא תלויה בסדר המפתחות — כדי לא להעלות / להחיל כשאין שינוי
export function stableStringify(x) {
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x ?? null);
}

export function samePayload(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// ---------- Google Drive (appDataFolder) ----------
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export function driveFindUrl(name = SYNC_FILE) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  return `${DRIVE}?${new URLSearchParams({ spaces: 'appDataFolder', q, fields: 'files(id,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '10' })}`;
}

export function driveFileUrl(id) {
  return `${DRIVE}/${encodeURIComponent(id)}`;
}

export function driveDownloadUrl(id) {
  return `${DRIVE}/${encodeURIComponent(id)}?alt=media`;
}

// יצירה: קודם הקובץ (מטא-דאטה בלבד), ואז העלאת התוכן — בלי multipart
export function driveCreateRequest(name = SYNC_FILE) {
  return { url: `${DRIVE}?fields=id`, body: JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' }) };
}

export function driveUploadUrl(id) {
  return `${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`;
}

export function parseDriveFind(json) {
  const files = arr(obj(json).files).filter((f) => f && typeof f.id === 'string' && f.id);
  return files[0]?.id || null;
}
