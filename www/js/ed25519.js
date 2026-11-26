// SHA-256, SHA-512 ו-Ed25519 (RFC 8032) ב-JavaScript טהור — אותו קוד כמו ב-SuperSuite (shell/licensing/crypto-lite.js שם),
// כדי שחתימת רישיון שנוצרה במרכז הרישוי תאומת כאן בייט-לבייט. בלי תלות ב-WebCrypto: Ed25519 אינו קיים ב-WebView ישן.
// אינו קבוע-זמן: מתאים לאימות רישיון ולמפתח המכשיר, לא לשרת שחשוף לתזמון.

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(String(s));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64uEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) s += B64[n & 63];
  }
  return s;
}
function b64uDecode(str) {
  const s = String(str).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (/[^A-Za-z0-9_-]/.test(s) || s.length % 4 === 1) throw new Error('קידוד base64url לא תקין');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12)
      | ((i + 2 < s.length ? B64.indexOf(s[i + 2]) : 0) << 6) | (i + 3 < s.length ? B64.indexOf(s[i + 3]) : 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out;
}

/* ---------- SHA-256 (FIPS 180-4) ---------- */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function pad(msg, blockBytes, lenBytes) {
  const bitLen = BigInt(msg.length) * 8n;
  const total = Math.ceil((msg.length + 1 + lenBytes) / blockBytes) * blockBytes;
  const out = new Uint8Array(total);
  out.set(msg);
  out[msg.length] = 0x80;
  for (let i = 0; i < lenBytes; i++) out[total - 1 - i] = Number((bitLen >> BigInt(8 * i)) & 255n);
  return out;
}

function sha256(msg) {
  const m = pad(msg, 64, 8);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = H[i] >>> 16; out[4 * i + 2] = H[i] >>> 8; out[4 * i + 3] = H[i]; }
  return out;
}

/* ---------- SHA-512 (FIPS 180-4), מילים של 64 ביט ב-BigInt ---------- */
const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019',
  '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3',
  '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725',
  '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001',
  'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb',
  '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207',
  'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a',
  '5fcb6fab3ad6faec', '6c44198c4a475817',
].map(h => BigInt('0x' + h));
const M64 = (1n << 64n) - 1n;

function sha512(msg) {
  const m = pad(msg, 128, 16);
  const H = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1',
    '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map(h => BigInt('0x' + h));
  const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
  const W = new Array(80);
  for (let off = 0; off < m.length; off += 128) {
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let j = 0; j < 8; j++) w = (w << 8n) | BigInt(m[off + 8 * i + j]);
      W[i] = w;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(W[i - 15], 1n) ^ rotr(W[i - 15], 8n) ^ (W[i - 15] >> 7n);
      const s1 = rotr(W[i - 2], 19n) ^ rotr(W[i - 2], 61n) ^ (W[i - 2] >> 6n);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + ((e & f) ^ (~e & M64 & g)) + K512[i] + W[i]) & M64;
      const t2 = ((rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    const v = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) H[i] = (H[i] + v[i]) & M64;
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out[8 * i + j] = Number((H[i] >> BigInt(56 - 8 * j)) & 255n);
  return out;
}

/* ---------- Ed25519 (RFC 8032 §5.1) ---------- */
const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function powMod(b, e, m = P) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const inv = (a) => powMod(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
const SQRT_M1 = powMod(2n, (P - 1n) / 4n);
const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
const BASE = [BX, BY, 1n, mod(BX * BY)];
const ZERO = [0n, 1n, 1n, 0n];

// חיבור נקודות בקואורדינטות מורחבות (a = -1). הנוסחה אחידה — משמשת גם להכפלה
function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
  const A = mod((Y1 - X1) * (Y2 - X2)), B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(T1 * D2 * T2), Dd = mod(Z1 * 2n * Z2);
  const E = B - A, F = Dd - C, G = Dd + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function mul(point, n) {
  let r = ZERO, q = point;
  while (n > 0n) { if (n & 1n) r = add(r, q); q = add(q, q); n >>= 1n; }
  return r;
}
const leToInt = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const intToLe = (n, len = 32) => { const o = new Uint8Array(len); for (let i = 0; i < len; i++) { o[i] = Number(n & 255n); n >>= 8n; } return o; };

function encodePoint([X, Y, Z]) {
  const zi = inv(Z);
  const x = mod(X * zi), y = mod(Y * zi);
  const out = intToLe(y);
  if (x & 1n) out[31] |= 0x80;
  return out;
}
function decodePoint(bytes) {
  if (bytes.length !== 32) return null;
  const b = Uint8Array.from(bytes);
  const sign = (b[31] >> 7) & 1;
  b[31] &= 0x7f;
  const y = leToInt(b);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
  let x = powMod(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * SQRT_M1);
  if (mod(x * x) !== x2) return null;
  if (x === 0n && sign) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}

function expandSeed(seed) {
  const h = sha512(seed);
  const a = Uint8Array.from(h.subarray(0, 32));
  a[0] &= 248; a[31] &= 127; a[31] |= 64;
  return { scalar: leToInt(a), prefix: h.subarray(32) };
}

function getPublicKey(seed) {
  if (seed.length !== 32) throw new Error('מפתח פרטי באורך שגוי');
  return encodePoint(mul(BASE, expandSeed(seed).scalar));
}

function sign(msg, seed) {
  const { scalar, prefix } = expandSeed(seed);
  const A = encodePoint(mul(BASE, scalar));
  const r = mod(leToInt(sha512(concat(prefix, msg))), L);
  const R = encodePoint(mul(BASE, r));
  const k = mod(leToInt(sha512(concat(R, A, msg))), L);
  return concat(R, intToLe(mod(r + k * scalar, L)));
}

// אימות ללא כפל ב-cofactor, כמו ב-OpenSSL (node:crypto): [S]B == R + [k]A
function verify(sig, msg, pub) {
  if (sig.length !== 64 || pub.length !== 32) return false;
  const A = decodePoint(pub);
  const R = decodePoint(sig.subarray(0, 32));
  if (!A || !R) return false;
  const S = leToInt(sig.subarray(32));
  if (S >= L) return false;
  const k = mod(leToInt(sha512(concat(sig.subarray(0, 32), pub, msg))), L);
  const lhs = encodePoint(mul(BASE, S));
  const rhs = encodePoint(add(R, mul(A, k)));
  return lhs.every((v, i) => v === rhs[i]);
}

export { utf8, concat, b64uEncode, b64uDecode, sha256, sha512 };
export const ed25519 = { getPublicKey, sign, verify };
