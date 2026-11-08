// שמירת סרטונים בטלפון לצפייה בלי אינטרנט.
// התור עובד אחד-אחד. הקבצים, הרשת והכתובת הישירה — דרך מתאמים, כדי שאפשר לבדוק בלי טלפון.
//   fs:      { download(url, path, onProgress) → { uri }, stat(path) → size, remove(path), toSrc(uri) → src }
//   network: { status() → { connected, type }, onChange(fn) }
//   resolveUrl(video, quality) → { url, size } (size משוער, 0 = לא ידוע) או כתובת בלבד
import { canDownload } from './sources.js';
import { snapshot } from './store.js';

export const MB = 1024 * 1024;

// גיבוב FNV-1a של 64 סיביות (שני גיבובים של 32) — שם קובץ ייחודי לכל מזהה
function hashId(str) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export function fileNameFor(v, url) {
  let ext = 'mp4';
  try {
    const m = new URL(url).pathname.match(/\.(mp4|webm|ogv|m4v|mp3|m4a|aac|opus|ogg|txt)$/i);
    if (m) ext = m[1].toLowerCase();
  } catch { /* ברירת מחדל mp4 */ }
  // תחילית קריאה (סוג המקור) + גיבוב של המזהה המלא — שני סרטונים לא יקבלו אותו קובץ
  const prefix = String(v.sourceType || 'video').replace(/[^\w-]+/g, '_').slice(0, 20);
  return `videos/${prefix}-${hashId(String(v.id))}.${ext}`;
}

export function createDownloads({ store, fs, network, resolveUrl, onUpdate = () => {} }) {
  const progress = new Map(); // id ← 0..1 (בזיכרון בלבד)
  let running = false;
  let rerun = false; // בקשה ל-pump בזמן שהוא רץ — ירוץ שוב בסוף (שינוי רשת באמצע)
  let currentId = null;

  const settings = () => store.state.settings;
  const all = () => Object.values(store.state.downloads);
  const notify = () => { try { onUpdate(); } catch { /* הממשק לא מפיל את התור */ } };

  const isSaved = (id) => store.getDownload(id)?.status === 'done';
  const limitBytes = () => settings().dlLimitMB * MB;

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
    if (!fs) return;
    if (running) { rerun = true; return; }
    running = true;
    rerun = false;
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
        if (usedBytes() >= limitBytes()) {
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
          const r = await resolveUrl(next.video, quality);
          const url = typeof r === 'string' ? r : r?.url;
          const expected = typeof r === 'object' && r ? Number(r.size) || 0 : 0;
          if (!url) throw new Error('no-file');
          // גודל ידוע מראש — לא מורידים קובץ שממילא לא ייכנס
          if (expected && usedBytes() + expected > limitBytes()) {
            store.setDownload(id, { status: 'error', error: 'limit' });
            continue;
          }
          path = fileNameFor(next.video, url);
          const { uri } = await fs.download(url, path, (p) => { progress.set(id, p); notify(); });
          if (!store.getDownload(id)) { await fs.remove(path).catch(() => {}); continue; } // בוטל באמצע
          const size = await fs.stat(path).catch(() => 0);
          if (usedBytes() + size > limitBytes()) {
            await fs.remove(path).catch(() => {});
            store.setDownload(id, { status: 'error', error: 'limit' });
          } else {
            store.setDownload(id, { status: 'done', path, uri, size, quality, at: Date.now() });
          }
        } catch (e) {
          if (path) await fs.remove(path).catch(() => {});
          // החיבור נפל באמצע ← ממתין לרשת (ימשיך לבד), לא שגיאה
          const offline = !(await allowedNow());
          if (store.getDownload(id)) {
            store.setDownload(id, offline ? { status: 'waiting', error: null } : { status: 'error', error: String(e?.message || 'failed').slice(0, 80) });
          }
        } finally {
          progress.delete(id);
          currentId = null;
          notify();
        }
      }
    } finally {
      running = false;
    }
    if (rerun) pump();
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
    if (i < 0) return null; // הסרטון כבר לא בקורס
    const next = course.lessons.slice(i + 1).find((l) => !store.state.progress[l.id]?.done && canDownload(l));
    // שיעור שכבר שמור / בתור / נכשל — לא מנסים שוב אוטומטית (רק המשתמש)
    if (!next || store.getDownload(next.id)) return null;
    return enqueue(next, { auto: true }) === 'queued' ? next : null;
  }

  function saveCourse(course) {
    let added = 0;
    for (const l of course.lessons) if (enqueue(l) === 'queued') added++;
    return added;
  }

  // סימון "נלמד" ← מחיקה (אם הוגדר)
  function onLearned(id) {
    if (settings().dlDeleteLearned && isSaved(id)) return remove(id);
    return Promise.resolve(false);
  }

  if (network?.onChange) network.onChange(() => { all().filter((d) => d.status === 'waiting').forEach((d) => store.setDownload(d.video.id, { status: 'queued' })); pump(); });

  return {
    available: !!fs,
    enqueue, remove, retry, pump, localSrc, prefetchNext, saveCourse, onLearned, usedBytes, isSaved, limitBytes,
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
  else t = (n > 0 ? Math.max(1, Math.round(n / 1024)) : 0) + ' KB';
  return '\u2066' + t + '\u2069';
}
