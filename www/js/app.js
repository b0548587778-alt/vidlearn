// ממשק האפליקציה. כל טקסט שמגיע מהרשת נכנס דרך textContent (h()) — אין innerHTML עם נתונים חיצוניים.
import { createStore, courseProgress, continueWatching } from './store.js';
import { searchAll, resolveDirect } from './search.js';
import { SOURCE_TYPES, sourceReady } from './sources.js';
import { parseWordList } from './filter.js';
import { t as makeT, SUBJECTS } from './i18n.js';
import { formatDuration, truncate, safeUrl } from './util.js';

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


function remember(v) { known.set(v.id, v); return v; }
function findVideo(id) {
  if (known.has(id)) return known.get(id);
  const s = store.state;
  const v = s.favorites.find((x) => x.id === id)
    || s.history.find((x) => x.video.id === id)?.video
    || s.courses.flatMap((c) => c.lessons).find((x) => x.id === id);
  return v ? remember(v) : null;
}

function go(hash) { location.hash = hash; }
function watchHash(v, courseId) { return `#/watch/${encodeURIComponent(v.id)}${courseId ? `?course=${encodeURIComponent(courseId)}` : ''}`; }

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
      pct && !p?.done ? h('span', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null,
    ),
    h('div', { class: 'meta' },
      h('span', { class: 'title' }, v.title),
      v.author ? h('span', { class: 'muted small' }, truncate(v.author, 60)) : null,
      h('span', {}, h('span', { class: 'badge' }, v.sourceName || v.sourceType)),
    ),
  );
}

function searchBar(initial = '') {
  const input = h('input', { type: 'search', value: initial, placeholder: tr('searchPlaceholder'), 'aria-label': tr('search'), enterkeyhint: 'search' });
  const submit = () => { const q = input.value.trim(); if (q) go(`#/search?q=${encodeURIComponent(q)}`); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return h('div', { class: 'searchbar' }, input, h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, tr('searchBtn')));
}

// ---------- מסכים ----------
function renderHome() {
  const s = store.state;
  const cont = continueWatching(s).map(remember);
  const courses = s.courses.slice(0, 6);
  return [
    h('section', { class: 'hero' }, h('h1', {}, tr('appName')), h('p', {}, tr('tagline')), searchBar()),
    cont.length ? [h('h2', {}, tr('continueWatching')), h('div', { class: 'hscroll' }, cont.map((v) => videoCard(v)))] : null,
    courses.length ? [h('h2', {}, tr('myCourses')), h('div', { class: 'hscroll' }, courses.map(courseCard))] : null,
    h('h2', {}, tr('subjects')),
    h('div', { class: 'subjects' }, SUBJECTS.map((sub) =>
      h('button', { class: 'subject', type: 'button', onclick: () => go(`#/search?q=${encodeURIComponent(sub.q)}&subject=${sub.id}`) },
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

function renderSearch(params) {
  const q = (params.get('q') || '').trim();
  const wrap = h('div', {});
  wrap.append(searchBar(q));
  if (!q) {
    wrap.append(h('p', { class: 'muted center' }, tr('tagline')));
    return wrap;
  }
  if (!store.state.settings.sources.some(sourceReady)) {
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
      st.filtered ? h('p', { class: 'muted small' }, tr('filteredInfo', st.filtered)) : null,
      ...st.errors.map((e) => h('div', { class: 'notice warn small' }, tr('sourceFailed', e.source.name))),
    );
    fill(results, shown.length ? h('div', { class: 'cards' }, shown.map((v) => videoCard(v))) : h('p', { class: 'center muted' }, tr('noResults')));
    fill(more, st.hasMore ? h('button', { class: 'btn', type: 'button', onclick: loadMore }, tr('loadMore')) : '');
  }

  async function loadMore() {
    fill(more, h('div', { class: 'spinner' }));
    const st = lastSearch;
    const r = await searchAll(q, store.state.settings, { cursors: st.cursors });
    if (lastSearch !== st) return;
    const ids = new Set(st.items.map((v) => v.id));
    st.items.push(...r.items.filter((v) => !ids.has(v.id)).map(remember));
    st.cursors = { ...st.cursors, ...r.cursors };
    st.hasMore = Object.values(st.cursors).some((c) => c !== null);
    st.filtered += r.filtered;
    st.errors = r.errors;
    draw();
  }

  if (lastSearch && lastSearch.q === q) {
    draw();
  } else {
    fill(results, h('div', { class: 'spinner' }), h('p', { class: 'center muted' }, tr('searching')));
    const token = {};
    lastSearch = token;
    searchAll(q, store.state.settings).then((r) => {
      if (lastSearch !== token) return; // חיפוש חדש החליף אותו
      lastSearch = { q, ...r, items: r.items.map(remember) };
      draw();
    });
  }
  return wrap;
}

function renderLibrary(params) {
  const tab = params.get('tab') || 'courses';
  const s = store.state;
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    ['courses', 'favorites', 'history'].map((k) => h('a', { class: 'btn btn-sm', role: 'tab', href: `#/library?tab=${k}`, 'aria-pressed': String(tab === k) },
      tr(k === 'courses' ? 'myCourses' : k))));
  let body;
  if (tab === 'favorites') {
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
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => renameDialog(c) }, tr('rename')),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => confirmDialog(tr('confirmDeleteCourse'), () => { store.deleteCourse(c.id); go('#/library'); }) }, tr('deleteCourse')),
    ),
    h('div', { class: 'panel' }, c.lessons.length ? c.lessons.map((l, i) => {
      remember(l);
      const done = !!store.state.progress[l.id]?.done;
      return h('div', { class: 'lesson' },
        h('span', { class: `num${done ? ' ok' : i === pr.nextIndex ? ' cur' : ''}` }, done ? '✓' : String(i + 1)),
        h('div', { class: 'info', onclick: () => go(watchHash(l, c.id)) },
          h('b', {}, l.title), h('span', { class: 'muted small' }, [formatDuration(l.duration), l.sourceName].filter(Boolean).join(' · '))),
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
  let videoEl = null;
  let disposed = false;
  let lastSaved = 0;

  function mountVideo(url) {
    videoEl = h('video', { src: url, controls: true, playsinline: true, preload: 'metadata' });
    const p = store.getProgress(v.id);
    videoEl.addEventListener('loadedmetadata', () => {
      if (p?.pos && !p.done && p.pos < videoEl.duration - 10) videoEl.currentTime = p.pos;
    });
    videoEl.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - lastSaved > 5000) { lastSaved = now; store.setPosition(v.id, videoEl.currentTime, videoEl.duration); }
    });
    videoEl.addEventListener('pause', () => store.setPosition(v.id, videoEl.currentTime, videoEl.duration));
    videoEl.addEventListener('ended', () => { store.setDone(v.id, true); drawActions(); offerNext(); });
    videoEl.addEventListener('error', () => { if (v.play.kind === 'iframe') mountIframe(); }, { once: true });
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

  (async () => {
    if (v.play.kind === 'video' && safeUrl(v.play.url)) return mountVideo(v.play.url);
    const direct = v.sourceType === 'archive' || v.sourceType === 'peertube' ? await resolveDirect(v) : '';
    if (disposed) return;
    if (direct) mountVideo(direct); else mountIframe();
  })();

  const actions = h('div', { class: 'row', style: 'margin-top:10px' });
  function drawActions() {
    const fav = store.isFavorite(v.id);
    const done = !!store.getProgress(v.id)?.done;
    const page = safeUrl(v.pageUrl);
    fill(actions, 
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(done), onclick: () => { store.setDone(v.id, !done); drawActions(); if (!done) offerNext(); } }, done ? '✓ ' + tr('done') : tr('markDone')),
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
    const n = course.lessons[i + 1];
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
        h('div', { class: 'info', onclick: () => { if (!cur) go(watchHash(l, course.id)); } }, h('b', {}, l.title)));
    })) : null;

  cleanupView = () => {
    disposed = true;
    if (videoEl && videoEl.duration) store.setPosition(v.id, videoEl.currentTime, videoEl.duration);
    if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); }
  };

  return [
    player, speedRow, embedNote,
    h('h1', { class: 'watch-title' }, v.title),
    h('p', { class: 'muted small' }, [v.author && `${tr('by')} ${v.author}`, v.sourceName, formatDuration(v.duration)].filter(Boolean).join(' · ')),
    actions, nextBox,
    v.description ? h('div', { class: 'desc' }, truncate(v.description, 1500)) : null,
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, '📝 ' + tr('notes')), notesList, noteInput, atTimeLabel,
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: addNote }, tr('addNote'))),
    courseList,
  ];
}

function renderSettings() {
  const s = store.state.settings;
  const langSel = h('select', { class: 'input', id: 'langSel' }, h('option', { value: 'he' }, 'עברית'), h('option', { value: 'en' }, 'English'));
  langSel.value = s.lang;
  langSel.addEventListener('change', () => { store.setSetting('lang', langSel.value); applyLang(); route(); });

  const sourcesBox = h('div', {}, s.sources.map((src) => {
    const type = SOURCE_TYPES[src.type];
    const toggle = h('input', { type: 'checkbox', class: 'switch', checked: src.enabled, 'aria-label': `${tr('enabled')} — ${src.name}` });
    toggle.addEventListener('change', () => { store.updateSource(src.id, { enabled: toggle.checked }); lastSearch = null; });
    const keyInput = type.needsKey ? h('input', { class: 'input', type: 'password', value: src.key || '', placeholder: tr('apiKey'), 'aria-label': tr('apiKey'), autocomplete: 'off' }) : null;
    if (keyInput) keyInput.addEventListener('change', () => { store.updateSource(src.id, { key: keyInput.value, enabled: !!keyInput.value.trim() || toggle.checked }); lastSearch = null; route(); });
    return h('div', { class: 'source' }, toggle,
      h('div', { class: 'info' }, h('b', {}, src.name), h('div', { class: 'muted small' }, type.label[s.lang] || type.label.he, src.url && !src.builtin ? ` · ${src.url}` : ''),
        keyInput ? [keyInput, h('div', { class: 'muted small' }, tr('apiKeyHint'))] : null),
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
  strict.addEventListener('change', () => { store.setSetting('strict', strict.checked); lastSearch = null; });
  const extra = h('textarea', { id: 'extraBlock' }, s.extraBlock.join(', '));
  extra.addEventListener('change', () => { store.setSetting('extraBlock', parseWordList(extra.value)); lastSearch = null; });
  const langsIn = h('input', { class: 'input', id: 'contentLangs', value: s.contentLangs.join(', '), dir: 'ltr', placeholder: 'en, he' });
  langsIn.addEventListener('change', () => {
    store.setSetting('contentLangs', parseWordList(langsIn.value).map((x) => x.toLowerCase()).filter((x) => /^[a-z]{2,3}$/.test(x)).slice(0, 5));
    lastSearch = null;
  });

  const backupText = h('textarea', { id: 'backupText', dir: 'ltr', 'aria-label': tr('backup'), style: 'min-height:120px' });
  const doExport = async () => {
    const json = store.exportJson();
    backupText.value = json;
    if (navigator.share) { try { await navigator.share({ title: 'VidLearn backup', text: json }); } catch { /* המשתמש ביטל */ } }
  };
  const doImport = () => {
    try { store.importJson(backupText.value); applyLang(); toast(tr('imported')); route(); } catch { toast(tr('badFile')); }
  };

  return [
    h('h1', {}, tr('settings')),
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
      h('div', { class: 'notice warn small' }, tr('filterNote'))),
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
    case 'settings': content = renderSettings(); break;
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
