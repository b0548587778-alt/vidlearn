import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, blockedBy, looksEducational, mergeResults, parseWordList } from '../www/js/filter.js';

const v = (title, extra = {}) => ({ id: title, title, description: '', author: '', tags: [], ...extra });

test('מילה אסורה פוסלת, גם בתיאור ובתגיות', () => {
  assert.ok(blockedBy(v('Funny prank compilation')));
  assert.ok(blockedBy(v('Calculus', { tags: ['casino'] })));
  assert.equal(isAllowed(v('Algebra lesson 1')), true);
});

test('מילה שלמה בלבד — classical לא נפסל בגלל class, Essex לא בגלל sex', () => {
  assert.equal(blockedBy(v('History of Essex county')), null);
  assert.equal(looksEducational(v('classical era')), false);
  assert.equal(looksEducational(v('Physics class 3')), true);
});

test('עברית עם תחיליות', () => {
  assert.ok(looksEducational(v('בשיעור הזה נלמד שברים')));
  assert.ok(looksEducational(v('הרצאה על כימיה')));
});

test('מקור בלי קטגוריית חינוך / מצב מחמיר — דורש מילת לימוד', () => {
  assert.equal(isAllowed(v('Sunset timelapse'), { keywordFilter: true }), false);
  assert.equal(isAllowed(v('Sunset timelapse')), true);
  assert.equal(isAllowed(v('Sunset timelapse'), { strict: true }), false);
  assert.equal(isAllowed(v('Geometry tutorial'), { strict: true }), true);
});

test('מילים נוספות של המשתמש', () => {
  assert.equal(isAllowed(v('Lesson about football'), { extraBlock: parseWordList('football, cars') }), false);
});

test('מיזוג לסירוגין בלי כפילויות', () => {
  const a = [v('A1'), v('Same', { id: 'x1', duration: 300 })];
  const b = [v('B1'), v('same', { id: 'x2', duration: 302 })];
  const out = mergeResults([a, b]).map((x) => x.title);
  assert.deepEqual(out, ['A1', 'B1', 'Same']);
});
