import test from 'node:test';
import assert from 'node:assert/strict';
import { explainError, errorDetail } from '../www/js/errors.js';
import { STRINGS } from '../www/js/i18n.js';

test('שגיאות טכניות ← הסבר ברור', () => {
  assert.equal(explainError('yt-unavailable: YouTube probably temporarily blocked anonymous watch access with this IP'), 'errYtBlocked');
  assert.equal(explainError('Sign in to confirm you’re not a bot'), 'errYtBlocked');
  assert.equal(explainError('http-403'), 'errForbidden');
  assert.equal(explainError('blocked'), 'errBlocked');
  assert.equal(explainError('limit'), 'errLimit');
  assert.equal(explainError('no-file'), 'errNoFile');
  assert.equal(explainError('timeout'), 'errTimeout');
  assert.equal(explainError('java.net.UnknownHostException: Unable to resolve host'), 'errNetwork');
  assert.equal(explainError('yt-unavailable'), 'errYtUnavailable');
  assert.equal(explainError('yt-unavailable: something odd'), 'errYtUnavailable');
  assert.equal(explainError('weird'), 'errGeneric');
  assert.equal(explainError('deliver failed'), 'errGeneric', 'live רק כמילה שלמה');
});

test('כל ההסברים מתורגמים, והפרטים הטכניים בלי הקידומת', () => {
  for (const k of ['errYtBlocked', 'errForbidden', 'errNoFile', 'errTimeout', 'errNetwork', 'errFile', 'errBlocked', 'errLimit', 'errYtUnavailable', 'errGeneric']) {
    assert.ok(STRINGS.he[k] && STRINGS.en[k], k);
  }
  assert.equal(errorDetail('yt-unavailable: abc'), 'abc');
  assert.equal(errorDetail('blocked'), '');
});
