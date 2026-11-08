// מצב האפליקציה — הכול בטלפון (localStorage), בלי שרת.
import { DEFAULT_SOURCES, SOURCE_TYPES } from './sources.js';
import { normalizeBase, uid } from './util.js';

export const STORAGE_KEY = 'vidlearn:v1';
const MAX_HISTORY = 200;
const MAX_NOTES = 500;
export const DONE_RATIO = 0.9;

export function defaultState() {
  return {
    v: 1,
    settings: {
      lang: 'he',
      strict: false, // מילת לימוד נדרשת בכל המקורות
      extraBlock: [],
      contentLangs: [],
      sources: DEFAULT_SOURCES.map((s) => ({ ...s })),
      ...DOWNLOAD_DEFAULTS,
    },
    courses: [],
    favorites: [],
    history: [],
    progress: {},
    notes: {},
    downloads: {}, // id ← { video, status, path, uri, size, quality, at, error }
  };
}

export const DOWNLOAD_DEFAULTS = {
  dlWifiOnly: true,       // הורדה רק ב-Wi-Fi
  dlQuality: 'normal',    // normal (עד 720p) / low (חסכוני)
  dlLimitMB: 2000,        // תקרת נפח לכל הסרטונים השמורים
  dlAutoNext: true,       // בקורס — להוריד מראש את השיעור הבא
  dlDeleteLearned: false, // למחוק סרטון שמור כשמסמנים אותו כנלמד
};
export const DL_STATUSES = ['queued', 'waiting', 'downloading', 'done', 'error'];

// תמונת מצב של סרטון לשמירה — רק השדות שהממשק צריך
export function snapshot(v) {
  const { id, sourceId, sourceType, sourceName, title, author, duration, thumb, play, pageUrl, nativeId, host, resolvable, description } = v;
  return {
    id, sourceId, sourceType, sourceName, title, author, duration, thumb, nativeId, host, resolvable, pageUrl,
    description: String(description || '').slice(0, 600),
    play: { kind: play?.kind === 'video' ? 'video' : 'iframe', url: String(play?.url || '') },
  };
}

// קלט לא מהימן (קובץ ישן / ידני) ← מצב תקין
export function normalizeState(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== 'object') return d;
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const sources = Array.isArray(s.sources) ? s.sources.filter((x) => x && SOURCE_TYPES[x.type] && x.id) : [];
  // מקור מובנה שחסר (גרסה חדשה הוסיפה) — נוסף
  for (const def of DEFAULT_SOURCES) if (!sources.some((x) => x.id === def.id)) sources.push({ ...def });
  return {
    v: 1,
    settings: {
      lang: s.lang === 'en' ? 'en' : 'he',
      strict: !!s.strict,
      extraBlock: Array.isArray(s.extraBlock) ? s.extraBlock.map(String).slice(0, 200) : [],
      contentLangs: Array.isArray(s.contentLangs) ? s.contentLangs.map(String).filter((x) => /^[a-z]{2,3}$/.test(x)).slice(0, 5) : [],
      sources,
      dlWifiOnly: s.dlWifiOnly === undefined ? DOWNLOAD_DEFAULTS.dlWifiOnly : !!s.dlWifiOnly,
      dlQuality: s.dlQuality === 'low' ? 'low' : 'normal',
      dlLimitMB: Number.isFinite(Number(s.dlLimitMB)) && Number(s.dlLimitMB) >= 100 ? Math.min(Math.round(Number(s.dlLimitMB)), 200000) : DOWNLOAD_DEFAULTS.dlLimitMB,
      dlAutoNext: s.dlAutoNext === undefined ? DOWNLOAD_DEFAULTS.dlAutoNext : !!s.dlAutoNext,
      dlDeleteLearned: !!s.dlDeleteLearned,
    },
    courses: Array.isArray(raw.courses) ? raw.courses.filter((c) => c && c.id && Array.isArray(c.lessons)) : [],
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((v) => v && v.id) : [],
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && h.video && h.video.id).slice(0, MAX_HISTORY) : [],
    progress: raw.progress && typeof raw.progress === 'object' ? raw.progress : {},
    notes: raw.notes && typeof raw.notes === 'object' ? raw.notes : {},
    downloads: normalizeDownloads(raw.downloads),
  };
}

function normalizeDownloads(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object' || !d.video || d.video.id !== id || !DL_STATUSES.includes(d.status)) continue;
    // הורדה שנקטעה (האפליקציה נסגרה באמצע) — חוזרת לתור
    out[id] = { ...d, status: d.status === 'downloading' ? 'queued' : d.status };
  }
  return out;
}

export function createStore(storage, { onSaveError } = {}) {
  let state;
  try {
    state = normalizeState(JSON.parse(storage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    state = defaultState();
  }
  const listeners = new Set();

  function save() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      if (onSaveError) onSaveError(); // אין מקום — המצב בזיכרון נשמר, הממשק מודיע
      return false;
    } finally {
      listeners.forEach((fn) => fn(state));
    }
  }

  const api = {
    get state() { return state; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    save,

    // --- הגדרות ---
    setSetting(key, value) { state.settings[key] = value; return save(); },
    addSource({ type, name, url, key }) {
      if (!SOURCE_TYPES[type]) throw new Error('unknown-source');
      const src = { id: uid(), type, name: String(name || '').trim(), enabled: true };
      if (SOURCE_TYPES[type].needsUrl) src.url = normalizeBase(url);
      if (type === 'archive') src.url = 'https://archive.org';
      if (type === 'commons') src.url = 'https://commons.wikimedia.org';
      if (SOURCE_TYPES[type].needsKey) src.key = String(key || '').trim();
      if (!src.name) src.name = src.url ? new URL(src.url).host : type;
      if (src.url && state.settings.sources.some((s) => s.type === type && s.url === src.url)) throw new Error('duplicate-source');
      state.settings.sources.push(src);
      save();
      return src;
    },
    updateSource(id, patch) {
      const s = state.settings.sources.find((x) => x.id === id);
      if (!s) return false;
      if ('enabled' in patch) s.enabled = !!patch.enabled;
      if ('key' in patch) s.key = String(patch.key || '').trim();
      if ('name' in patch && String(patch.name).trim()) s.name = String(patch.name).trim();
      return save();
    },
    removeSource(id) {
      const s = state.settings.sources.find((x) => x.id === id);
      if (!s || s.builtin) return false;
      state.settings.sources = state.settings.sources.filter((x) => x.id !== id);
      return save();
    },

    // --- היסטוריה ומועדפים ---
    addHistory(v) {
      state.history = [{ video: snapshot(v), at: Date.now() }, ...state.history.filter((h) => h.video.id !== v.id)].slice(0, MAX_HISTORY);
      return save();
    },
    clearHistory() { state.history = []; return save(); },
    isFavorite(id) { return state.favorites.some((v) => v.id === id); },
    toggleFavorite(v) {
      if (api.isFavorite(v.id)) state.favorites = state.favorites.filter((x) => x.id !== v.id);
      else state.favorites.unshift(snapshot(v));
      return save();
    },

    // --- התקדמות ---
    getProgress(id) { return state.progress[id] || null; },
    setPosition(id, pos, dur) {
      const p = state.progress[id] || {};
      p.pos = Math.max(0, Math.round(pos));
      if (dur > 0) p.dur = Math.round(dur);
      if (p.dur && p.pos / p.dur >= DONE_RATIO) p.done = true;
      p.at = Date.now();
      state.progress[id] = p;
      return save();
    },
    setDone(id, done) {
      const p = state.progress[id] || {};
      p.done = !!done;
      p.at = Date.now();
      state.progress[id] = p;
      return save();
    },

    // --- הערות ---
    notesFor(id) { return (state.notes[id] || []).slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0)); },
    addNote(id, text, t) {
      const clean = String(text || '').trim().slice(0, 2000);
      if (!clean) return false;
      const list = state.notes[id] || [];
      if (list.length >= MAX_NOTES) return false;
      list.push({ id: uid(), text: clean, t: t == null ? null : Math.max(0, Math.round(t)), at: Date.now() });
      state.notes[id] = list;
      return save();
    },
    deleteNote(id, noteId) {
      state.notes[id] = (state.notes[id] || []).filter((n) => n.id !== noteId);
      if (!state.notes[id].length) delete state.notes[id];
      return save();
    },

    // --- קורסים ---
    createCourse(name, subject = '') {
      const clean = String(name || '').trim().slice(0, 120);
      if (!clean) throw new Error('empty-name');
      const c = { id: uid(), name: clean, subject: String(subject || ''), createdAt: Date.now(), lessons: [] };
      state.courses.unshift(c);
      save();
      return c;
    },
    renameCourse(id, name) {
      const c = state.courses.find((x) => x.id === id);
      const clean = String(name || '').trim().slice(0, 120);
      if (!c || !clean) return false;
      c.name = clean;
      return save();
    },
    deleteCourse(id) {
      state.courses = state.courses.filter((c) => c.id !== id);
      return save();
    },
    addLesson(courseId, v) {
      const c = state.courses.find((x) => x.id === courseId);
      if (!c) return false;
      if (c.lessons.some((l) => l.id === v.id)) return false;
      c.lessons.push(snapshot(v));
      return save();
    },
    removeLesson(courseId, videoId) {
      const c = state.courses.find((x) => x.id === courseId);
      if (!c) return false;
      c.lessons = c.lessons.filter((l) => l.id !== videoId);
      return save();
    },
    moveLesson(courseId, index, delta) {
      const c = state.courses.find((x) => x.id === courseId);
      if (!c) return false;
      const j = index + delta;
      if (index < 0 || j < 0 || index >= c.lessons.length || j >= c.lessons.length) return false;
      [c.lessons[index], c.lessons[j]] = [c.lessons[j], c.lessons[index]];
      return save();
    },
    // --- הורדות ---
    getDownload(id) { return state.downloads[id] || null; },
    setDownload(id, patch) {
      if (patch === null) delete state.downloads[id];
      else state.downloads[id] = { ...(state.downloads[id] || {}), ...patch };
      return save();
    },

    coursesWith(videoId) { return state.courses.filter((c) => c.lessons.some((l) => l.id === videoId)); },

    // גיבוי ידני: ייצוא / ייבוא של כל המצב כ-JSON
    exportJson() { return JSON.stringify({ ...state, downloads: {} }, null, 2); },
    importJson(text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !parsed.settings) throw new Error('bad-backup');
      const keep = state.downloads; // הקבצים בטלפון הזה, לא בגיבוי
      state = normalizeState(parsed);
      state.downloads = keep;
      return save();
    },
  };
  return api;
}

export function courseProgress(course, progress) {
  const total = course.lessons.length;
  let done = 0;
  let nextIndex = -1;
  course.lessons.forEach((l, i) => {
    if (progress[l.id]?.done) done++;
    else if (nextIndex < 0) nextIndex = i;
  });
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0, nextIndex };
}

// "המשך לצפות": סרטונים שהתחילו ולא הסתיימו, האחרונים קודם
export function continueWatching(state, limit = 10) {
  return state.history
    .filter((h) => {
      const p = state.progress[h.video.id];
      return p && !p.done && p.pos > 5;
    })
    .slice(0, limit)
    .map((h) => h.video);
}
