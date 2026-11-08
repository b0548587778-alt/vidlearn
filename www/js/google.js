// חשבון Google: כניסה (דרך רכיב ה-native — Google Identity של אנדרואיד), טוקן גישה,
// וסנכרון הנתונים בין מכשירים דרך Drive (sync.js). הכניסה גם מפעילה את יוטיוב בלי מפתח API.
// הטוקן נשמר רק בזיכרון; בטלפון נשמרים רק השם והמייל להצגה.
import { mergeSync, samePayload, driveFindUrl, driveFileUrl, driveDownloadUrl, driveCreateRequest, driveUploadUrl, parseDriveFind } from './sync.js';

export const ACCOUNT_KEY = 'vidlearn:google';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

// native: { signIn({ interactive }) → { accessToken }, clearToken({ token }) } — או null (דפדפן)
// onApplied: נתונים ממכשיר אחר נכנסו לטלפון — לרענן את המסך
export function createGoogle({ native, store, storage, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), syncDelayMs = 8000, onApplied = null }) {
  let account = null;
  try { account = JSON.parse(storage.getItem(ACCOUNT_KEY) || 'null'); } catch { account = null; }
  if (!account || typeof account !== 'object' || !account.email) account = null;

  let token = null;
  let syncing = null;   // Promise של סנכרון שרץ
  let again = false;    // היה שינוי בזמן הסנכרון — עוד סבב אחריו
  let timer = null;
  let applying = false; // מחילים מיזוג — זה לא שינוי של המשתמש
  const listeners = new Set();
  const status = { syncing: false, error: '', lastSync: account?.lastSync || 0 };

  const emit = () => listeners.forEach((fn) => { try { fn(api); } catch { /* */ } });
  const saveAccount = () => {
    try {
      if (account) storage.setItem(ACCOUNT_KEY, JSON.stringify(account));
      else storage.removeItem?.(ACCOUNT_KEY);
    } catch { /* */ }
  };

  async function getToken({ refresh = false, interactive = false } = {}) {
    if (!native) throw new Error('not-available');
    if (token && !refresh) return token;
    if (token && refresh) {
      const old = token;
      token = null;
      await native.clearToken({ token: old }).catch(() => {});
    }
    const r = await native.signIn({ interactive });
    if (!r?.accessToken) throw new Error('no-token');
    token = r.accessToken;
    return token;
  }

  // בקשה עם הטוקן; 401 ← טוקן חדש וניסיון אחד נוסף
  async function authFetch(url, opts = {}) {
    const go = async (refresh) => fetchImpl(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${await getToken({ refresh })}` } });
    let res = await go(false);
    if (res.status === 401) res = await go(true);
    if (!res.ok) throw new Error(`http-${res.status}`);
    return res;
  }

  async function readJson(res) {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function syncOnce() {
    const found = parseDriveFind(await readJson(await authFetch(driveFindUrl())));
    let remote = null;
    if (found) {
      try { remote = await readJson(await authFetch(driveDownloadUrl(found))); } catch (e) {
        if (e?.message !== 'http-404') throw e;
      }
    }
    const local = store.syncPayload();
    const merged = mergeSync(local, remote, now());
    if (!samePayload(merged, local)) {
      applying = true;
      try { store.applySync(merged); } finally { applying = false; }
      try { onApplied?.(); } catch { /* */ }
    }
    // מה שבטלפון אחרי ההחלה (מנורמל) — זה מה שעולה
    const out = store.syncPayload();
    if (!remote || !samePayload(out, remote)) {
      let id = found;
      if (!id) {
        const c = driveCreateRequest();
        id = (await readJson(await authFetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: c.body })))?.id;
        if (!id) throw new Error('create-failed');
      }
      await authFetch(driveUploadUrl(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
    }
  }

  async function sync() {
    if (!account || !native) return false;
    if (syncing) { again = true; return syncing; }
    clearTimeout(timer);
    status.syncing = true;
    emit();
    syncing = (async () => {
      try {
        do {
          again = false;
          await syncOnce();
        } while (again);
        status.error = '';
        status.lastSync = now();
        account.lastSync = status.lastSync;
        saveAccount();
        return true;
      } catch (e) {
        status.error = String(e?.message || e);
        return false;
      } finally {
        status.syncing = false;
        syncing = null;
        emit();
      }
    })();
    return syncing;
  }

  function syncSoon(delay = syncDelayMs) {
    if (!account || !native) return;
    if (syncing) { again = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => { sync(); }, delay);
    timer?.unref?.(); // ב-Node (בדיקות) — לא מחזיק את התהליך
  }

  // כל שינוי בנתונים ← סנכרון כמה שניות אחריו (שינויים רצופים מתאחדים)
  store.onChange(() => { if (!applying) syncSoon(); });

  const api = {
    get available() { return !!native; },
    get signedIn() { return !!account && !!native; },
    get account() { return account; },
    get status() { return status; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getToken,
    sync,
    syncSoon,

    async signIn() {
      if (!native) throw new Error('not-available');
      token = null;
      await getToken({ interactive: true });
      let info = {};
      try { info = (await readJson(await authFetch(USERINFO))) || {}; } catch { /* בלי פרטים — עדיין מחוברים */ }
      account = { email: String(info.email || '—'), name: String(info.name || ''), picture: String(info.picture || ''), lastSync: 0 };
      saveAccount();
      emit();
      // קודם הסנכרון (שהגדרות מהמכשיר האחר לא יידרסו), ואז יוטיוב פועל
      await sync();
      const yt = store.state.settings.sources.find((s) => s.type === 'youtube');
      if (yt && !yt.enabled) store.updateSource(yt.id, { enabled: true });
      return account;
    },

    // מחיקת קובץ הסנכרון מה-Drive (הנתונים בטלפון נשארים)
    async deleteRemote() {
      if (!account || !native) throw new Error('not-signed-in');
      clearTimeout(timer);
      if (syncing) await syncing.catch(() => {});
      let id;
      while ((id = parseDriveFind(await readJson(await authFetch(driveFindUrl()))))) {
        await authFetch(driveFileUrl(id), { method: 'DELETE' });
      }
      return true;
    },

    async signOut() {
      const old = token;
      token = null;
      clearTimeout(timer);
      account = null;
      status.error = '';
      status.lastSync = 0;
      saveAccount();
      emit();
      if (old) {
        // ניתוק הגישה של האפליקציה בחשבון (בכניסה הבאה — שוב מסך ההרשאה)
        await fetchImpl(`${REVOKE}?token=${encodeURIComponent(old)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => {});
        await native?.clearToken({ token: old }).catch(() => {});
      }
    },
  };
  return api;
}

// שגיאת כניסה ← מפתח הודעה ב-i18n. הקודים מהרכיב: canceled / not-configured / network / failed:<קוד>
export function signInErrorKey(e) {
  const m = `${e?.code || ''} ${e?.message || e || ''}`;
  if (/canceled/.test(m)) return 'googleCanceled';
  if (/not-available/.test(m)) return 'googleOnlyInApp';
  if (/not-configured/.test(m)) return 'googleNotConfigured';
  if (/network|timeout/.test(m)) return 'googleNetwork';
  return 'googleFailed';
}
