// שמירת סרטונים בטלפון לצפייה בלי אינטרנט.
// התור עובד אחד-אחד. הקבצים, הרשת והכתובת הישירה — דרך מתאמים, כדי שאפשר לבדוק בלי טלפון.
//   fs:      { download(url, path, onProgress) → { uri }, stat(path) → size, remove(path), toSrc(uri) → src }
//   network: { status() → { connected, type }, onChange(fn) }
//   resolveUrl(video, quality) → כתובת קובץ ישירה או ''
import { canDownload } from './sources.js';
import { snapshot } from './store.js';

export const MB = 1024 * 1024;

export function fileNameFor(v, url) {
  let ext = 'mp4';
  try {
    const m = new URL(url).pathname.match(/\.(mp4|webm|ogv|m4v)$/i);
    if (m) ext = m[1].toLowerCase();
  } catch { /* ברירת מחדל mp4 */ }
  const base = String(v.id).replace(/[^\w.-]+/g, '_').slice(0, 120);
  return `videos/${base}.${ext}`;
}

export function createDownloads({ store, fs, network, resolveUrl, onUpdate = () => {} }) {
  const progress = new Map(); // id ← 0..1 (בזיכרון בלבד)
  let running = false;
  let currentId = null;

  const settings = () => store.state.settings;
  const all = () => Object.values(store.state.downloads);
  const notify = () => { try { onUpdate(); } catch { /* הממשק לא מפיל את התור */ } };

  function usedBytes() {
    return all().filter((d) => d.status === 'done').reduce((sum, d) => sum + (Number(d.size) || 0), 0);
  }

  function enqueue(v, { auto = false } = {}) {
    if (!fs) return 'unavailable';
    if (!canDownload(v)) return 'unsupported';
    const cur = store.getDownload(v.id);
    if (cur && cur.status !== 'error') return 'exists';
    store.setDownload(v.id, { video: snapshot(v), status: 'queued', auto, at: Date.now(), error: null });
    notify();
    pump();
    return 'queued';
  }

  async function allowedNow() {
    if (!network) return true;
    let st;
    try { st = await network.status(); } catch { return true; }
    if (!st || st.connected === false) return false;
    if (settings().dlWifiOnly && st.type && st.type !== 'wifi' && st.type !== 'unknown') return false;
    return true;
  }

  // מעבד את התור; רץ פעם אחת בכל רגע
  async function pump() {
    if (running || !fs) return;
    running = true;
    try {
      for (;;) {
        const next = all()
          .filter((d) => d.status === 'queued' || d.status === 'waiting')
          .sort((a, b) => (a.auto === b.auto ? a.at - b.at : a.auto ? 1 : -1))[0]; // בקשה ידנית קודמת לאוטומטית
        if (!next) break;
        const id = next.video.id;

        if (!(await allowedNow())) {
          // מחכים ל-Wi-Fi / לחיבור — כל הממתינים מסומנים, והתור ממשיך כשהרשת משתנה
          all().filter((d) => d.status === 'queued').forEach((d) => store.setDownload(d.video.id, { status: 'waiting' }));
          notify();
          break;
        }
        if (usedBytes() >= settings().dlLimitMB * MB) {
          store.setDownload(id, { status: 'error', error: 'limit' });
          notify();
          continue;
        }

        currentId = id;
        store.setDownload(id, { status: 'downloading', error: null });
        progress.set(id, 0);
        notify();
        let path = '';
        try {
          const quality = settings().dlQuality;
          const url = await resolveUrl(next.video, quality);
          if (!url) throw new Error('no-file');
          path = fileNameFor(next.video, url);
          const { uri } = await fs.download(url, path, (p) => { progress.set(id, p); notify(); });
          if (!store.getDownload(id)) { await fs.remove(path).catch(() => {}); continue; } // בוטל באמצע
          const size = await fs.stat(path).catch(() => 0);
          if (usedBytes() + size > settings().dlLimitMB * MB) {
            await fs.remove(path).catch(() => {});
            store.setDownload(id, { status: 'error', error: 'limit' });
          } else {
            store.setDownload(id, { status: 'done', path, uri, size, quality, at: Date.now() });
          }
        } catch (e) {
          if (path) await fs.remove(path).catch(() => {});
          if (store.getDownload(id)) store.setDownload(id, { status: 'error', error: String(e?.message || 'failed').slice(0, 80) });
        } finally {
          progress.delete(id);
          currentId = null;
          notify();
        }
      }
    } finally {
      running = false;
    }
  }

  async function remove(id) {
    const d = store.getDownload(id);
    if (!d) return false;
    store.setDownload(id, null); // קודם מהרשימה — הורדה שרצה תזהה ותמחק את הקובץ
    if (d.path && fs) await fs.remove(d.path).catch(() => {});
    notify();
    return true;
  }

  function retry(id) {
    const d = store.getDownload(id);
    if (!d || d.status !== 'error') return false;
    store.setDownload(id, { status: 'queued', error: null, at: Date.now() });
    notify();
    pump();
    return true;
  }

  // סרטון שמור ← מקור לנגן (בלי רשת)
  function localSrc(id) {
    const d = store.getDownload(id);
    if (!fs || !d || d.status !== 'done' || !d.uri) return '';
    return fs.toSrc(d.uri);
  }

  // בקורס: לשמור מראש את השיעור הבא שעוד לא נלמד
  function prefetchNext(course, currentVideoId) {
    if (!settings().dlAutoNext || !course) return null;
    const i = course.lessons.findIndex((l) => l.id === currentVideoId);
    const next = course.lessons.slice(i + 1).find((l) => !store.state.progress[l.id]?.done && canDownload(l));
    if (!next) return null;
    return enqueue(next, { auto: true }) === 'queued' ? next : null;
  }

  function saveCourse(course) {
    let added = 0;
    for (const l of course.lessons) if (enqueue(l) === 'queued') added++;
    return added;
  }

  // סימון "נלמד" ← מחיקה (אם הוגדר)
  function onLearned(id) {
    if (settings().dlDeleteLearned && store.getDownload(id)?.status === 'done') return remove(id);
    return Promise.resolve(false);
  }

  if (network?.onChange) network.onChange(() => { all().filter((d) => d.status === 'waiting').forEach((d) => store.setDownload(d.video.id, { status: 'queued' })); pump(); });

  return {
    available: !!fs,
    enqueue, remove, retry, pump, localSrc, prefetchNext, saveCourse, onLearned, usedBytes,
    progressOf: (id) => progress.get(id) ?? null,
    get currentId() { return currentId; },
    list: () => all().sort((a, b) => b.at - a.at),
  };
}

// מבודד כטקסט משמאל לימין, כדי ש-"42 MB" לא יתהפך בתוך משפט בעברית
export function formatBytes(n) {
  n = Number(n) || 0;
  let t;
  if (n >= 1024 * MB) t = (n / (1024 * MB)).toFixed(1) + ' GB';
  else if (n >= MB) t = Math.round(n / MB) + ' MB';
  else t = Math.max(1, Math.round(n / 1024)) + ' KB';
  return '\u2066' + t + '\u2069';
}
