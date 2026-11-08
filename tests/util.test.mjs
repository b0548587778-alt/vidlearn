import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIsoDuration, parseDuration, formatDuration, safeUrl } from '../www/js/util.js';

test('משכים', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('P1DT1M'), 86460);
  assert.equal(parseIsoDuration('garbage'), 0);
  assert.equal(parseDuration('5 min'), 300);
  assert.equal(formatDuration(3723), '1:02:03');
});

test('רק https', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('http://a.b/'), '');
  assert.equal(safeUrl('https://a.b/x'), 'https://a.b/x');
});
