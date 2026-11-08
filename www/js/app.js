// ממשק האפליקציה. כל טקסט שמגיע מהרשת נכנס דרך textContent (h()) — אין innerHTML עם נתונים חיצוניים.
import { createStore, courseProgress, continueWatching } from './store.js';
import { searchAll, resolveDirect, resolveDirectFile, searchMedia, fetchArchiveMetadata, fetchText, fetchWikiSummary, fetchWikiArticle, fetchPodcastEpisodes } from './search.js';
import { isHebrewQuery, articleBlocks } from './wiki.js';
import { itemHash, parseAudioChapters, pickBookText, cleanBookText, paginate, textDir } from './media.js';
import { SOURCE_TYPES, sourceReady, canDownload } from './sources.js';
import { createDownloads, formatBytes, publicFileName } from './downloads.js';
import { parseWordList } from './filter.js';
import { t as makeT, SUBJECTS } from './i18n.js';
import { formatDuration, truncate, safeUrl } from './util.js';
import { VERSION } from './version.js';
import { createGoogle, signInErrorKey } from './google.js';

const store = createStore(window.localStorage, { onSaveError: () => toast(tr('saveFailed')) });
let tr = makeT(store.state.settings.lang);
const view = document.getElementById('view');
const known = new Map(); // id ← סרטון (מתוצאות חיפוש / ספרייה)
let lastSearch = null;   // נשמר כדי שחזרה מהנגן תחזיר לאותן תוצאות
let cleanupView = null;

// ---------- עזרי DOM ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // דרך CSSOM — מותר ב-CSP בלי unsafe-inline
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') throw new Error('no-html');
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// כמו replaceChildren, אבל משטח מערכים ומדלג על null/false
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return el;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}


// ---------- הורדות: מתאמים ל-Capacitor (באפליקציה המותקנת בלבד) ----------
const cap = window.Capacitor;
const FS = cap?.isNativePlatform?.() ? cap?.Plugins?.Filesystem : null;
const NET = cap?.isNativePlatform?.() ? cap?.Plugins?.Network : null;
const NATIVE = cap?.isNativePlatform?.() ? cap?.Plugins?.VidLearnNative : null; // native/vidlearn-native

// ---------- חשבון Google: יוטיוב בלי מפתח + סנכרון בין מכשירים (google.js) ----------
const google = createGoogle({
  native: NATIVE ? { signIn: (o) => NATIVE.googleSignIn(o), clearToken: (o) => NATIVE.googleClearToken(o) } : null,
  store,
  storage: window.localStorage,
  // נתונים ממכשיר אחר — מרעננים רק מסכי רשימות (לא נגן / קורא באמצע)
  onApplied: () => {
    const name = (location.hash.replace(/^#\/?/, '') || 'home').split(/[/?]/)[0];
    if (['home', 'library', 'course'].includes(name)) route();
  },
});
const ready = (s) => sourceReady(s, { google: google.signedIn });
const ytAuth = () => (google.signedIn ? (o) => google.getToken(o) : null);
const PUBLIC_DIR = 'Download/VidLearn';
const fsAdapter = FS ? {
  async download(url, path, onProgress) {
    const handle = await FS.addListener('progress', (p) => {
      if (p && p.url === url && p.contentLength > 0) onProgress(p.bytes / p.contentLength);
    });
    try {
      // התיקייה (videos/) חייבת להיות קיימת: downloadFile של התוסף (גרסה 7) מתעלם מ-recursive,
      // ובלעדיה כל הורדה נכשלה ב"קובץ לא נמצא"
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir) await FS.mkdir({ path: dir, directory: 'DATA', recursive: true }).catch(() => {}); // קיימת — בסדר
      await FS.downloadFile({ url, path, directory: 'DATA', progress: true, recursive: true });
      const { uri } = await FS.getUri({ path, directory: 'DATA' });
      return { uri };
    } finally {
      handle?.remove?.();
    }
  },
  async stat(path) { return Number((await FS.stat({ path, directory: 'DATA' })).size) || 0; },
  async remove(path) { await FS.deleteFile({ path, directory: 'DATA' }); },
  toSrc: (uri) => cap.convertFileSrc(uri),
  // עותק כקובץ רגיל בתיקיית ההורדות של הטלפון; לפרק — עם שם הספר / הפודקאסט
  async exportCopy(path, v) {
    const book = v.bookId ? findVideo(v.bookId) : null;
    const to = `${PUBLIC_DIR}/${publicFileName(v, path, book?.title || '')}`;
    await FS.mkdir({ path: PUBLIC_DIR, directory: 'EXTERNAL_STORAGE', recursive: true }).catch(() => {});
    const r = await FS.copy({ from: path, directory: 'DATA', to, toDirectory: 'EXTERNAL_STORAGE' });
    if (NATIVE && r?.uri) await NATIVE.scanFile({ path: r.uri }).catch(() => {}); // נראה בנגן המוזיקה ובגלריה
    return to;
  },
} : null;

// ---------- ניגון ברקע (אנדרואיד) ----------
// בזמן ניגון רץ שירות קדמה עם התראה, כדי שאנדרואיד לא יעצור את הניגון כשהמסך כבוי.
// עצירה מושהית: בסוף פרק עוברים לבא תוך רגע — לא עוצרים ומפעילים מחדש (מהרקע אסור להפעיל)
let bgOn = false;
let bgStopTimer = 0;
function bgPlaying(on, title = '', text = '') {
  if (!NATIVE) return;
  clearTimeout(bgStopTimer);
  if (on) {
    if (!bgOn) { bgOn = true; NATIVE.start({ title, text }).catch(() => { bgOn = false; }); }
  } else if (bgOn) {
    bgStopTimer = setTimeout(() => { bgOn = false; NATIVE.stop().catch(() => {}); }, 4000);
  }
}
// נגן שמע / וידאו ← ניגון ברקע כל עוד הוא מנגן
function keepPlayingInBackground(el, describe) {
  el.addEventListener('play', () => { const [t, s] = describe(); bgPlaying(true, t, s); });
  el.addEventListener('pause', () => bgPlaying(false));
  el.addEventListener('ended', () => bgPlaying(false));
}
const netAdapter = NET ? {
  async status() { const s = await NET.getStatus(); return { connected: s.connected, type: s.connectionType }; },
  onChange(fn) { NET.addListener('networkStatusChange', fn); },
} : null;

// מסך שמציג מצב הורדה נרשם כאן ומתעדכן (פעם אחת לפריים)
const dlWatchers = new Set();
let dlFrame = 0;
const downloads = createDownloads({
  store,
  fs: fsAdapter,
  network: netAdapter,
  resolveUrl: (v, quality) => resolveDirectFile(v, { quality }),
  onUpdate: () => {
    if (dlFrame) return;
    dlFrame = requestAnimationFrame(() => { dlFrame = 0; dlWatchers.forEach((fn) => fn()); });
  },
});

function dlLabel(id) {
  const d = store.getDownload(id);
  if (!d) return { text: tr('saveOffline'), state: 'none' };
  if (d.status === 'done') return { text: tr('savedOffline'), state: 'done' };
  if (d.status === 'downloading') return { text: tr('dlDownloading', Math.round((downloads.progressOf(id) || 0) * 100)), state: 'busy' };
  if (d.status === 'waiting') return { text: tr('dlWaiting'), state: 'busy' };
  if (d.status === 'queued') return { text: tr('dlQueued'), state: 'busy' };
  // הסיבה המדויקת (למשל "http-404") — כדי שאפשר יהיה לדעת מה השתבש
  const reason = d.error && d.error !== 'limit' && d.error !== 'failed' ? ` (${String(d.error).slice(0, 60)})` : '';
  return { text: d.error === 'limit' ? tr('dlLimit') : tr('dlFailed') + reason, state: 'error' };
}

// כפתור שמירה שמתעדכן לבד; onDone — למשל להחליף את הנגן לקובץ המקומי
function downloadButton(v) {
  if (!canDownload(v)) return h('p', { class: 'muted small' }, tr('dlNotSupported'));
  if (!downloads.available) return h('p', { class: 'muted small' }, tr('dlOnlyInApp'));
  const btn = h('button', { class: 'btn btn-sm', type: 'button' });
  const draw = () => {
    const l = dlLabel(v.id);
    btn.textContent = l.text;
    btn.setAttribute('aria-pressed', String(l.state === 'done'));
  };
  btn.addEventListener('click', () => {
    const l = dlLabel(v.id);
    if (l.state === 'none') downloads.enqueue(v);
    else if (l.state === 'error') downloads.retry(v.id);
    else confirmDialog(tr('dlConfirmRemove'), async () => { await downloads.remove(v.id); toast(tr('removed')); });
    draw();
  });
  draw();
  dlWatchers.add(draw);
  return btn;
}

// סימון נלמד / לא נלמד, כולל מחיקת הסרטון השמור אם הוגדר
function setLearned(id, done) {
  store.setDone(id, done);
  if (done) downloads.onLearned(id);
}

// שמירת מיקום; כשהיא מסמנת "נלמד" (90%) — כמו סימון ידני.
// onLearned: מה לעשות כשהסרטון נהיה "נלמד" (בנגן — דוחים את המחיקה עד היציאה מהמסך)
function savePosition(id, pos, dur, onLearned = () => downloads.onLearned(id)) {
  const was = !!store.getProgress(id)?.done;
  store.setPosition(id, pos, dur);
  if (!was && store.getProgress(id)?.done) onLearned();
}

function remember(v) { known.set(v.id, v); return v; }
function findVideo(id) {
  if (known.has(id)) return known.get(id);
  const s = store.state;
  const v = s.favorites.find((x) => x.id === id)
    || s.history.find((x) => x.video.id === id)?.video
    || s.courses.flatMap((c) => c.lessons).find((x) => x.id === id)
    || s.downloads[id]?.video;
  return v ? remember(v) : null;
}

function go(hash) { location.hash = hash; }
// כל פריט נפתח במסך שלו: סרטון ← נגן, ספר שמע ← השמעה, ספר ← קורא
const watchHash = itemHash;
const KIND_ICON = { audiobook: '🎧', podcast: '🎙️', book: '📖', chapter: '🎧' };

// ---------- כרטיס סרטון ----------
function videoCard(v, { courseId } = {}) {
  remember(v);
  const p = store.getProgress(v.id);
  const pct = p && p.dur ? Math.min(100, Math.round((p.pos / p.dur) * 100)) : 0;
  const thumb = safeUrl(v.thumb);
  return h('button', { class: 'card', type: 'button', onclick: () => go(watchHash(v, courseId)) },
    h('div', { class: 'thumb' },
      thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
      v.duration ? h('span', { class: 'dur' }, formatDuration(v.duration)) : null,
      p?.done ? h('span', { class: 'check' }, '✓ ' + tr('done')) : null,
      downloads.isSaved(v.id) ? h('span', { class: 'saved', title: tr('savedOffline'), 'aria-label': tr('savedOffline') }, '⬇') : null,
      pct && !p?.done ? h('span', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null,
    ),
    h('div', { class: 'meta' },
      h('span', { class: 'title' }, v.title),
      v.author ? h('span', { class: 'muted small' }, truncate(v.author, 60)) : null,
      h('span', {}, KIND_ICON[v.kind] ? h('span', { class: 'badge' }, KIND_ICON[v.kind]) : null, ' ', h('span', { class: 'badge' }, v.sourceName || v.sourceType)),
    ),
  );
}

const TYPES = [['video', '🎬', 'videos'], ['podcast', '🎙️', 'podcasts'], ['audiobook', '🎧', 'audiobooks'], ['book', '📖', 'books']];
let homeType = 'video'; // סוג התוכן שנבחר במסך הבית

function searchHash(q, type) {
  return `#/search?q=${encodeURIComponent(q)}${type && type !== 'video' ? `&type=${type}` : ''}`;
}

// מתג סוג התוכן: סרטונים / פודקאסטים / ספרי שמע / ספרים
function typeTabs(current, onPick) {
  return h('div', { class: 'tabs type-tabs', role: 'tablist' }, TYPES.map(([k, icon, label]) =>
    h('button', { class: 'btn btn-sm', type: 'button', role: 'tab', 'aria-pressed': String(current === k), onclick: () => onPick(k) }, `${icon} ${tr(label)}`)));
}

// מילות חיפוש של תחום ← לספרים (בלי "שיעור" / "הרצאה")
// פודקאסטים בממשק בעברית — בשם העברי (יש הרבה פודקאסטים לימודיים בעברית)
function subjectQuery(sub, type) {
  if (type === 'podcast') return store.state.settings.lang === 'he' ? sub.hq || sub.he : sub.en;
  return type === 'video' ? sub.q : sub.q.replace(/\b(lesson|lecture|course|tutorial)\b/g, '').trim();
}

function searchBar(initial = '', type = 'video') {
  const placeholder = { audiobook: tr('searchAudio'), book: tr('searchBooks'), podcast: tr('searchPodcasts') }[type] || tr('searchPlaceholder');
  const input = h('input', { type: 'search', value: initial, placeholder, 'aria-label': tr('search'), enterkeyhint: 'search' });
  const submit = () => { const q = input.value.trim(); if (q) go(searchHash(q, type)); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return h('div', { class: 'searchbar' }, input, h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, tr('searchBtn')));
}

// ---------- מסכים ----------
function renderHome() {
  const s = store.state;
  const cont = continueWatching(s).map(remember);
  const courses = s.courses.slice(0, 6);
  return [
    h('section', { class: 'hero' }, h('h1', {}, tr('appName')), h('p', {}, tr('tagline')), h('p', { class: 'muted small' }, VERSION),
      typeTabs(homeType, (k) => { homeType = k; route(); }), searchBar('', homeType)),
    cont.length ? [h('h2', {}, tr('continueLearning')), h('div', { class: 'hscroll' }, cont.map((v) => videoCard(v)))] : null,
    courses.length ? [h('h2', {}, tr('myCourses')), h('div', { class: 'hscroll' }, courses.map(courseCard))] : null,
    h('h2', {}, tr('subjects')),
    h('div', { class: 'subjects' }, SUBJECTS.map((sub) =>
      h('button', { class: 'subject', type: 'button', onclick: () => go(`${searchHash(subjectQuery(sub, homeType), homeType)}&subject=${sub.id}`) },
        h('span', { class: 'ic', 'aria-hidden': 'true' }, sub.icon), sub[store.state.settings.lang] || sub.he))),
  ];
}

function courseCard(c) {
  const pr = courseProgress(c, store.state.progress);
  const first = c.lessons[0];
  const thumb = first ? safeUrl(first.thumb) : '';
  return h('button', { class: 'card', type: 'button', onclick: () => go(`#/course/${encodeURIComponent(c.id)}`) },
    h('div', { class: 'thumb' }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
      h('span', { class: 'bar' }, h('i', { style: `width:${pr.pct}%` }))),
    h('div', { class: 'meta' }, h('span', { class: 'title' }, c.name),
      h('span', { class: 'muted small' }, `${tr('lessons', pr.total)} · ${pr.pct}%`)));
}

// ---------- ויקיפדיה: ערך לנושא החיפוש ----------
// מטמון לפי שאילתה: מעבר בין סוגי התוכן / חזרה מנגן לא מבקש שוב
const wikiCache = new Map();
function wikiFor(q) {
  const s = store.state.settings;
  const key = `${s.lang}|${s.extraBlock.join(',')}|${q}`;
  if (!wikiCache.has(key)) {
    const p = fetchWikiSummary(q, s);
    wikiCache.set(key, p);
    // אין ערך / אין רשת — לא נשמר: בחיפוש הבא מנסים שוב
    p.then((w) => { if (!w && wikiCache.get(key) === p) wikiCache.delete(key); });
    if (wikiCache.size > 30) wikiCache.delete(wikiCache.keys().next().value);
  }
  return wikiCache.get(key);
}
// בחיפוש בעברית — גם המונח באנגלית (מהקישור הבין-לשוני של הערך), אם לא כובה בהגדרות
function altFor(q) {
  if (!isHebrewQuery(q) || store.state.settings.crossLang === false) return Promise.resolve(null);
  return wikiFor(q).then((w) => (w && w.lang === 'he' && w.alt ? w.alt : null));
}

function wikiCard(q) {
  const box = h('div', {});
  wikiFor(q).then((w) => {
    if (!w) return;
    const dir = w.lang === 'he' || w.lang === 'ar' ? 'rtl' : 'ltr';
    const full = h('div', { class: 'wiki-article', hidden: true, dir, lang: w.lang });
    let loaded = false;
    const toggle = h('button', { class: 'btn btn-sm', type: 'button' }, tr('wikiReadFull'));
    toggle.addEventListener('click', async () => {
      if (!full.hidden) { full.hidden = true; toggle.textContent = tr('wikiReadFull'); return; }
      full.hidden = false;
      toggle.textContent = tr('wikiClose');
      if (loaded) return;
      fill(full, h('div', { class: 'spinner' }));
      try {
        const blocks = articleBlocks(await fetchWikiArticle(w));
        loaded = true;
        fill(full, blocks.map((b) => (b.type === 'h' ? h(b.level <= 2 ? 'h3' : 'h4', {}, b.text) : h('p', {}, b.text))));
      } catch {
        fill(full, h('div', { class: 'notice warn small' }, tr('wikiFailed')));
      }
    });
    const thumb = safeUrl(w.thumb);
    fill(box, h('section', { class: 'panel wiki' },
      h('div', { class: 'wiki-head' },
        thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        h('div', {},
          h('span', { class: 'badge' }, '📚 ' + tr('wikipedia')),
          h('h2', { dir, lang: w.lang }, w.title))),
      h('p', { class: 'wiki-extract', dir, lang: w.lang }, truncate(w.extract, 900)),
      h('div', { class: 'row' }, toggle,
        h('a', { class: 'btn btn-sm', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, '↗ ' + tr('openSource'))),
      full));
  });
  return box;
}

// יוטיוב כבוי — שם רוב סרטוני הלימוד בעברית. הסבר קצר ומעבר להגדרות
function youtubeHint() {
  const yt = store.state.settings.sources.find((s) => s.type === 'youtube');
  if (!yt || ready(yt)) return null;
  return h('div', { class: 'notice small' }, tr('youtubeOffHint'), ' ',
    google.available ? h('a', { class: 'btn btn-sm btn-primary', href: '#/settings?focus=google' }, tr('googleSignIn')) : null, ' ',
    h('a', { class: 'btn btn-sm', href: '#/settings?focus=youtube' }, tr('youtubeHowTo')));
}

function renderSearch(params) {
  const q = (params.get('q') || '').trim();
  const type = TYPES.some(([k]) => k === params.get('type')) ? params.get('type') : 'video';
  const wrap = h('div', {});
  wrap.append(typeTabs(type, (k) => go(q ? searchHash(q, k) : `#/search${k === 'video' ? '' : `?type=${k}`}`)), searchBar(q, type));
  // תחום לימוד: הערך לפי שם התחום בשפת הממשק (השאילתה עצמה באנגלית)
  const sub = SUBJECTS.find((x) => x.id === params.get('subject'));
  if (q) wrap.append(wikiCard(sub ? sub[store.state.settings.lang] || sub.he : q));
  if (type !== 'video') return renderMediaResults(type, q, wrap);
  if (!q) {
    wrap.append(h('p', { class: 'muted center' }, tr('tagline')));
    return wrap;
  }
  if (!store.state.settings.sources.some(ready)) {
    wrap.append(h('div', { class: 'notice warn' }, tr('noSourcesActive')));
    return wrap;
  }

  const filters = { source: 'all', length: 'any' };
  const results = h('div', {});
  const status = h('div', {});
  const more = h('div', { class: 'center' });
  const srcSel = h('select', { 'aria-label': tr('from') });
  const lenSel = h('select', { 'aria-label': 'length' },
    ['any', 'short', 'medium', 'long'].map((k) => h('option', { value: k }, tr(k === 'any' ? 'anyLength' : k))));
  srcSel.addEventListener('change', () => { filters.source = srcSel.value; draw(); });
  lenSel.addEventListener('change', () => { filters.length = lenSel.value; draw(); });
  wrap.append(h('div', { class: 'filters' }, srcSel, lenSel), status, results, more);

  const fitsLength = (v) => {
    const m = (v.duration || 0) / 60;
    if (filters.length === 'any') return true;
    if (!v.duration) return false;
    if (filters.length === 'short') return m < 10;
    if (filters.length === 'medium') return m >= 10 && m <= 40;
    return m > 40;
  };

  function draw() {
    const st = lastSearch;
    const names = [...new Set(st.items.map((v) => v.sourceName))];
    fill(srcSel, h('option', { value: 'all' }, tr('allSources')), ...names.map((n) => h('option', { value: n }, n)));
    srcSel.value = names.includes(filters.source) ? filters.source : 'all';
    const shown = st.items.filter((v) => (filters.source === 'all' || v.sourceName === filters.source) && fitsLength(v));
    fill(status,
      h('p', { class: 'muted small' }, tr('resultsInfo', st.items.length, st.searched)),
      st.alt ? h('p', { class: 'muted small' }, tr('altInfo', st.alt)) : null,
      isHebrewQuery(q) || st.items.length < 6 ? youtubeHint() : null,
      st.filtered ? h('p', { class: 'muted small' }, tr('filteredInfo', st.filtered)) : null,
      ...st.errors.map((e) => h('div', { class: 'notice warn small' }, tr('sourceFailed', e.source.name))),
    );
    fill(results, shown.length ? h('div', { class: 'cards' }, shown.map((v) => videoCard(v))) : h('p', { class: 'center muted' }, tr('noResults')));
    fill(more, st.hasMore ? h('button', { class: 'btn', type: 'button', onclick: loadMore }, tr('loadMore')) : '');
  }

  // הבקשה שייכת לתוצאות (st.loading), לא למסך: יציאה וחזרה באמצע לא שולחת אותה שוב,
  // והתוצאה מצוירת במסך הנוכחי
  async function loadMore() {
    const st = lastSearch;
    if (!st.loading) {
      st.loading = (async () => {
        try {
          const r = await searchAll(q, store.state.settings, { cursors: st.cursors, alt: st.alt, youtubeAuth: ytAuth() });
          const ids = new Set(st.items.map((v) => v.id));
          st.items.push(...r.items.filter((v) => !ids.has(v.id)).map(remember));
          st.cursors = { ...st.cursors, ...r.cursors };
          st.filtered += r.filtered;
          st.errors = r.errors;
        } catch {
          st.cursors = {}; // אין המשך — הכפתור נעלם
        } finally {
          st.hasMore = Object.values(st.cursors).some((c) => c !== null);
          st.loading = null;
        }
      })();
    }
    fill(more, h('div', { class: 'spinner' }));
    await st.loading;
    if (lastSearch === st && more.isConnected) draw();
  }

  if (lastSearch && lastSearch.q === q) {
    if (lastSearch.loading) loadMore(); else draw();
  } else {
    fill(results, h('div', { class: 'spinner' }), h('p', { class: 'center muted' }, tr('searching')));
    const token = {};
    lastSearch = token;
    // קודם התוצאות בשפת החיפוש; המונח באנגלית (ויקיפדיה + עוד חיפוש) נוסף כשהוא מגיע — לא מעכב
    const altP = altFor(q);
    searchAll(q, store.state.settings, { youtubeAuth: ytAuth() }).then((r) => {
      if (lastSearch !== token) return; // חיפוש חדש החליף אותו
      const st = { q, ...r, alt: null, items: r.items.map(remember), redraw: draw };
      lastSearch = st;
      draw();
      altP.then(async (alt) => {
        if (!alt || lastSearch !== st) return;
        const a = await searchAll(q, store.state.settings, { alt, altOnly: true, youtubeAuth: ytAuth() });
        if (lastSearch !== st) return;
        const ids = new Set(st.items.map((v) => v.id));
        st.items.push(...a.items.filter((v) => !ids.has(v.id)).map(remember));
        st.cursors = { ...st.cursors, ...a.cursors };
        st.hasMore = Object.values(st.cursors).some((c) => c !== null);
        st.filtered += a.filtered;
        st.alt = alt;
        st.redraw();
      }).catch(() => { /* בלי תוספת */ });
    });
  }
  if (lastSearch && lastSearch.q === q) lastSearch.redraw = draw; // המסך הנוכחי מתעדכן
  return wrap;
}

// תוצאות ספרי שמע / ספרים (מטמון לפי סוג ושאילתה — חזרה מהספר לא מחפשת שוב)
let lastMedia = null;
function renderMediaResults(type, q, wrap) {
  wrap.append(h('p', { class: 'muted small' }, tr({ audiobook: 'audioHint', podcast: 'podcastHint' }[type] || 'bookHint')));
  if (!q) return wrap;
  const results = h('div', {});
  const status = h('div', {});
  const more = h('div', { class: 'center' });
  wrap.append(status, results, more);
  const draw = () => {
    const st = lastMedia;
    fill(status, st.alt ? h('p', { class: 'muted small' }, tr('altInfo', st.alt)) : null,
      st.filtered ? h('p', { class: 'muted small' }, tr('filteredInfo', st.filtered)) : null,
      st.error ? h('div', { class: 'notice warn small' }, tr('bookFailed')) : null);
    fill(results, st.items.length ? h('div', { class: 'cards' }, st.items.map((v) => videoCard(v))) : st.error ? null : h('p', { class: 'center muted' }, tr('noResults')));
    fill(more, st.next !== null && !st.loading ? h('button', { class: 'btn', type: 'button', onclick: load }, tr('loadMore')) : st.loading ? h('div', { class: 'spinner' }) : null);
  };
  async function load() {
    const st = lastMedia;
    if (!st.loading) {
      st.loading = (async () => {
        try {
          // ספרי שמע וספרים: בעמוד הראשון — המונח באנגלית ברקע (לא מעכב); בהמשך — עם העמוד
          const r = await searchMedia(type, q, store.state.settings, { page: st.page, alt: st.alt || '' });
          if (st.page === 0 && type !== 'podcast') addAlt(st);
          const ids = new Set(st.items.map((v) => v.id));
          st.items.push(...r.items.filter((v) => !ids.has(v.id)).map(remember));
          st.filtered += r.filtered;
          st.next = r.next;
          st.page = r.next ?? st.page;
          st.error = false;
        } catch {
          st.error = true;
          st.next = st.items.length ? st.next : null;
        } finally {
          st.loading = null;
        }
      })();
    }
    draw();
    await st.loading;
    if (lastMedia === st && results.isConnected) draw();
  }
  // תוצאות המונח באנגלית לעמוד הראשון (ספרי שמע וספרים)
  function addAlt(st) {
    altFor(q).then(async (alt) => {
      if (!alt || lastMedia !== st) return;
      const r = await searchMedia(type, alt, store.state.settings, { page: 0 });
      if (lastMedia !== st) return;
      const ids = new Set(st.items.map((v) => v.id));
      st.items.push(...r.items.filter((v) => !ids.has(v.id)).map(remember));
      st.filtered += r.filtered;
      st.alt = alt;
      if (st.next === null && r.next !== null) st.next = 1;
      if (!st.loading) st.redraw();
    }).catch(() => { /* בלי תוספת */ });
  }
  if (lastMedia) lastMedia.redraw = draw;
  if (!lastMedia || lastMedia.type !== type || lastMedia.q !== q) {
    lastMedia = { type, q, items: [], page: 0, next: 0, filtered: 0, error: false, loading: null, alt: null, redraw: draw };
    load();
  } else if (lastMedia.loading) {
    load();
  } else {
    draw();
  }
  return wrap;
}

function renderLibrary(params) {
  const tab = params.get('tab') || 'courses';
  const s = store.state;
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    ['courses', 'downloads', 'favorites', 'history'].map((k) => h('a', { class: 'btn btn-sm', role: 'tab', href: `#/library?tab=${k}`, 'aria-pressed': String(tab === k) },
      tr(k === 'courses' ? 'myCourses' : k))));
  let body;
  if (tab === 'downloads') {
    body = renderDownloads();
  } else if (tab === 'favorites') {
    body = s.favorites.length ? h('div', { class: 'cards' }, s.favorites.map((v) => videoCard(v))) : h('p', { class: 'muted center' }, '—');
  } else if (tab === 'history') {
    body = s.history.length
      ? [h('div', { class: 'row' }, h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => { store.clearHistory(); route(); } }, tr('clearHistory'))),
        h('div', { class: 'cards', style: 'margin-top:12px' }, s.history.map((x) => videoCard(x.video)))]
      : h('p', { class: 'muted center' }, '—');
  } else {
    body = [
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newCourseDialog() }, '＋ ' + tr('newCourse'))),
      s.courses.length ? h('div', { class: 'cards', style: 'margin-top:12px' }, s.courses.map(courseCard)) : h('p', { class: 'muted' }, tr('noCourses')),
    ];
  }
  return [h('h1', {}, tr('library')), tabs, body];
}

// מסך "שמורים בטלפון": נפח, התקדמות, מחיקה וניסיון חוזר.
// בזמן הורדה מתעדכנות רק התוויות — הרשימה נבנית מחדש רק כשהמבנה משתנה,
// אחרת לחיצה על כפתור באמצע עדכון הייתה הולכת לאיבוד.
function renderDownloads() {
  if (!downloads.available) return h('p', { class: 'muted' }, tr('dlOnlyInApp'));
  const box = h('div', {});
  let shape = '';
  const labels = new Map(); // id ← הטקסט שמתעדכן
  const draw = () => {
    const list = downloads.list();
    const nextShape = list.map((d) => `${d.video.id}:${dlLabel(d.video.id).state}`).join('|');
    if (nextShape === shape) {
      for (const d of list) {
        const el = labels.get(d.video.id);
        if (el && d.status !== 'done') el.textContent = dlLabel(d.video.id).text;
      }
      return;
    }
    shape = nextShape;
    labels.clear();
    const limit = downloads.limitBytes();
    const used = downloads.usedBytes();
    fill(box,
      h('p', { class: 'muted small' }, tr('dlUsed', formatBytes(used), formatBytes(limit))),
      h('div', { class: 'progress' }, h('i', { style: `width:${Math.min(100, Math.round((used / limit) * 100))}%` })),
      list.length ? h('div', { class: 'panel' }, list.map((d) => {
        const v = remember(d.video);
        const l = dlLabel(v.id);
        const label = h('span', { class: 'muted small' }, l.state === 'done' ? [formatBytes(d.size), formatDuration(v.duration), v.sourceName, d.publicPath ? `📂 ${d.publicPath.split('/').slice(0, -1).join('/')}` : ''].filter(Boolean).join(' · ') : l.text);
        labels.set(v.id, label);
        return h('div', { class: 'lesson' },
          h('span', { class: `num${l.state === 'done' ? ' ok' : l.state === 'error' ? '' : ' cur'}` }, l.state === 'done' ? '✓' : l.state === 'error' ? '!' : '⬇'),
          h('div', { class: 'info', onclick: () => go(watchHash(v)) }, h('b', {}, v.title), label),
          h('div', { class: 'tools' },
            l.state === 'error' ? h('button', { type: 'button', 'aria-label': tr('dlFailed'), title: tr('dlFailed'), onclick: () => downloads.retry(v.id) }, '↻') : null,
            // עותק בתיקיית ההורדות של הטלפון (לקובץ ששמרנו לפני שהאפשרות הייתה, או אחרי שנמחק משם)
            l.state === 'done' && downloads.canExport ? h('button', {
              type: 'button', 'aria-label': tr('dlExport'), title: tr('dlExport'),
              onclick: async () => {
                try { const p = await downloads.exportToDevice(v.id); toast(tr('dlExported', p)); shape = ''; draw(); } catch { toast(tr('dlExportFailed')); }
              },
            }, '📂') : null,
            h('button', { type: 'button', 'aria-label': tr('dlRemove'), title: tr('dlRemove'), onclick: () => confirmDialog(tr('dlConfirmRemove'), () => downloads.remove(v.id)) }, '🗑')));
      })) : h('p', { class: 'muted' }, tr('noDownloads')),
    );
  };
  draw();
  dlWatchers.add(draw);
  return box;
}

function renderCourse(id) {
  const c = store.state.courses.find((x) => x.id === id);
  if (!c) return h('p', { class: 'center muted' }, '—');
  const pr = courseProgress(c, store.state.progress);
  const next = pr.nextIndex >= 0 ? c.lessons[pr.nextIndex] : null;
  return [
    h('h1', {}, c.name),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pr.pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pr.pct}%` })),
    h('p', { class: 'muted small' }, `${pr.done}/${pr.total} · ${pr.pct}%`),
    h('div', { class: 'row' },
      next ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go(watchHash(next, c.id)) }, pr.done ? tr('continueCourse') : tr('startCourse')) : null,
      !next && pr.total ? h('span', { class: 'badge' }, tr('courseDone')) : null,
      downloads.available && c.lessons.some(canDownload)
        ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { toast(tr('courseQueued', downloads.saveCourse(c))); route(); } }, tr('saveCourse')) : null,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => renameDialog(c) }, tr('rename')),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => confirmDialog(tr('confirmDeleteCourse'), () => { store.deleteCourse(c.id); go('#/library'); }) }, tr('deleteCourse')),
    ),
    h('div', { class: 'panel' }, c.lessons.length ? c.lessons.map((l, i) => {
      remember(l);
      const done = !!store.state.progress[l.id]?.done;
      return h('div', { class: 'lesson' },
        h('span', { class: `num${done ? ' ok' : i === pr.nextIndex ? ' cur' : ''}` }, done ? '✓' : String(i + 1)),
        h('div', { class: 'info', onclick: () => go(watchHash(l, c.id)) },
          h('b', {}, l.title), h('span', { class: 'muted small' }, [downloads.isSaved(l.id) ? '⬇' : '', formatDuration(l.duration), l.sourceName].filter(Boolean).join(' · '))),
        h('div', { class: 'tools' },
          h('button', { type: 'button', 'aria-label': tr('moveUp'), title: tr('moveUp'), onclick: () => { store.moveLesson(c.id, i, -1); route(); } }, '▲'),
          h('button', { type: 'button', 'aria-label': tr('moveDown'), title: tr('moveDown'), onclick: () => { store.moveLesson(c.id, i, 1); route(); } }, '▼'),
          h('button', { type: 'button', 'aria-label': tr('remove'), title: tr('remove'), onclick: () => { store.removeLesson(c.id, l.id); route(); } }, '✕')));
    }) : h('p', { class: 'muted' }, tr('emptyCourse'))),
  ];
}

function renderWatch(id, params) {
  const v = findVideo(id);
  if (!v) return h('p', { class: 'center muted' }, '—');
  const courseId = params.get('course');
  const course = courseId ? store.state.courses.find((c) => c.id === courseId) : null;
  store.addHistory(v);

  const player = h('div', { class: 'player' }, h('span', {}, tr('loadingPlayer')));
  const speedRow = h('div', { class: 'row', style: 'margin-top:8px' });
  const embedNote = h('div', { class: 'notice small', hidden: true }, tr('embedNotice'));
  const offlineNote = h('div', { class: 'notice small', hidden: true }, tr('playingOffline'));
  let videoEl = null;
  let disposed = false;
  let learnedWhilePlaying = false; // נלמד ב-90% — הקובץ השמור נמחק (אם הוגדר) רק ביציאה, לא באמצע הצפייה
  const markLearned = () => { learnedWhilePlaying = true; };
  let lastSaved = 0;

  function mountVideo(url, { local = false } = {}) {
    offlineNote.hidden = !local;
    embedNote.hidden = true;
    videoEl = h('video', { src: url, controls: true, playsinline: true, preload: 'metadata' });
    keepPlayingInBackground(videoEl, () => [v.title, v.sourceName || '']);
    const p = store.getProgress(v.id);
    videoEl.addEventListener('loadedmetadata', () => {
      if (p?.pos && !p.done && p.pos < videoEl.duration - 10) videoEl.currentTime = p.pos;
    });
    videoEl.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - lastSaved > 5000) { lastSaved = now; savePosition(v.id, videoEl.currentTime, videoEl.duration, markLearned); }
    });
    videoEl.addEventListener('pause', () => savePosition(v.id, videoEl.currentTime, videoEl.duration, markLearned));
    videoEl.addEventListener('ended', () => { setLearned(v.id, true); drawActions(); offerNext(); });
    // קובץ מקומי שנפגע / נמחק ← מהרשת; קובץ ישיר שנכשל ← הנגן המוטמע
    videoEl.addEventListener('error', () => { if (local) mountOnline(); else if (v.play.kind === 'iframe') mountIframe(); }, { once: true });
    fill(player, videoEl);
    fill(speedRow, h('span', { class: 'muted small' }, tr('speed') + ':'),
      [0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => h('button', {
        class: 'btn btn-sm', type: 'button', 'aria-pressed': String(r === 1),
        onclick: (e) => { videoEl.playbackRate = r; speedRow.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); },
      }, `${r}×`)));
    drawNotes();
  }

  function mountIframe() {
    videoEl = null;
    const url = safeUrl(v.play.url);
    fill(player, url ? h('iframe', {
      src: url, title: v.title, allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin',
      allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
      sandbox: 'allow-scripts allow-same-origin allow-presentation',
    }) : h('span', {}, '—'));
    fill(speedRow, );
    embedNote.hidden = false;
    drawNotes();
  }

  async function mountOnline() {
    offlineNote.hidden = true;
    if (v.play.kind === 'video' && safeUrl(v.play.url)) return mountVideo(v.play.url);
    const direct = v.sourceType === 'archive' || v.sourceType === 'peertube' ? await resolveDirect(v) : '';
    if (disposed) return;
    if (direct) mountVideo(direct); else mountIframe();
  }

  // בקורס — השיעור הבא יורד מראש
  if (course) {
    const pre = downloads.prefetchNext(course, v.id);
    if (pre) toast(tr('nextPrefetched', truncate(pre.title, 40)));
  }
  const dlBtn = downloadButton(v);

  const actions = h('div', { class: 'row', style: 'margin-top:10px' });
  function drawActions() {
    const fav = store.isFavorite(v.id);
    const done = !!store.getProgress(v.id)?.done;
    const page = safeUrl(v.pageUrl);
    fill(actions, 
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(done), onclick: () => { setLearned(v.id, !done); drawActions(); if (!done) offerNext(); } }, done ? '✓ ' + tr('done') : tr('markDone')),
      dlBtn,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addToCourseDialog(v) }, '＋ ' + tr('addToCourse')),
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(fav), onclick: () => { store.toggleFavorite(v); drawActions(); } }, fav ? '★ ' + tr('unfavorite') : '☆ ' + tr('favorite')),
      page ? h('a', { class: 'btn btn-sm', href: page, target: '_blank', rel: 'noopener noreferrer' }, '↗ ' + tr('openSource')) : null,
    );
  }
  drawActions();

  const nextBox = h('div', {});
  function offerNext() {
    if (!course) return;
    const i = course.lessons.findIndex((l) => l.id === v.id);
    const n = i >= 0 ? course.lessons[i + 1] : null; // הסרטון כבר לא בקורס — אין "הבא"
    fill(nextBox, n ? h('div', { class: 'panel' }, h('b', {}, '⏭ '), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go(watchHash(n, course.id)) }, `${i + 2}. ${truncate(n.title, 60)}`)) : '');
  }

  // הערות
  const notesList = h('div', {});
  const noteInput = h('textarea', { placeholder: tr('notePlaceholder'), 'aria-label': tr('addNote') });
  const atTime = h('input', { type: 'checkbox', class: 'switch', checked: true, id: 'noteAtTime' });
  const atTimeLabel = h('label', { class: 'check small', for: 'noteAtTime' }, atTime, tr('noteAtTime'));
  function drawNotes() {
    atTimeLabel.hidden = !videoEl;
    const notes = store.notesFor(v.id);
    fill(notesList, notes.length ? notes.map((n) => h('div', { class: 'note' },
      n.t != null ? h('button', { class: 'btn btn-sm time', type: 'button', onclick: () => { if (videoEl) { videoEl.currentTime = n.t; videoEl.play().catch(() => {}); } } }, formatDuration(n.t) || '0:00') : null,
      h('p', {}, n.text),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('remove'), onclick: () => { store.deleteNote(v.id, n.id); drawNotes(); } }, '🗑'),
    )) : h('p', { class: 'muted small' }, tr('noNotes')));
  }
  const addNote = () => {
    const tm = videoEl && atTime.checked ? videoEl.currentTime : null;
    if (store.addNote(v.id, noteInput.value, tm)) { noteInput.value = ''; drawNotes(); }
  };

  const courseList = course ? h('div', { class: 'panel' }, h('b', {}, course.name),
    course.lessons.map((l, i) => {
      const done = !!store.state.progress[l.id]?.done;
      const cur = l.id === v.id;
      return h('div', { class: 'lesson' },
        h('span', { class: `num${done ? ' ok' : cur ? ' cur' : ''}` }, done ? '✓' : String(i + 1)),
        h('div', { class: 'info', onclick: () => { if (!cur) go(watchHash(l, course.id)); } }, h('b', {}, l.title)),
        downloads.isSaved(l.id) ? h('span', { class: 'muted', title: tr('savedOffline'), 'aria-label': tr('savedOffline') }, '⬇') : null);
    })) : null;

  // הנגן נטען אחרי שכל חלקי המסך (גם ההערות) קיימים — סרטון שמור נטען מיד, בלי רשת
  const localSrc = downloads.localSrc(v.id);
  if (localSrc) mountVideo(localSrc, { local: true }); else mountOnline();

  cleanupView = () => {
    disposed = true;
    if (videoEl && videoEl.duration) savePosition(v.id, videoEl.currentTime, videoEl.duration, markLearned);
    if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); }
    if (learnedWhilePlaying) setTimeout(() => downloads.onLearned(v.id), 0); // אחרי שהנגן שחרר את הקובץ
  };

  return [
    player, speedRow, embedNote, offlineNote,
    h('h1', { class: 'watch-title' }, v.title),
    h('p', { class: 'muted small' }, [v.author && `${tr('by')} ${v.author}`, v.sourceName, formatDuration(v.duration)].filter(Boolean).join(' · ')),
    actions, nextBox,
    v.description ? h('div', { class: 'desc' }, truncate(v.description, 1500)) : null,
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, '📝 ' + tr('notes')), notesList, noteInput, atTimeLabel,
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: addNote }, tr('addNote'))),
    courseList,
  ];
}

// ---------- ספר שמע ----------
function mediaHead(book) {
  const thumb = safeUrl(book.thumb);
  return h('div', { class: 'media-head' },
    thumb ? h('img', { src: thumb, alt: '', referrerpolicy: 'no-referrer' }) : null,
    h('div', {},
      h('h1', { class: 'watch-title' }, book.title),
      h('p', { class: 'muted small' }, [book.author && `${tr('by')} ${book.author}`, book.sourceName, formatDuration(book.duration)].filter(Boolean).join(' · '))));
}

// כפתורי פעולה משותפים לספר שמע ולספר: מועדף, קורס, סימון נלמד, אתר המקור
function mediaActions(book, onDoneChange) {
  const row = h('div', { class: 'row', style: 'margin-top:10px' });
  const draw = () => {
    const fav = store.isFavorite(book.id);
    const done = !!store.getProgress(book.id)?.done;
    const page = safeUrl(book.pageUrl);
    fill(row,
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(done), onclick: () => { setLearned(book.id, !done); draw(); onDoneChange?.(); } }, done ? '✓ ' + tr('done') : tr('markDone')),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addToCourseDialog(book) }, '＋ ' + tr('addToCourse')),
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(fav), onclick: () => { store.toggleFavorite(book); draw(); } }, fav ? '★ ' + tr('unfavorite') : '☆ ' + tr('favorite')),
      page ? h('a', { class: 'btn btn-sm', href: page, target: '_blank', rel: 'noopener noreferrer' }, '↗ ' + tr('openSource')) : null);
  };
  draw();
  return row;
}

function renderListen(id, params) {
  const book = findVideo(id);
  if (!book) return h('p', { class: 'center muted' }, '—');
  store.addHistory(book);
  const startCh = params.has('ch') ? Number(params.get('ch')) : null;
  const startEp = params.get('ep'); // פרק פודקאסט — לפי המזהה
  const isPodcast = book.kind === 'podcast';
  const descBox = h('p', { class: 'desc' }, truncate(book.description, 600));
  const epDesc = h('p', { class: 'muted small' });

  const audio = h('audio', { controls: true, preload: 'metadata', class: 'audio' });
  const nowTitle = h('b', {});
  const offlineNote = h('div', { class: 'notice small', hidden: true }, tr('listenOffline'));
  const chapterDl = h('span', {});
  const controls = h('div', { class: 'row', style: 'margin-top:8px' });
  const listBox = h('div', { class: 'panel' });
  const notesBox = h('div', { class: 'panel' });
  const body = h('div', {}, h('div', { class: 'spinner' }), h('p', { class: 'center muted' }, tr('loadingBook')));
  let chapters = store.getChapters(book.id);
  let cur = -1;
  let lastSaved = 0;
  let sleepTimer = null;
  let sleepEnd = false;
  let disposed = false;

  const chapterOf = () => chapters[cur];
  function saveChapterPos() {
    const c = chapterOf();
    if (c && audio.duration) store.setPosition(c.id, audio.currentTime, audio.duration);
  }
  // התקדמות הספר כולו: הפרק הנוכחי מתוך כולם; נלמד כשכל הפרקים נלמדו
  function drawNowTitle() {
    const c = chapterOf();
    if (c) nowTitle.textContent = `${tr(isPodcast ? 'episode' : 'chapter')} ${cur + 1}/${chapters.length} — ${c.title}`;
  }
  function updateBook() {
    const doneCount = chapters.filter((c) => store.getProgress(c.id)?.done).length;
    const all = chapters.length > 0 && doneCount === chapters.length;
    const was = !!store.getProgress(book.id)?.done;
    store.setProgress(book.id, { pos: cur + 1, dur: chapters.length, done: was || all });
  }

  function play(i, { autoplay = true } = {}) {
    if (!chapters[i]) return;
    saveChapterPos();
    cur = i;
    const c = chapters[i];
    const local = downloads.localSrc(c.id);
    offlineNote.hidden = !local;
    audio.src = local || c.play.url;
    audio.dataset.local = local ? '1' : '';
    const p = store.getProgress(c.id);
    audio.onloadedmetadata = () => { if (p?.pos && !p.done && p.pos < audio.duration - 5) audio.currentTime = p.pos; };
    if (autoplay) audio.play().catch(() => {});
    drawNowTitle();
    epDesc.textContent = truncate(c.description, 400);
    fill(chapterDl, downloadButton(c));
    updateBook();
    drawList();
    drawNotes();
  }

  audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastSaved > 5000) { lastSaved = now; saveChapterPos(); }
  });
  audio.addEventListener('pause', saveChapterPos);
  keepPlayingInBackground(audio, () => [book.title, chapterOf()?.title || '']);
  audio.addEventListener('ended', () => {
    const c = chapterOf();
    if (c) store.setDone(c.id, true);
    updateBook();
    if (sleepEnd) { sleepEnd = false; drawList(); return; } // טיימר "סוף הפרק"
    if (cur + 1 < chapters.length) play(cur + 1); else drawList();
  });
  // קובץ שמור שנפגע ← מהרשת
  audio.addEventListener('error', () => {
    const c = chapterOf();
    if (audio.dataset.local && c) { audio.dataset.local = ''; offlineNote.hidden = true; audio.src = c.play.url; audio.play().catch(() => {}); }
  });

  function setSleep(val) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepEnd = val === 'end';
    if (val === 'end') toast(tr('sleepEndSet'));
    else if (Number(val) > 0) {
      sleepTimer = setTimeout(() => audio.pause(), Number(val) * 60000);
      toast(tr('sleepSet', val));
    }
  }
  const sleepSel = h('select', { class: 'input', 'aria-label': tr('sleepTimer'), style: 'width:auto' },
    h('option', { value: '0' }, `🌙 ${tr('sleepTimer')}: ${tr('sleepOff')}`),
    ['15', '30', '60'].map((m) => h('option', { value: m }, `🌙 ${m} ${tr('min')}`)),
    h('option', { value: 'end' }, `🌙 ${tr('sleepEnd')}`));
  sleepSel.addEventListener('change', () => setSleep(sleepSel.value));
  fill(controls,
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { audio.currentTime = Math.max(0, audio.currentTime - 30); } }, tr('back30')),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); } }, tr('fwd30')),
    [0.75, 1, 1.25, 1.5, 2].map((r) => h('button', {
      class: 'btn btn-sm', type: 'button', 'aria-pressed': String(r === 1),
      onclick: (e) => { audio.playbackRate = r; controls.querySelectorAll('[data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); },
      'data-rate': r,
    }, `${r}×`)),
    sleepSel);

  function drawList() {
    if (!chapters) return;
    fill(listBox, h('h2', { style: 'margin-top:0' }, `${tr(isPodcast ? 'episodes' : 'chapters')} (${chapters.length})`),
      chapters.map((c, i) => {
        const p = store.getProgress(c.id);
        const isCur = i === cur;
        return h('div', { class: 'lesson' },
          h('span', { class: `num${p?.done ? ' ok' : isCur ? ' cur' : ''}` }, p?.done ? '✓' : String(i + 1)),
          h('div', { class: 'info', onclick: () => play(i) },
            h('b', {}, (isCur ? '▶ ' : '') + c.title),
            h('span', { class: 'muted small' }, [downloads.isSaved(c.id) ? '⬇' : '', c.date ? new Date(c.date).toLocaleDateString(store.state.settings.lang === 'en' ? 'en' : 'he-IL') : '', formatDuration(c.duration), p && !p.done && p.dur ? `${Math.round((p.pos / p.dur) * 100)}%` : ''].filter(Boolean).join(' · '))));
      }));
  }

  // הערות לפי פרק וזמן
  function drawNotes() {
    const c = chapterOf();
    if (!c) return;
    const input = h('textarea', { placeholder: tr('notePlaceholder'), 'aria-label': tr('addNote') });
    const notes = store.notesFor(c.id);
    fill(notesBox, h('h2', { style: 'margin-top:0' }, `📝 ${tr('notes')} — ${tr(isPodcast ? 'episode' : 'chapter')} ${cur + 1}`),
      notes.length ? notes.map((n) => h('div', { class: 'note' },
        n.t != null ? h('button', { class: 'btn btn-sm time', type: 'button', onclick: () => { audio.currentTime = n.t; audio.play().catch(() => {}); } }, formatDuration(n.t) || '0:00') : null,
        h('p', {}, n.text),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('remove'), onclick: () => { store.deleteNote(c.id, n.id); drawNotes(); } }, '🗑'))) : h('p', { class: 'muted small' }, tr('noNotes')),
      input,
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => { if (store.addNote(c.id, input.value, audio.currentTime)) drawNotes(); } }, tr('addNote')));
  }

  function start() {
    if (disposed) return;
    if (!chapters.length) {
      // אין קבצי שמע (לא LibriVox) — הנגן של הארכיון
      if (isPodcast) { fill(body, h('div', { class: 'notice warn' }, tr('noEpisodes'))); return; }
      fill(body, h('div', { class: 'player' }, h('iframe', { src: safeUrl(book.play.url), title: book.title, allowfullscreen: true, sandbox: 'allow-scripts allow-same-origin allow-presentation' })));
      return;
    }
    const prog = store.getProgress(book.id);
    const firstOpen = chapters.findIndex((c) => !store.getProgress(c.id)?.done);
    // פודקאסט: פרקים חדשים נוספים בראש הרשימה ומזיזים את המספור — ממשיכים בפרק האחרון ששמענו
    // הפרק האחרון ששמענו; אם סיימנו אותו — הבא בתור (כמו המעבר האוטומטי בסוף פרק)
    const lastHeard = () => {
      let best = -1;
      let at = 0;
      chapters.forEach((c, j) => { const p = store.getProgress(c.id); if (p && (p.at || 0) > at) { at = p.at; best = j; } });
      if (best < 0) return 0;
      return store.getProgress(chapters[best].id).done && chapters[best + 1] ? best + 1 : best;
    };
    const epIndex = startEp ? chapters.findIndex((c) => c.id === startEp) : -1;
    const i = epIndex >= 0 ? epIndex
      : startCh !== null && chapters[startCh] ? startCh
      : isPodcast ? lastHeard()
        : prog?.pos >= 1 && chapters[prog.pos - 1] ? prog.pos - 1 : Math.max(0, firstOpen);
    fill(body,
      h('div', { class: 'panel' }, nowTitle, epDesc, audio, offlineNote, controls,
        h('div', { class: 'row', style: 'margin-top:8px' }, chapterDl,
          downloads.available && !isPodcast ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { let n = 0; chapters.forEach((c) => { if (downloads.enqueue(c) === 'queued') n++; }); toast(tr('bookQueued', n)); drawList(); } }, tr('saveBook')) : null),
        h('p', { class: 'muted small' }, tr('bgAudioNote'))),
      listBox, notesBox);
    play(i, { autoplay: false });
  }

  function load() {
    fill(body, h('div', { class: 'spinner' }), h('p', { class: 'center muted' }, tr('loadingBook')));
    const loader = isPodcast
      ? fetchPodcastEpisodes(book).then((feed) => {
        if (feed.description && !book.description) { book.description = feed.description; descBox.textContent = truncate(feed.description, 600); }
        return feed.episodes;
      })
      : fetchArchiveMetadata(book).then((meta) => parseAudioChapters(book, meta));
    loader.then((list) => {
      if (disposed) return;
      chapters = list;
      store.setChapters(book.id, chapters);
      start();
    }).catch(() => {
      if (disposed) return;
      fill(body, h('div', { class: 'notice warn' }, tr('bookFailed')), h('button', { class: 'btn', type: 'button', onclick: load }, tr('retry')));
    });
  }
  // פודקאסט מתעדכן: מציגים את הרשימה השמורה מיד (גם בלי רשת), ומרעננים מהפיד ברקע
  if (chapters) {
    setTimeout(start, 0);
    if (isPodcast) {
      fetchPodcastEpisodes(book).then((feed) => {
        if (disposed || !feed.episodes.length) return;
        const changed = feed.episodes.length !== chapters.length || feed.episodes[0]?.id !== chapters[0]?.id;
        if (!changed) return;
        const curId = chapterOf()?.id;
        const j = feed.episodes.findIndex((c) => c.id === curId);
        if (curId && j < 0) return; // הפרק שמתנגן ירד מהפיד — לא מחליפים באמצע
        chapters = feed.episodes;
        store.setChapters(book.id, chapters);
        if (j >= 0) cur = j;
        drawNowTitle();
        if (cur >= 0) updateBook();
        drawList();
      }).catch(() => { /* בלי רשת — הרשימה השמורה */ });
    }
  } else load();

  dlWatchers.add(drawList);
  cleanupView = () => {
    disposed = true;
    saveChapterPos();
    clearTimeout(sleepTimer);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };

  return [mediaHead(book), mediaActions(book, drawList), descBox, body];
}

// ---------- קורא ספרים ----------
const bookCache = new Map(); // id ← { pages, dir, ocr } — חזרה לספר באותה הפעלה בלי להוריד שוב

function renderRead(id) {
  const book = findVideo(id);
  if (!book) return h('p', { class: 'center muted' }, '—');
  store.addHistory(book);

  const body = h('div', {});
  let disposed = false;
  let mode = 'text'; // text / scanned

  function scannedView(reason) {
    mode = 'scanned';
    const url = safeUrl(book.play.url);
    fill(body,
      h('div', { class: 'notice small' }, reason || tr('scannedBook')),
      bookCache.has(book.id) ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => showText(bookCache.get(book.id)) }, tr('openText')) : null,
      url ? h('div', { class: 'player book-frame' }, h('iframe', { src: url, title: book.title, allowfullscreen: true, sandbox: 'allow-scripts allow-same-origin allow-presentation' })) : null);
  }

  function showText(data) {
    mode = 'text';
    const { pages, dir, ocr, local } = data;
    const prog = store.getProgress(book.id);
    let page = prog?.pos >= 1 ? Math.min(pages.length - 1, prog.pos - 1) : 0;
    const article = h('article', { class: 'reader', dir, lang: dir === 'rtl' ? 'he' : 'en' });
    const labels = [h('span', { class: 'muted small' }), h('span', { class: 'muted small' })]; // למעלה ולמטה
    const slider = h('input', { type: 'range', min: 1, max: pages.length, value: page + 1, 'aria-label': tr('jumpToPage'), class: 'page-slider' });
    const notesBox = h('div', {});
    const setFont = (px) => { article.style.fontSize = `${px}px`; };
    setFont(store.state.settings.readerFont || 19);

    function show(i, { scroll = true } = {}) {
      page = Math.max(0, Math.min(pages.length - 1, i));
      article.textContent = pages[page];
      labels.forEach((l) => { l.textContent = tr('page', page + 1, pages.length); });
      slider.value = page + 1;
      const was = !!store.getProgress(book.id)?.done;
      store.setProgress(book.id, { pos: page + 1, dur: pages.length, done: was || page + 1 >= pages.length });
      if (scroll) article.scrollIntoView({ block: 'start' });
    }
    slider.addEventListener('change', () => show(Number(slider.value) - 1));

    // החלקה: בספר מימין לשמאל — החלקה ימינה = העמוד הבא
    let x0 = null;
    article.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    article.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) < 60) return;
      const forward = dir === 'rtl' ? dx > 0 : dx < 0;
      show(page + (forward ? 1 : -1));
    });

    function drawNotes() {
      const input = h('textarea', { placeholder: tr('notePlaceholder'), 'aria-label': tr('addNote') });
      const notes = store.notesFor(book.id);
      fill(notesBox, h('h2', { style: 'margin-top:0' }, '🔖 ' + tr('bookmarks')),
        notes.length ? notes.map((n) => h('div', { class: 'note' },
          n.t != null ? h('button', { class: 'btn btn-sm time', type: 'button', onclick: () => show(n.t) }, tr('notePage', n.t + 1)) : null,
          h('p', {}, n.text),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('remove'), onclick: () => { store.deleteNote(book.id, n.id); drawNotes(); } }, '🗑'))) : h('p', { class: 'muted small' }, tr('noNotes')),
        input,
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => { if (store.addNote(book.id, input.value || tr('bookmark').replace('🔖 ', ''), page)) drawNotes(); } }, tr('bookmark'))));
    }

    const nav = (label) => h('div', { class: 'reader-nav' },
      h('button', { class: 'btn', type: 'button', onclick: () => show(page - 1) }, tr('prevPage')),
      label,
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => show(page + 1) }, tr('nextPage')));
    const navTop = nav(labels[0]);
    const navBottom = nav(labels[1]);

    fill(body,
      local ? h('div', { class: 'notice small' }, tr('readingOffline')) : null,
      ocr ? h('div', { class: 'notice small' }, tr('ocrNote'), ' ', h('button', { class: 'btn btn-sm', type: 'button', onclick: () => scannedView() }, tr('openScanned'))) : null,
      h('div', { class: 'row reader-tools' },
        h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': tr('fontSmaller'), title: tr('fontSmaller'), onclick: () => { const f = Math.max(14, (store.state.settings.readerFont || 19) - 2); store.setSetting('readerFont', f); setFont(f); } }, 'A−'),
        h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': tr('fontBigger'), title: tr('fontBigger'), onclick: () => { const f = Math.min(32, (store.state.settings.readerFont || 19) + 2); store.setSetting('readerFont', f); setFont(f); } }, 'A+'),
        downloadButton(book),
        !ocr ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => scannedView() }, tr('openScanned')) : null),
      navTop, slider, article, navBottom,
      h('div', { class: 'panel' }, notesBox));
    show(page, { scroll: false });
    drawNotes();
  }

  async function load() {
    fill(body, h('div', { class: 'spinner' }), h('p', { class: 'center muted' }, tr('loadingBook')));
    try {
      if (bookCache.has(book.id)) return showText(bookCache.get(book.id));
      const localSrc = downloads.localSrc(book.id);
      let text;
      let ocr = false;
      if (localSrc) {
        text = await fetchText(localSrc).catch(() => null);
      }
      if (!text) {
        const t = pickBookText(book, await fetchArchiveMetadata(book));
        if (disposed) return;
        if (!t) return scannedView();
        if (t.size > 8 * 1024 * 1024) return scannedView(tr('bookTooBig'));
        ocr = t.ocr;
        text = await fetchText(t.url);
      }
      if (disposed) return;
      const clean = cleanBookText(text);
      if (clean.length < 200) return scannedView(); // טקסט ריק / פגום — העמודים הסרוקים
      const data = { pages: paginate(clean), dir: textDir(clean), ocr, local: !!localSrc };
      bookCache.set(book.id, data);
      if (bookCache.size > 5) bookCache.delete(bookCache.keys().next().value);
      showText(data);
    } catch (e) {
      if (disposed) return;
      fill(body, h('div', { class: 'notice warn' }, e?.message === 'too-big' ? tr('bookTooBig') : tr('bookFailed')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: load }, tr('retry')),
          h('button', { class: 'btn', type: 'button', onclick: () => scannedView() }, tr('openScanned'))));
    }
  }
  load();
  cleanupView = () => { disposed = true; };

  return [mediaHead(book), mediaActions(book), body];
}

const PRIVACY_URL = 'https://b0548587778-alt.github.io/vidlearn/privacy.html';

// חשבון Google בהגדרות: כניסה / יציאה, מצב הסנכרון, והוראות ההגדרה החד-פעמית
function googlePanel() {
  const panel = h('div', { class: 'panel', id: 'src-google' });
  let busy = false;
  let lastError = '';
  const when = (t) => new Date(t).toLocaleString(store.state.settings.lang === 'en' ? 'en-GB' : 'he-IL', { dateStyle: 'short', timeStyle: 'short' });

  const signature = h('div', { class: 'muted small', dir: 'ltr' });
  const copyBtn = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, tr('copy'));
  if (NATIVE?.appSignature) {
    NATIVE.appSignature().then(({ packageName, sha1 }) => {
      const text = `${packageName}\n${sha1}`;
      fill(signature, h('code', {}, packageName), h('br'), h('code', {}, sha1));
      copyBtn.hidden = false;
      copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(text); toast(tr('copied')); } catch { /* */ } };
    }).catch(() => {});
  } else {
    fill(signature, h('code', {}, 'com.vidlearn.app'));
  }
  const setup = h('details', { class: 'howto' },
    h('summary', {}, tr('googleSetupTitle')),
    h('ol', {}, tr('googleSetupSteps').map((step) => h('li', {}, step))),
    h('div', { class: 'muted small' }, tr('googleAppId')), signature, copyBtn,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('a', { class: 'btn btn-sm', href: 'https://console.cloud.google.com/auth/clients', target: '_blank', rel: 'noopener noreferrer' }, '↗ Google Cloud Console')));

  const signIn = async () => {
    busy = true; lastError = ''; draw();
    try {
      await google.signIn();
      lastSearch = null;
      toast(tr('googleWelcome'));
    } catch (e) {
      lastError = signInErrorKey(e);
      if (lastError === 'googleNotConfigured' || lastError === 'googleFailed') setup.open = true;
    } finally {
      busy = false; draw();
    }
  };
  const signOut = async () => { await google.signOut(); lastSearch = null; toast(tr('googleSignedOut')); draw(); };
  const deleteRemote = async () => {
    if (!window.confirm(tr('googleDeleteConfirm'))) return;
    busy = true; draw();
    try {
      await google.deleteRemote();
      await google.signOut();
      lastSearch = null;
      toast(tr('googleDeleted'));
    } catch {
      toast(tr('googleDeleteFailed'));
    } finally {
      busy = false; draw();
    }
  };

  function draw() {
    const st = google.status;
    const a = google.account;
    let body;
    if (!google.available) {
      body = [h('div', { class: 'notice small' }, tr('googleOnlyInApp'))];
    } else if (!a) {
      body = [h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: signIn }, busy ? '…' : tr('googleSignIn'))];
    } else {
      const needsConsent = /needs-consent/.test(st.error);
      body = [
        h('div', { class: 'row' },
          a.picture ? h('img', { src: a.picture, alt: '', width: 36, height: 36, style: 'border-radius:50%', referrerpolicy: 'no-referrer' }) : null,
          h('div', {}, h('b', {}, a.name || a.email), h('div', { class: 'muted small', dir: 'ltr' }, a.email))),
        h('div', { class: 'muted small', style: 'margin-top:6px' },
          st.syncing ? tr('googleSyncing') : st.lastSync ? tr('googleSynced', when(st.lastSync)) : tr('googleNeverSynced')),
        st.error && !st.syncing ? h('div', { class: 'notice warn small' }, needsConsent ? tr('googleNeedsConsent') : tr('googleSyncError')) : null,
        h('div', { class: 'row', style: 'margin-top:8px' },
          needsConsent ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: busy, onclick: signIn }, tr('googleSignIn')) : null,
          h('button', { class: 'btn btn-sm', type: 'button', disabled: st.syncing, onclick: () => google.sync() }, '⟳ ' + tr('googleSyncNow')),
          h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: signOut }, tr('googleSignOut')),
          h('button', { class: 'btn btn-sm btn-danger', type: 'button', disabled: busy, onclick: deleteRemote }, tr('googleDeleteRemote'))),
      ];
    }
    fill(panel, h('h2', { style: 'margin-top:0' }, tr('googleAccount')),
      h('p', { class: 'muted small' }, tr('googleIntro')),
      body,
      lastError ? h('div', { class: 'notice warn small' }, tr(lastError)) : null,
      google.available && !a ? setup : null,
      h('p', { class: 'small', style: 'margin-bottom:0' }, h('a', { href: PRIVACY_URL, target: '_blank', rel: 'noopener noreferrer' }, tr('privacyPolicy'))));
  }
  draw();
  const off = google.onChange(() => { if (panel.isConnected) draw(); });
  const prev = cleanupView;
  cleanupView = () => { off(); if (prev) prev(); };
  return panel;
}

function renderSettings(params = new URLSearchParams()) {
  const s = store.state.settings;
  const focus = params.get('focus') || '';
  if (focus) setTimeout(() => document.getElementById(`src-${focus}`)?.scrollIntoView({ block: 'center' }), 0);
  const langSel = h('select', { class: 'input', id: 'langSel' }, h('option', { value: 'he' }, 'עברית'), h('option', { value: 'en' }, 'English'));
  langSel.value = s.lang;
  langSel.addEventListener('change', () => { store.setSetting('lang', langSel.value); applyLang(); route(); });

  const sourcesBox = h('div', {}, s.sources.map((src) => {
    const type = SOURCE_TYPES[src.type];
    const toggle = h('input', { type: 'checkbox', class: 'switch', checked: src.enabled, 'aria-label': `${tr('enabled')} — ${src.name}` });
    toggle.addEventListener('change', () => { store.updateSource(src.id, { enabled: toggle.checked }); lastSearch = null; });
    const keyInput = type.needsKey ? h('input', { class: 'input', type: 'password', value: src.key || '', placeholder: tr('apiKey'), 'aria-label': tr('apiKey'), autocomplete: 'off' }) : null;
    if (keyInput) keyInput.addEventListener('change', () => { store.updateSource(src.id, { key: keyInput.value, enabled: !!keyInput.value.trim() || toggle.checked }); lastSearch = null; route(); });
    return h('div', { class: 'source', id: `src-${src.id}` }, toggle,
      h('div', { class: 'info' }, h('b', {}, src.name), h('div', { class: 'muted small' }, type.label[s.lang] || type.label.he, src.url && !src.builtin ? ` · ${src.url}` : ''),
        src.type === 'youtube' && google.signedIn && !String(src.key || '').trim() ? h('div', { class: 'muted small' }, '✓ ' + tr('youtubeViaGoogle')) : null,
        keyInput ? [keyInput, h('div', { class: 'muted small' }, tr('apiKeyHint')),
          src.type === 'youtube' ? h('details', { class: 'howto', open: focus === 'youtube' && !ready(src) },
            h('summary', {}, tr('youtubeHowTo')),
            h('ol', {}, tr('youtubeSteps').map((step) => h('li', {}, step))),
            h('a', { class: 'btn btn-sm', href: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', target: '_blank', rel: 'noopener noreferrer' }, '↗ Google Cloud Console')) : null] : null),
      src.builtin ? h('span', { class: 'badge' }, tr('builtin')) : h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => { store.removeSource(src.id); lastSearch = null; route(); } }, tr('removeSource')));
  }));

  const typeSel = h('select', { class: 'input', id: 'srcType' }, Object.entries(SOURCE_TYPES).map(([k, d]) => h('option', { value: k }, d.label[s.lang] || d.label.he)));
  const urlIn = h('input', { class: 'input', id: 'srcUrl', type: 'url', placeholder: 'https://tube.example.org', dir: 'ltr' });
  const nameIn = h('input', { class: 'input', id: 'srcName' });
  const keyIn = h('input', { class: 'input', id: 'srcKey', type: 'password', autocomplete: 'off' });
  const urlField = h('label', { class: 'field', for: 'srcUrl' }, tr('sourceUrl'), urlIn);
  const keyField = h('label', { class: 'field', for: 'srcKey' }, tr('apiKey'), keyIn);
  const syncFields = () => { const d = SOURCE_TYPES[typeSel.value]; urlField.hidden = !d.needsUrl; keyField.hidden = !d.needsKey; };
  typeSel.addEventListener('change', syncFields);
  syncFields();
  const addSource = () => {
    try {
      store.addSource({ type: typeSel.value, url: urlIn.value, name: nameIn.value, key: keyIn.value });
      lastSearch = null;
      toast(tr('sourceAdded'));
      route();
    } catch (e) {
      toast(e.message === 'duplicate-source' ? tr('duplicateSource') : tr('invalidUrl'));
    }
  };

  const strict = h('input', { type: 'checkbox', class: 'switch', id: 'strict', checked: s.strict });
  strict.addEventListener('change', () => { store.setSetting('strict', strict.checked); lastSearch = null; lastMedia = null; });
  const extra = h('textarea', { id: 'extraBlock' }, s.extraBlock.join(', '));
  extra.addEventListener('change', () => { store.setSetting('extraBlock', parseWordList(extra.value)); lastSearch = null; lastMedia = null; });
  const crossLang = h('input', { type: 'checkbox', class: 'switch', id: 'crossLang', checked: s.crossLang !== false });
  crossLang.addEventListener('change', () => { store.setSetting('crossLang', crossLang.checked); lastSearch = null; lastMedia = null; });
  const langsIn = h('input', { class: 'input', id: 'contentLangs', value: s.contentLangs.join(', '), dir: 'ltr', placeholder: 'en, he' });
  langsIn.addEventListener('change', () => {
    store.setSetting('contentLangs', parseWordList(langsIn.value).map((x) => x.toLowerCase()).filter((x) => /^[a-z]{2,3}$/.test(x)).slice(0, 5));
    lastSearch = null;
  });

  // הגדרות הורדה
  const dlWifi = h('input', { type: 'checkbox', class: 'switch', id: 'dlWifi', checked: s.dlWifiOnly });
  dlWifi.addEventListener('change', () => { store.setSetting('dlWifiOnly', dlWifi.checked); if (!dlWifi.checked) downloads.pump(); });
  const dlQ = h('select', { class: 'input', id: 'dlQuality' }, h('option', { value: 'normal' }, tr('dlQualityNormal')), h('option', { value: 'low' }, tr('dlQualityLow')));
  dlQ.value = s.dlQuality;
  dlQ.addEventListener('change', () => store.setSetting('dlQuality', dlQ.value));
  const dlLimit = h('input', { class: 'input', id: 'dlLimit', type: 'number', min: 100, step: 100, value: s.dlLimitMB, dir: 'ltr' });
  dlLimit.addEventListener('change', () => {
    const n = Math.round(Number(dlLimit.value));
    if (n >= 100) store.setSetting('dlLimitMB', Math.min(n, 200000)); else dlLimit.value = store.state.settings.dlLimitMB;
  });
  const dlNext = h('input', { type: 'checkbox', class: 'switch', id: 'dlNext', checked: s.dlAutoNext });
  dlNext.addEventListener('change', () => store.setSetting('dlAutoNext', dlNext.checked));
  const dlPub = h('input', { type: 'checkbox', class: 'switch', id: 'dlPub', checked: s.dlPublicCopy !== false });
  dlPub.addEventListener('change', () => store.setSetting('dlPublicCopy', dlPub.checked));
  const dlDel = h('input', { type: 'checkbox', class: 'switch', id: 'dlDel', checked: s.dlDeleteLearned });
  dlDel.addEventListener('change', () => store.setSetting('dlDeleteLearned', dlDel.checked));

  const scanned = h('input', { type: 'checkbox', class: 'switch', id: 'bookScanned', checked: s.bookScanned !== false });
  scanned.addEventListener('change', () => { store.setSetting('bookScanned', scanned.checked); lastMedia = null; });

  const backupText = h('textarea', { id: 'backupText', dir: 'ltr', 'aria-label': tr('backup'), style: 'min-height:120px' });
  const doExport = async () => {
    const json = store.exportJson();
    backupText.value = json;
    if (navigator.share) { try { await navigator.share({ title: 'VidLearn backup', text: json }); } catch { /* המשתמש ביטל */ } }
  };
  const doImport = () => {
    try { store.importJson(backupText.value); applyLang(); toast(tr('imported')); route(); } catch { toast(tr('badFile')); }
  };

  const account = googlePanel();
  return [
    h('h1', {}, tr('settings')),
    h('p', { class: 'muted small' }, `${tr('version')}: ${VERSION}`),
    account,
    h('div', { class: 'panel' }, h('label', { class: 'field', for: 'langSel' }, tr('language'), langSel)),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, tr('sources')), h('p', { class: 'muted small' }, tr('sourcesHint')), sourcesBox,
      h('h2', {}, tr('addSource')),
      h('label', { class: 'field', for: 'srcType' }, tr('sourceType'), typeSel), urlField,
      h('label', { class: 'field', for: 'srcName' }, tr('sourceName'), nameIn), keyField,
      h('button', { class: 'btn btn-primary', type: 'button', onclick: addSource }, '＋ ' + tr('addSource'))),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, tr('filtering')),
      h('label', { class: 'check', for: 'strict' }, strict, tr('strict')),
      h('label', { class: 'field', for: 'extraBlock' }, tr('extraBlock'), extra),
      h('label', { class: 'field', for: 'contentLangs' }, tr('contentLangs'), langsIn),
      h('label', { class: 'check', for: 'crossLang' }, crossLang, tr('crossLang')),
      h('div', { class: 'notice warn small' }, tr('filterNote'))),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, '📚 ' + tr('booksSettings')),
      h('label', { class: 'check', for: 'bookScanned' }, scanned, tr('bookScanned'))),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, '⬇ ' + tr('dlSettings')),
      downloads.available ? null : h('div', { class: 'notice small' }, tr('dlOnlyInApp')),
      h('label', { class: 'check', for: 'dlWifi' }, dlWifi, tr('dlWifiOnly')),
      h('label', { class: 'field', for: 'dlQuality' }, tr('dlQuality'), dlQ),
      h('label', { class: 'field', for: 'dlLimit' }, tr('dlLimitMB'), dlLimit),
      h('label', { class: 'check', for: 'dlNext' }, dlNext, tr('dlAutoNext')),
      h('label', { class: 'check', for: 'dlPub' }, dlPub, tr('dlPublicCopy')),
      h('label', { class: 'check', for: 'dlDel' }, dlDel, tr('dlDeleteLearned'))),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, tr('backup')), backupText,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn', type: 'button', onclick: doExport }, tr('exportData')),
        h('button', { class: 'btn', type: 'button', onclick: doImport }, tr('importData')))),
  ];
}

// ---------- חלונות ----------
const dialog = document.getElementById('dialog');
const dialogBody = document.getElementById('dialogBody');
function openDialog(title, ...content) {
  fill(dialogBody, h('h2', { id: 'dialogTitle', style: 'margin-top:0' }, title), ...content);
  dialog.showModal();
}
function closeDialog() { dialog.close(); }

function newCourseDialog(onCreated) {
  const input = h('input', { class: 'input', id: 'courseName', maxlength: 120 });
  const create = () => {
    try {
      const c = store.createCourse(input.value);
      closeDialog();
      if (onCreated) onCreated(c); else route();
    } catch { input.focus(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  openDialog(tr('newCourse'), h('label', { class: 'field', for: 'courseName' }, tr('courseName'), input),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: create }, tr('create')), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, tr('cancel'))));
  input.focus();
}

function renameDialog(c) {
  const input = h('input', { class: 'input', id: 'courseRename', value: c.name, maxlength: 120 });
  openDialog(tr('rename'), h('label', { class: 'field', for: 'courseRename' }, tr('courseName'), input),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { store.renameCourse(c.id, input.value); closeDialog(); route(); } }, tr('save')),
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, tr('cancel'))));
}

function confirmDialog(msg, onYes) {
  openDialog(msg, h('div', { class: 'row' },
    h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { closeDialog(); onYes(); } }, tr('remove')),
    h('button', { class: 'btn', type: 'button', onclick: closeDialog }, tr('cancel'))));
}

function addToCourseDialog(v) {
  const add = (c) => { toast(store.addLesson(c.id, v) ? `${tr('added')}: ${c.name}` : tr('alreadyInCourse')); closeDialog(); };
  const courses = store.state.courses;
  openDialog(tr('chooseCourse'),
    courses.length ? h('div', { class: 'dialog-list' }, courses.map((c) => h('button', { class: 'btn', type: 'button', onclick: () => add(c) },
      `${c.name} (${c.lessons.length})${c.lessons.some((l) => l.id === v.id) ? ' ✓' : ''}`))) : null,
    h('p', { class: 'muted small' }, tr('orNewCourse')),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { closeDialog(); newCourseDialog((c) => { store.addLesson(c.id, v); toast(`${tr('added')}: ${c.name}`); }); } }, '＋ ' + tr('newCourse')),
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, tr('cancel'))));
}

// ---------- ניווט ----------
function applyLang() {
  const lang = store.state.settings.lang;
  tr = makeT(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
  document.getElementById('backBtn').setAttribute('aria-label', tr('back'));
}

function route() {
  if (cleanupView) { try { cleanupView(); } catch { /* */ } cleanupView = null; }
  dlWatchers.clear();
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const [name, arg] = path.split('/');
  const id = arg ? decodeURIComponentSafe(arg) : '';
  let content;
  switch (name) {
    case 'search': content = renderSearch(params); break;
    case 'library': content = renderLibrary(params); break;
    case 'course': content = renderCourse(id); break;
    case 'watch': content = renderWatch(id, params); break;
    case 'listen': content = renderListen(id, params); break;
    case 'read': content = renderRead(id); break;
    case 'settings': content = renderSettings(params); break;
    default: content = renderHome();
  }
  fill(view, ...[content].flat(Infinity).filter(Boolean));
  const tab = name === 'watch' || name === 'course' ? (name === 'course' ? 'library' : '') : (name || 'home');
  document.querySelectorAll('#tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.getElementById('backBtn').hidden = ['home', 'search', 'library', 'settings', ''].includes(name) && !(name === 'search' && params.get('subject'));
  window.scrollTo(0, 0);
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return ''; } }

document.getElementById('backBtn').addEventListener('click', () => history.back());
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { if (cleanupView) cleanupView(); });

// כפתור "חזרה" של אנדרואיד (Capacitor App)
const capApp = window.Capacitor?.Plugins?.App;
if (capApp) {
  capApp.addListener('backButton', () => {
    if (dialog.open) return closeDialog();
    const atRoot = !location.hash || location.hash === '#/home' || location.hash === '#/';
    if (atRoot) capApp.exitApp(); else history.back();
  });
}

applyLang();
route();
downloads.pump(); // הורדות שנקטעו בפעם הקודמת ממשיכות

// סנכרון עם חשבון Google: בפתיחה, וכשחוזרים לאפליקציה
if (google.signedIn) google.sync();
capApp?.addListener('appStateChange', ({ isActive }) => {
  if (isActive && google.signedIn) google.syncSoon(1000);
  else if (!isActive && google.signedIn) google.sync(); // יוצאים — מה שהשתנה עולה עכשיו
});
