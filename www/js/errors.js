// שגיאה טכנית (מהרשת / מהטלפון / מיוטיוב) ← מפתח להסבר ברור למשתמש (i18n). טהור.
const RULES = [
  [/^blocked$/, 'errBlocked'],
  [/^limit$/, 'errLimit'],
  // יוטיוב חושד ברובוט / חוסם גישה בלי חשבון מהכתובת הזו
  [/temporarily blocked|sign in to confirm|not a bot|login_required|captcha|recaptcha/i, 'errYtBlocked'],
  [/http-403|\b403\b/, 'errForbidden'],
  [/http-429|\b429\b/, 'errYtBlocked'],
  [/no-file|no-track|unavailable video|private video|\blive\b/i, 'errNoFile'],
  [/timeout|timed out/i, 'errTimeout'],
  [/unknownhost|unable to resolve|failed to connect|connectexception|socketexception|network|offline|econn|ssl|certificate/i, 'errNetwork'],
  [/mux|no-range|empty/i, 'errFile'],
  [/^yt-unavailable/, 'errYtUnavailable'],
];

export function explainError(message) {
  const m = String(message || '');
  // "yt-unavailable: <שגיאה מהטלפון>" — הסיבה האמיתית בפנים
  const inner = m.replace(/^yt-unavailable:\s*/, '');
  for (const [re, key] of RULES) if (re.test(inner) && !(key === 'errYtUnavailable' && inner !== m)) return key;
  if (inner !== m) return 'errYtUnavailable';
  return 'errGeneric';
}

// הפרטים הטכניים (להצגה מקופלת — עוזר לאבחן תקלה)
export function errorDetail(message) {
  const m = String(message || '').replace(/^yt-unavailable:?\s*/, '');
  return ['blocked', 'limit', 'failed', ''].includes(m) ? '' : m.slice(0, 200);
}
