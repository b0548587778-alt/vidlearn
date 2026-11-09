import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, blockedBy, blockedText, queryBlocked, blockedHost, looksEducational, mergeResults, parseWordList } from '../www/js/filter.js';

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

test('סקירה: מילה אסורה בעברית לא תופסת מילה ארוכה יותר', () => {
  assert.equal(blockedBy(v('שיעור גאוגרפיה: קליפורניה')), null);
  assert.ok(blockedBy(v('קליפים מצחיקים')));
  assert.ok(blockedBy(v('הקליפ החדש')));
});

test('סקירה: אותה כותרת בלי משך ידוע — לא מתאחדים', () => {
  const out = mergeResults([[v('Lesson 1', { id: 'youtube:a' }), v('Lesson 1', { id: 'youtube:b' })]]);
  assert.equal(out.length, 2);
});

test('כתיב עוקף: אותיות מסוגננות, ספרות, נקודות, ניקוד ותווים נסתרים', () => {
  for (const t of ['s.e.x tips', 'p0rn', '𝐬𝐞𝐱𝐲 video', 'ｎｕｄｅ', 'ס.ק.ס', 'סֶקְס', 'por​n', 'f**k this', 'hot 🔞', 'S E X']) {
    assert.ok(blockedText(t), t);
  }
});

test('בלי חסימת שווא: שיעורי תורה ומדע', () => {
  for (const t of ['History of Essex', 'בורא מיני מזונות', 'פיטום הקטורת — סמים', 'שיעור על הקליפה', 'Romance languages', 'Physics lesson 4x4', 'Mp3 lecture', 'שמירת הלשון ורכילות', 'מסיבה זו', 'ישוב הארץ']) {
    assert.equal(blockedText(t), null, t);
  }
});

test('חיפוש אסור, סימון של המקור ואתר אסור', () => {
  assert.ok(queryBlocked('p 0 r n'));
  assert.equal(queryBlocked('שיעור בגמרא'), null);
  assert.equal(isAllowed(v('Algebra lesson', { nsfw: true })), false);
  assert.equal(isAllowed(v('Algebra lesson', { familyFriendly: false })), false);
  assert.equal(blockedHost('https://www.xvideos.com/a.mp4'), true);
  assert.equal(blockedHost('https://archive.org/download/a/b.mp4'), false);
});
