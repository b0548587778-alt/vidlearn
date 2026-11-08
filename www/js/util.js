// עזרים טהורים — בלי DOM, נבדקים ב-node

// רק https — כתובת אחרת (javascript:, http:, data:) לא נכנסת לממשק
export function safeUrl(u) {
  if (typeof u !== 'string' || !u) return '';
  try {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

// יש אותיות עבריות בטקסט (חיפוש בעברית)
export function isHebrew(s) {
  return /[\u0590-\u05FF]/.test(String(s || ''));
}

export function hostOf(u) {
  try { return new URL(u).host; } catch { return ''; }
}

// כתובת בסיס של שרת: https בלבד, בלי / בסוף
export function normalizeBase(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('empty-url');
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  const url = new URL(s);
  if (url.protocol !== 'https:') throw new Error('https-only');
  return url.origin;
}

export function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// "01:02:03" / "23:01" / "95" / "5 min" ← שניות
export function parseDuration(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.round(v));
  if (Array.isArray(v)) v = v[0];
  const s = String(v || '').trim();
  if (!s) return 0;
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
    return Math.round(s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0));
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hours)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  if (unit.startsWith('h')) return Math.round(n * 3600);
  if (unit.startsWith('m')) return Math.round(n * 60);
  return Math.round(n);
}

// "PT1H2M3S" ← 3723 (משך של יוטיוב)
export function parseIsoDuration(s) {
  const m = String(s || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, d, h, mi, se] = m.map((x) => Number(x) || 0);
  return Math.round(d * 86400 + h * 3600 + mi * 60 + se);
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
