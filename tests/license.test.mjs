// רישיון ותקופת ניסיון (www/js/license.js): בקשת רישיון, אימות רישיון שהנפיק מרכז הרישוי של SuperSuite, תוקף וניסיון
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nodeCrypto from 'node:crypto';
import { createLicense, readLicense, validity, canonical, keyId, cleanName, LicenseError, LICENSE_KEY, PKG_REQUEST, PKG_LICENSE, DAY_MS } from '../www/js/license.js';
import { ROOT_KEYS, PRODUCT, FEATURE, TRIAL_DAYS } from '../www/js/license-key.js';
import { ed25519, utf8, b64uEncode, b64uDecode, sha256, sha512 } from '../www/js/ed25519.js';
import { createStore, STORAGE_KEY } from '../www/js/store.js';

// רישיון אמיתי: נוצר ב-owner-core.js של SuperSuite (מרכז הרישוי) לבקשה שהאפליקציה יצרה — מפתח שורש לבדיקות בלבד
const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/license-from-center.json', import.meta.url), 'utf8'));
const FX_NOW = FX.issuedAt + DAY_MS;

function mem(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const code = (c) => (e) => e instanceof LicenseError && e.code === c;
const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const withSeed = (seed) => mem({ [LICENSE_KEY]: JSON.stringify({ v: 1, seed }) });

// רישיון חתום כמו ב-SuperSuite (license.js שם: buildPayload + signObject) — לבדיקות תוקף ותקלות
const ROOT_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const ROOT = b64uEncode(ed25519.getPublicKey(ROOT_SEED));
const DEV_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const DEV_PUB = ed25519.getPublicKey(DEV_SEED);
function licenseFor(over = {}, { rootSeed = ROOT_SEED, pub = DEV_PUB } = {}) {
  const payload = { v: 1, id: keyId(pub), parentId: null, depth: 1, slot: 1, name: 'ישיבת נר ישראל', publicKey: { kty: 'OKP', crv: 'Ed25519', x: b64uEncode(pub) },
    features: [FEATURE], limits: { maxChildren: 0, maxUsers: 1, maxStorageMb: 100, maxDepth: 1 }, issuedAt: 1_000_000_000_000, expiresAt: 1_000_000_000_000 + 365 * DAY_MS, graceDays: 7, ...over };
  return JSON.stringify({ type: PKG_LICENSE, v: 1, chain: [{ payload, sig: b64uEncode(ed25519.sign(utf8(canonical(payload)), rootSeed)) }], notices: [] });
}
const device = (opts = {}) => createLicense({ storage: withSeed(b64uEncode(DEV_SEED)), rootKeys: [ROOT], now: () => 1_000_000_000_000 + DAY_MS, ...opts });

test('Ed25519 ו-SHA טהורים: וקטור הבדיקה של RFC 8032, ותאימות בייט-לבייט ל-node:crypto', () => {
  const seed = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const pub = ed25519.getPublicKey(seed);
  assert.equal(Buffer.from(pub).toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const sig = ed25519.sign(new Uint8Array(0), seed);
  assert.equal(Buffer.from(sig).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  assert.equal(ed25519.verify(sig, new Uint8Array(0), pub), true);
  // מול המימוש של Node: חתימה של Node מאומתת כאן, וחתימה מכאן זהה לשל Node (Ed25519 דטרמיניסטי)
  const msg = utf8('רישיון VidLearn — בדיקה');
  const key = nodeCrypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64uEncode(seed), x: b64uEncode(pub) }, format: 'jwk' });
  const nodeSig = new Uint8Array(nodeCrypto.sign(null, msg, key));
  assert.equal(ed25519.verify(nodeSig, msg, pub), true);
  assert.deepEqual(ed25519.sign(msg, seed), nodeSig);
  const bad = Uint8Array.from(nodeSig); bad[5] ^= 1;
  assert.equal(ed25519.verify(bad, msg, pub), false);
  assert.deepEqual(sha256(msg), new Uint8Array(nodeCrypto.createHash('sha256').update(msg).digest()));
  assert.deepEqual(sha512(msg), new Uint8Array(nodeCrypto.createHash('sha512').update(msg).digest()));
  assert.deepEqual(b64uDecode(b64uEncode(seed)), seed);
});

test('מפתח השורש וזהות המוצר: המפתח של בעל התוכנה, והמוצר vidlearn כמו בקטלוג של מרכז הרישוי', () => {
  assert.equal(PRODUCT, 'vidlearn');
  assert.equal(FEATURE, 'vidlearn');
  assert.equal(TRIAL_DAYS, 30);
  for (const k of ROOT_KEYS) assert.equal(b64uDecode(k).length, 32);
  // המזהה שבהערה ליד המפתח (אותו מזהה שמוצג במסך מנהל-העל)
  const src = fs.readFileSync(new URL('../www/js/license-key.js', import.meta.url), 'utf8');
  for (const k of ROOT_KEYS) assert.ok(src.includes(`'${k}', // ${keyId(b64uDecode(k))}`), 'מזהה המפתח בהערה אינו תואם למפתח');
});

test('בקשת רישיון: המבנה שמסך הרישוי של SuperSuite פותח, עם product; המפתח נוצר פעם אחת ונשמר', () => {
  const storage = mem();
  const lic = createLicense({ storage, rootKeys: [ROOT], now: () => 5000, randomBytes: () => DEV_SEED });
  const req = JSON.parse(lic.request('  תלמוד תורה\u0007 דרך אמת  '));
  assert.deepEqual(Object.keys(req).sort(), ['keyId', 'name', 'product', 'publicKey', 'type', 'v']);
  assert.equal(req.type, PKG_REQUEST);
  assert.equal(req.v, 1);
  assert.equal(req.name, 'תלמוד תורה דרך אמת');
  assert.equal(req.product, 'vidlearn');
  assert.deepEqual(req.publicKey, { kty: 'OKP', crv: 'Ed25519', x: b64uEncode(DEV_PUB) });
  assert.equal(req.keyId, keyId(DEV_PUB));
  // אותו מפתח בבקשה הבאה ובהפעלה הבאה — גם כשהמחולל היה מחזיר מפתח אחר
  const again = createLicense({ storage, rootKeys: [ROOT], randomBytes: () => new Uint8Array(32) });
  assert.equal(JSON.parse(again.request('שם אחר')).keyId, req.keyId);
  assert.equal(cleanName('x'.repeat(200)).length, 80);
  assert.throws(() => lic.request('   '), code('licNameMissing'));
});

test('בקשה: מפתח שלא נשמר בטלפון — אין בקשה (רישיון שהיה מונפק לה לא היה נפתח)', () => {
  const storage = mem();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const lic = createLicense({ storage, rootKeys: [ROOT], randomBytes: () => DEV_SEED });
  assert.throws(() => lic.request('יעקב'), code('licSaveFailed'));
});

test('רישיון אמיתי ממרכז הרישוי של SuperSuite מופעל; נשמר ונפתח גם בהפעלה הבאה', () => {
  const storage = withSeed(FX.seed);
  const lic = createLicense({ storage, rootKeys: [FX.root], now: () => FX_NOW });
  assert.equal(lic.status().mode, 'trial');
  // הבקשה שנשמרה ב-fixture היא זו שהאפליקציה יוצרת מאותו מפתח
  assert.equal(lic.request('תלמוד תורה דרך אמת'), FX.request);
  const p = lic.activate(FX.license);
  assert.deepEqual(p.features, ['vidlearn']);
  assert.equal(p.name, 'תלמוד תורה דרך אמת');
  const st = lic.status();
  assert.deepEqual({ mode: st.mode, allowed: st.allowed, state: st.state, until: st.until }, { mode: 'licensed', allowed: true, state: 'active', until: FX.expiresAt });
  const next = createLicense({ storage, rootKeys: [FX.root], now: () => FX_NOW + DAY_MS });
  assert.equal(next.status().mode, 'licensed');
  // גם עם רווחים ושורות מסביב (הדבקה מהודעה)
  const pasted = createLicense({ storage: withSeed(FX.seed), rootKeys: [FX.root], now: () => FX_NOW });
  assert.equal(pasted.activate(`\n  ${FX.license}  \n`).id, p.id);
});

test('רישיון נדחה: תוכנה אחרת, טלפון אחר, מפתח שורש אחר, תוכן ששונה, מערכת בת, וטקסט שאינו רישיון', () => {
  const lic = createLicense({ storage: withSeed(FX.seed), rootKeys: [FX.root], now: () => FX_NOW });
  assert.throws(() => lic.activate(FX.otherProduct), code('licNoFeature'));
  // טלפון אחר (מפתח אחר), וטלפון שעוד לא יצר בקשה
  assert.throws(() => device({ rootKeys: [FX.root], now: () => FX_NOW }).activate(FX.license), code('licOtherDevice'));
  assert.throws(() => createLicense({ storage: mem(), rootKeys: [FX.root], now: () => FX_NOW }).activate(FX.license), code('licOtherDevice'));
  // חתום במפתח שאינו מפתח השורש
  assert.throws(() => createLicense({ storage: withSeed(FX.seed), rootKeys: [ROOT], now: () => FX_NOW }).activate(FX.license), code('licNotSigned'));
  // הארכת התוקף ביד — החתימה כבר לא מתאימה
  const forged = JSON.parse(FX.license);
  forged.chain[0].payload.expiresAt += 365 * DAY_MS;
  assert.throws(() => lic.activate(JSON.stringify(forged)), code('licNotSigned'));
  const added = JSON.parse(FX.otherProduct);
  added.chain[0].payload.features.push('vidlearn');
  assert.throws(() => lic.activate(JSON.stringify(added)), code('licNotSigned'));
  // שרשרת של מערכת בת
  const chain = JSON.parse(FX.license);
  chain.chain.push(chain.chain[0]);
  assert.throws(() => lic.activate(JSON.stringify(chain)), code('licChild'));
  for (const junk of ['', 'שלום', '{}', '[]', 'null', FX.request, JSON.stringify({ type: PKG_LICENSE, chain: [{}] }), JSON.stringify({ type: PKG_LICENSE, chain: [{ payload: { v: 1 } }] })]) {
    assert.throws(() => lic.activate(junk), code('licBadFile'), junk);
  }
  assert.throws(() => lic.activate('x'.repeat(100001)), code('licBadFile'));
  // אף ניסיון שנדחה לא שינה את המצב
  assert.equal(lic.status().mode, 'trial');
  // readLicense בלי מפתחות שורש — הגרסה לא מוכנה לרישיונות
  assert.throws(() => readLicense(FX.license, { rootKeys: [] }), code('licNotReady'));
});

test('תוקף: פעיל ← תקופת חסד (עדיין פתוח) ← הסתיים (נעול); רישיון שהסתיים או שעוד לא התחיל לא מופעל', () => {
  const issuedAt = 1_000_000_000_000;
  const expiresAt = issuedAt + 365 * DAY_MS;
  let now = issuedAt + DAY_MS;
  const lic = device({ now: () => now });
  lic.activate(licenseFor());
  assert.equal(lic.status().state, 'active');
  now = expiresAt + 3 * DAY_MS;
  const grace = lic.status();
  assert.deepEqual({ mode: grace.mode, allowed: grace.allowed, state: grace.state, graceUntil: grace.graceUntil },
    { mode: 'licensed', allowed: true, state: 'grace', graceUntil: expiresAt + 7 * DAY_MS });
  now = expiresAt + 8 * DAY_MS;
  const ended = lic.status();
  assert.deepEqual({ mode: ended.mode, allowed: ended.allowed, until: ended.until }, { mode: 'expired', allowed: false, until: expiresAt });
  // החזרת השעון אחורה לא מחזירה את הרישיון
  now = issuedAt + DAY_MS;
  assert.equal(lic.status().mode, 'expired');
  // חידוש: רישיון חדש לאותו טלפון פותח שוב
  now = expiresAt + 8 * DAY_MS;
  lic.activate(licenseFor({ issuedAt: expiresAt, expiresAt: expiresAt + 365 * DAY_MS }));
  assert.equal(lic.status().mode, 'licensed');

  assert.throws(() => device({ now: () => expiresAt + 30 * DAY_MS }).activate(licenseFor()), code('licExpired'));
  assert.throws(() => device({ now: () => issuedAt - 2 * DAY_MS }).activate(licenseFor()), code('licNotYet'));
  // שעון הטלפון מאחר בכמה שעות מהשעון של מי שהנפיק — מתקבל
  assert.equal(device({ now: () => issuedAt - 5 * 60 * 60 * 1000 }).activate(licenseFor()).id, keyId(DEV_PUB));
  assert.equal(validity({ issuedAt, expiresAt, graceDays: 0 }, expiresAt + 1), 'expired');
});

test('רישיון שלא נשמר (אין מקום) — לא מופעל, והמצב הקודם נשאר', () => {
  const storage = withSeed(b64uEncode(DEV_SEED));
  const lic = createLicense({ storage, rootKeys: [ROOT], now: () => 1_000_000_000_000 + DAY_MS });
  lic.status();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => lic.activate(licenseFor()), code('licSaveFailed'));
  assert.equal(lic.status().mode, 'trial');
});

test('תקופת ניסיון: 30 יום מההפעלה הראשונה, תזכורת בשבוע האחרון, ואחריה נעול — גם אחרי הפעלה מחדש ושעון שהוחזר', () => {
  const start = 1_700_000_000_000;
  let now = start;
  const storage = mem();
  const lic = createLicense({ storage, rootKeys: [ROOT], now: () => now });
  assert.deepEqual(lic.status(), { mode: 'trial', allowed: true, daysLeft: 30, endsAt: start + 30 * DAY_MS, warn: false });
  now = start + 22 * DAY_MS + 1000;
  assert.deepEqual([lic.status().daysLeft, lic.status().warn], [8, false]);
  now = start + 23 * DAY_MS + 1000;
  assert.deepEqual([lic.status().daysLeft, lic.status().warn], [7, true]);
  now = start + 30 * DAY_MS - 1000;
  assert.deepEqual([lic.status().daysLeft, lic.status().allowed], [1, true]);
  now = start + 30 * DAY_MS;
  assert.deepEqual(lic.status(), { mode: 'trial_ended', allowed: false, endsAt: start + 30 * DAY_MS });
  // הפעלה מחדש עם שעון שהוחזר לתחילת הניסיון — עדיין נעול
  const again = createLicense({ storage, rootKeys: [ROOT], now: () => start + DAY_MS });
  assert.equal(again.status().mode, 'trial_ended');
  // תחילת הניסיון נשמרת: הפעלה מחדש באמצע לא מתחילה מחדש
  const s2 = mem();
  createLicense({ storage: s2, rootKeys: [ROOT], now: () => start }).status();
  assert.equal(createLicense({ storage: s2, rootKeys: [ROOT], now: () => start + 10 * DAY_MS }).status().daysLeft, 20);
  // שעון שנשאר מאחור לא מקפיא את הניסיון: כל הפעלה כזו מוסיפה שעה, וגם זמן הריצה נספר
  const s3 = mem();
  const at = (time) => createLicense({ storage: s3, rootKeys: [ROOT], now: () => time });
  at(start).status();
  assert.equal(at(start + 29 * DAY_MS).status().daysLeft, 1);
  for (let i = 1; i <= 23; i++) assert.equal(at(start).status().mode, 'trial', `הפעלה ${i} עם שעון מאחור`);
  assert.equal(at(start).status().mode, 'trial_ended');
  const s4 = mem();
  createLicense({ storage: s4, rootKeys: [ROOT], now: () => start }).status();
  createLicense({ storage: s4, rootKeys: [ROOT], now: () => start + 20 * DAY_MS }).status();
  let behind = start;
  const running = createLicense({ storage: s4, rootKeys: [ROOT], now: () => behind });
  assert.equal(running.status().mode, 'trial');
  behind = start + 11 * DAY_MS; // האפליקציה פתוחה 11 יום, והשעון עדיין מאחורי הזמן שכבר נראה
  assert.equal(running.status().mode, 'trial_ended');
  // תיקון שעון של כמה דקות אינו נחשב החזרה אחורה
  const s5 = mem();
  createLicense({ storage: s5, rootKeys: [ROOT], now: () => start }).status();
  createLicense({ storage: s5, rootKeys: [ROOT], now: () => start + 5 * DAY_MS }).status();
  const seenBefore = JSON.parse(s5.getItem(LICENSE_KEY)).seen;
  createLicense({ storage: s5, rootKeys: [ROOT], now: () => start + 5 * DAY_MS - 5 * 60 * 1000 }).status();
  assert.equal(JSON.parse(s5.getItem(LICENSE_KEY)).seen, seenBefore);
  // רישיון פותח גם אחרי שהניסיון הסתיים
  const late = createLicense({ storage: withSeed(b64uEncode(DEV_SEED)), rootKeys: [ROOT], now: () => now });
  late.status();
  now = start + 400 * DAY_MS;
  assert.equal(late.status().mode, 'trial_ended');
  late.activate(licenseFor({ issuedAt: now - DAY_MS, expiresAt: now + 365 * DAY_MS }));
  assert.equal(late.status().allowed, true);
});

test('בלי מפתחות שורש — אין רישוי והאפליקציה פתוחה; מצב שמור פגום לא מפיל', () => {
  const off = createLicense({ storage: mem(), rootKeys: [], now: () => 1 });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.status(), { mode: 'off', allowed: true });
  for (const raw of ['not json', '[]', '"x"', JSON.stringify({ seed: 'קצר', trialStart: -5, seen: 'מחר', license: 7 })]) {
    const lic = createLicense({ storage: mem({ [LICENSE_KEY]: raw }), rootKeys: [ROOT], now: () => 1_700_000_000_000 });
    assert.equal(lic.status().mode, 'trial', raw);
  }
});

test('המפתח של הטלפון לא יוצא ממנו: נשמר במפתח נפרד, לא בגיבוי ולא במצב שמסתנכרן', () => {
  assert.notEqual(LICENSE_KEY, STORAGE_KEY);
  const storage = mem();
  const lic = createLicense({ storage, rootKeys: [ROOT], now: () => 1_700_000_000_000, randomBytes: () => DEV_SEED });
  lic.request('משה');
  const store = createStore(storage);
  store.setSetting('lang', 'he');
  const seed = b64uEncode(DEV_SEED);
  assert.ok(storage.getItem(LICENSE_KEY).includes(seed));
  assert.equal(store.exportJson().includes(seed), false);
  assert.equal(String(storage.getItem(STORAGE_KEY)).includes(seed), false);
  // ייבוא גיבוי לא נוגע ברישיון
  const before = storage.getItem(LICENSE_KEY);
  store.importJson(store.exportJson());
  assert.equal(storage.getItem(LICENSE_KEY), before);
});

test('המסך: שער הרישיון בניווט, מסך הרישיון וכל הודעות השגיאה קיימות בשתי השפות', async () => {
  const app = fs.readFileSync(new URL('../www/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const gated = !license\.status\(\)\.allowed && first !== 'settings';/);
  assert.match(app, /case 'license': content = license\.enabled \? renderLicense\(\) : renderHome\(\); break;/);
  const { STRINGS } = await import('../www/js/i18n.js');
  const lib = fs.readFileSync(new URL('../www/js/license.js', import.meta.url), 'utf8');
  const codes = [...new Set([...lib.matchAll(/LicenseError\('(lic[A-Za-z]+)'\)/g)].map((m) => m[1]))];
  assert.ok(codes.length >= 9);
  const used = [...new Set([...app.matchAll(/tr\('(lic[A-Za-z]*|license)'/g)].map((m) => m[1]))];
  for (const k of [...codes, ...used]) for (const lang of ['he', 'en']) assert.ok(STRINGS[lang][k], `${lang}: ${k}`);
});
