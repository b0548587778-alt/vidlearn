// מצב האפליקציה — הכול בטלפון (localStorage), בלי שרת.
import { DEFAULT_SOURCES, SOURCE_TYPES } from './sources.js';
import { normalizeBase, uid } from './util.js';

export const STORAGE_KEY = 'vidlearn:v1';
const MAX_HISTORY = 200;
const MAX_NOTES = 500;
export const MAX_PROGRESS = 3000; // רשומות התקדמות; הישנות ביותר נמחקות (חוץ מאלה שבקורסים)
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
      bookScanned: true, // בחיפוש ספרים — גם ספרים סרוקים (כולל עברית), לא רק Gutenberg
      readerFont: 19,    // גודל הגופן בקורא
    },
    courses: [],
    favorites: [],
    history: [],
    progress: {},
    notes: {},
    downloads: {}, // id ← { video, status, path, uri, size, quality, at, error }
    chapters: {},  // ספר שמע ← רשימת הפרקים (כדי שספר שמור יתנגן בלי רשת)
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
  const { id, kind, sourceId, sourceType, sourceName, title, author, duration, thumb, play, pageUrl, nativeId, host, resolvable, description, bookId, index, size, gutenberg, lang } = v;
  return {
    id, kind, sourceId, sourceType, sourceName, title, author, duration, thumb, nativeId, host, resolvable, pageUrl, bookId, index, size, gutenberg, lang,
    description: String(description || '').slice(0, 600),
    play: { kind: ['video', 'audio'].includes(play?.kind) ? play.kind : 'iframe', url: String(play?.url || '') },
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
      bookScanned: s.bookScanned === undefined ? true : !!s.bookScanned,
      readerFont: Number.isFinite(Number(s.readerFont)) ? Math.min(32, Math.max(14, Number(s.readerFont))) : 19,
      sleepMin: Number(s.sleepMin) || 0,
    },
    courses: Array.isArray(raw.courses)
      ? raw.courses.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.lessons))
        .map((c) => ({ ...c, name: String(c.name || '—'), lessons: c.lessons.filter(validVideo) }))
      : [],
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter(validVideo) : [],
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && validVideo(h.video)).slice(0, MAX_HISTORY) : [],
    progress: normalizeProgress(raw.progress),
    notes: normalizeNotes(raw.notes),
    downloads: normalizeDownloads(raw.downloads),
    chapters: normalizeChapters(raw.chapters),
  };
}

// סרטון שמור תקין: הממשק ניגש ל-id, ל-title ול-play בלי בדיקה
function validVideo(v) {
  return !!v && typeof v === 'object' && typeof v.id === 'string' && v.id !== ''
    && typeof v.title === 'string' && !!v.play && typeof v.play === 'object' && typeof v.play.url === 'string';
}

function normalizeProgress(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    out[id] = { pos: Number(p.pos) || 0, dur: Number(p.dur) || 0, done: !!p.done, at: Number(p.at) || 0 };
  }
  return out;
}

function normalizeNotes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter((n) => n && typeof n.text === 'string' && n.text.trim())
      .map((n) => ({ id: String(n.id || Math.random().toString(36).slice(2)), text: n.text.slice(0, 2000), t: Number.isFinite(n.t) ? n.t : null, at: Number(n.at) || 0 }))
      .slice(0, MAX_NOTES);
    if (clean.length) out[id] = clean;
  }
  return out;
}

function normalizeChapters(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, list] of Object.entries(raw)) {
    if (Array.isArray(list)) out[id] = list.filter(validVideo).slice(0, 1000);
  }
  return out;
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

  // התקדמות לא גדלה בלי סוף: מעל MAX_PROGRESS נמחקות הישנות ביותר,
  // חוץ מסרטונים בקורסים (שם "נלמד" קובע את ההתקדמות בקורס)
  function pruneProgress() {
    const ids = Object.keys(state.progress);
    if (ids.length <= MAX_PROGRESS) return;
    const inCourse = new Set(state.courses.flatMap((c) => c.lessons.map((l) => l.id)));
    ids.filter((id) => !inCourse.has(id))
      .sort((a, b) => (state.progress[a].at || 0) - (state.progress[b].at || 0))
      .slice(0, ids.length - MAX_PROGRESS)
      .forEach((id) => delete state.progress[id]);
  }

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
      pruneProgress();
      return save();
    },
    // התקדמות בספר: pos = עמוד / פרק נוכחי, dur = סה"כ, done — רק כשהגיעו לסוף
    setProgress(id, { pos, dur, done }) {
      const p = state.progress[id] || {};
      p.pos = Math.max(0, Math.round(Number(pos) || 0));
      p.dur = Math.max(0, Math.round(Number(dur) || 0));
      if (done !== undefined) p.done = !!done;
      p.at = Date.now();
      state.progress[id] = p;
      pruneProgress();
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
    // --- פרקי ספרי שמע ---
    getChapters(bookId) { return state.chapters[bookId] || null; },
    setChapters(bookId, list) {
      state.chapters[bookId] = list.map(snapshot);
      // עד 200 ספרים במטמון; ספר בקורס / במועדפים נשאר
      const ids = Object.keys(state.chapters);
      if (ids.length > 200) {
        const keep = new Set([...state.courses.flatMap((c) => c.lessons.map((l) => l.id)), ...state.favorites.map((f) => f.id), bookId]);
        ids.filter((id) => !keep.has(id)).slice(0, ids.length - 200).forEach((id) => delete state.chapters[id]);
      }
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
    // בלי קבצי הווידאו (נשארים בטלפון) ובלי מפתחות API (סוד — לא נשלח בשיתוף)
    exportJson() {
      const sources = state.settings.sources.map(({ key, ...rest }) => rest);
      return JSON.stringify({ ...state, settings: { ...state.settings, sources }, downloads: {} }, null, 2);
    },
    importJson(text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !parsed.settings) throw new Error('bad-backup');
      const keepDownloads = state.downloads; // הקבצים בטלפון הזה, לא בגיבוי
      const keys = Object.fromEntries(state.settings.sources.filter((x) => x.key).map((x) => [x.id, x.key]));
      state = normalizeState(parsed);
      state.downloads = keepDownloads;
      // מפתח שלא בגיבוי — נשאר המפתח שכבר בטלפון
      state.settings.sources.forEach((x) => { if (!x.key && keys[x.id]) x.key = keys[x.id]; });
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
      // ספר / ספר שמע: pos הוא עמוד / פרק; סרטון: שניות
      return p && !p.done && (h.video.kind === 'book' || h.video.kind === 'audiobook' ? p.pos >= 1 : p.pos > 5);
    })
    .slice(0, limit)
    .map((h) => h.video);
}
