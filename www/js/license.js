// רישיון ותקופת ניסיון. הכול נבדק בטלפון עצמו, בלי שרת ובלי רשת.
//
// הרישיונות הם הרישיונות של SuperSuite (docs/LICENSING-DESIGN.md שם): בעל התוכנה מנפיק לכל התוכנות שלו ממסך אחד.
//   1. האפליקציה יוצרת "בקשת רישיון" — טקסט קצר עם המפתח הציבורי של הטלפון הזה (המפתח הפרטי לא יוצא מהטלפון).
//   2. בעל התוכנה פותח את הבקשה ב-SuperSuite ומנפיק רישיון ל-VidLearn לתקופה.
//   3. האפליקציה בודקת: חתום במפתח השורש, שייך לטלפון הזה, כולל את התחום vidlearn, ובתוקף.
// הרישיון נעול לטלפון (למפתח שלו) ויש לו תאריך סיום.
//
// המצב נשמר במפתח נפרד ב-localStorage — לא בתוך vidlearn:v1 — ולכן אינו עובר בסנכרון עם Google ולא בגיבוי:
// מפתח של טלפון אחד אינו אמור להגיע לטלפון אחר.
import { utf8, b64uEncode, b64uDecode, sha256, ed25519 } from './ed25519.js';
import { ROOT_KEYS, PRODUCT, FEATURE, TRIAL_DAYS } from './license-key.js';

export const LICENSE_KEY = 'vidlearn:license';
export const PKG_REQUEST = 'supersuite-license-request';
export const PKG_LICENSE = 'supersuite-license';
export const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SKEW_MS = 10 * 60 * 1000; // תיקון שעון קטן (רשת סלולרית) אינו נחשב החזרה אחורה
const LAUNCH_MS = HOUR_MS;     // כל הפעלה שבה שעון הטלפון מאחורי הזמן שכבר נראה מוסיפה שעה
const MAX_LICENSE_CHARS = 100000;
const WARN_DAYS = 7; // כמה ימים לפני סוף הניסיון מוצגת תזכורת במסך הבית

// code = מפתח ב-i18n.js (ההודעה למשתמש בשפה שלו)
export class LicenseError extends Error {
  constructor(code) { super(code); this.name = 'LicenseError'; this.code = code; }
}

// ---------- אותו קידוד כמו ב-SuperSuite (shell/licensing/license.js) ----------
// JSON קנוני: מפתחות ממוינים, בלי רווחים — אותם בתים בדיוק כמו אצל מי שחתם
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new LicenseError('licBadFile');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export const keyId = (publicBytes) => b64uEncode(sha256(publicBytes).subarray(0, 16));
const jwk = (publicBytes) => ({ kty: 'OKP', crv: 'Ed25519', x: b64uEncode(publicBytes) });
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function verifyObject(obj, sig, publicBytes) {
  if (typeof sig !== 'string') return false;
  try {
    const raw = b64uDecode(sig);
    return raw.length === 64 && ed25519.verify(raw, utf8(canonical(obj)), publicBytes);
  } catch { return false; }
}

function decodeKey(text) {
  try { const b = b64uDecode(text); return b.length === 32 ? b : null; } catch { return null; }
}

// שם לרישיון: בלי תווי בקרה, עד 80 תווים (כמו cleanName ב-SuperSuite)
export function cleanName(name) {
  return String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

// בודק חבילת רישיון של SuperSuite. מחזיר את תוכן הרישיון (payload) או זורק LicenseError
export function readLicense(text, { nodePublic = null, rootKeys = ROOT_KEYS, feature = FEATURE } = {}) {
  if (!rootKeys.length) throw new LicenseError('licNotReady');
  let pkg;
  try { pkg = typeof text === 'string' ? JSON.parse(text.trim()) : text; } catch { throw new LicenseError('licBadFile'); }
  if (!pkg || typeof pkg !== 'object' || pkg.type !== PKG_LICENSE || !Array.isArray(pkg.chain) || !pkg.chain.length) {
    throw new LicenseError('licBadFile');
  }
  // רישיון של מערכת בת (שרשרת) שייך ל-SuperSuite עצמה, לא לאפליקציה
  if (pkg.chain.length !== 1) throw new LicenseError('licChild');
  const lic = pkg.chain[0];
  const p = lic && typeof lic === 'object' ? lic.payload : null;
  let licensePublic = null;
  let shapeOk = false;
  try {
    licensePublic = decodeKey(p.publicKey.x);
    shapeOk = p.v === 1 && p.depth === 1 && p.parentId === null
      && Array.isArray(p.features) && p.features.every((f) => typeof f === 'string')
      && ['issuedAt', 'expiresAt', 'graceDays', 'slot'].every((k) => Number.isSafeInteger(p[k]))
      && p.expiresAt > p.issuedAt && p.graceDays >= 0 && p.graceDays <= 90
      && !!licensePublic && p.id === keyId(licensePublic);
  } catch { shapeOk = false; }
  if (!shapeOk) throw new LicenseError('licBadFile');
  const roots = rootKeys.map(decodeKey).filter(Boolean);
  if (!roots.some((r) => verifyObject(p, lic.sig, r))) throw new LicenseError('licNotSigned');
  if (!nodePublic || !sameBytes(nodePublic, licensePublic)) throw new LicenseError('licOtherDevice');
  if (!p.features.includes(feature)) throw new LicenseError('licNoFeature');
  return p;
}

// active / grace / expired / not-yet-valid — כמו ב-SuperSuite. יום של מרווח: שעונים של שני מכשירים אינם זהים
export function validity(payload, now) {
  if (now < payload.issuedAt - DAY_MS) return 'not-yet-valid';
  if (now <= payload.expiresAt) return 'active';
  if (now <= payload.expiresAt + payload.graceDays * DAY_MS) return 'grace';
  return 'expired';
}

// קלט לא מהימן (localStorage) ← מצב תקין
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  return {
    v: 1,
    seed: typeof r.seed === 'string' && decodeKey(r.seed) ? r.seed : '',
    trialStart: time(r.trialStart),
    seen: time(r.seen),
    license: typeof r.license === 'string' && r.license.length <= MAX_LICENSE_CHARS ? r.license : '',
  };
}

const defaultRandom = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

// storage — localStorage (או תואם); now — שעון (לבדיקות); rootKeys ריק = בלי רישוי, הכול פתוח
export function createLicense({ storage, now = () => Date.now(), rootKeys = ROOT_KEYS, trialDays = TRIAL_DAYS, randomBytes = defaultRandom } = {}) {
  const enabled = rootKeys.length > 0;
  let state;
  try { state = normalize(JSON.parse(storage.getItem(LICENSE_KEY) || 'null')); } catch { state = normalize(null); }
  let checked = null;   // { text, payload } — אימות החתימה איטי (BigInt), ולכן פעם אחת לכל טקסט רישיון
  let publicBytes = null;

  const save = () => { try { storage.setItem(LICENSE_KEY, JSON.stringify(state)); return true; } catch { return false; } };

  // הזמן לבדיקות התוקף: המאוחר מבין שעון הטלפון לזמן המאוחר ביותר שכבר נראה — הגנה מהחזרת השעון אחורה.
  // שעון שנשאר מאחור לא מקפיא את הזמן: כל הפעלה כזו מוסיפה LAUNCH_MS, וזמן הריצה מאז ההפעלה נספר מעליו
  const launchAt = now();
  if (enabled && launchAt < state.seen - SKEW_MS) { state.seen += LAUNCH_MS; save(); }
  const base = Math.max(launchAt, state.seen);
  function clock() {
    const cur = now();
    const t = Math.max(cur, base + Math.max(0, cur - launchAt), state.seen);
    if (t > state.seen + HOUR_MS) { state.seen = t; save(); }
    return t;
  }

  function nodePublic() {
    if (!state.seed) return null;
    if (!publicBytes) publicBytes = ed25519.getPublicKey(b64uDecode(state.seed));
    return publicBytes;
  }

  function storedPayload() {
    if (!state.license) return null;
    if (!checked || checked.text !== state.license) {
      let payload = null;
      try { payload = readLicense(state.license, { nodePublic: nodePublic(), rootKeys }); } catch { payload = null; }
      checked = { text: state.license, payload };
    }
    return checked.payload;
  }

  // mode: off (בלי רישוי) / licensed / expired / trial / trial_ended. allowed = האפליקציה פתוחה לשימוש
  function status() {
    if (!enabled) return { mode: 'off', allowed: true };
    const t = clock();
    if (!state.trialStart) { state.trialStart = t; state.seen = Math.max(state.seen, t); save(); }
    const p = storedPayload();
    if (p) {
      const v = validity(p, t);
      const graceUntil = p.expiresAt + p.graceDays * DAY_MS;
      if (v === 'active' || v === 'grace') return { mode: 'licensed', allowed: true, state: v, name: p.name, until: p.expiresAt, graceUntil };
      if (v === 'expired') return { mode: 'expired', allowed: false, name: p.name, until: p.expiresAt };
    }
    const endsAt = Math.min(state.trialStart, t) + trialDays * DAY_MS;
    if (t < endsAt) {
      const daysLeft = Math.ceil((endsAt - t) / DAY_MS);
      return { mode: 'trial', allowed: true, daysLeft, endsAt, warn: daysLeft <= WARN_DAYS };
    }
    return { mode: 'trial_ended', allowed: false, endsAt };
  }

  // בקשת רישיון לשליחה לבעל התוכנה — טקסט JSON באותו מבנה שמסך הרישוי של SuperSuite פותח
  function request(name) {
    const clean = cleanName(name);
    if (!clean) throw new LicenseError('licNameMissing');
    if (!state.seed) {
      state.seed = b64uEncode(randomBytes());
      publicBytes = null;
      // מפתח שלא נשמר = רישיון שלא ייפתח בהפעלה הבאה
      if (!save()) { state.seed = ''; throw new LicenseError('licSaveFailed'); }
    }
    const pub = nodePublic();
    return JSON.stringify({ type: PKG_REQUEST, v: 1, name: clean, publicKey: jwk(pub), keyId: keyId(pub), product: PRODUCT });
  }

  // טוען רישיון. מחזיר את תוכן הרישיון, או זורק LicenseError
  function activate(text) {
    const raw = typeof text === 'string' ? text.trim() : JSON.stringify(text);
    if (!raw || raw.length > MAX_LICENSE_CHARS) throw new LicenseError('licBadFile');
    const p = readLicense(raw, { nodePublic: nodePublic(), rootKeys });
    const v = validity(p, clock());
    if (v === 'expired') throw new LicenseError('licExpired');
    if (v === 'not-yet-valid') throw new LicenseError('licNotYet');
    const before = { license: state.license, seen: state.seen };
    state.license = raw;
    state.seen = Math.max(state.seen, p.issuedAt);
    if (!save()) { Object.assign(state, before); throw new LicenseError('licSaveFailed'); }
    checked = { text: raw, payload: p };
    return p;
  }

  return { enabled, status, request, activate };
}
