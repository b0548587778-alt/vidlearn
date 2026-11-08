import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPodcastSearchUrl, parsePodcastResults, parsePodcastFeed, isEducationalPodcast } from '../www/js/podcasts.js';
import { searchMedia } from '../www/js/search.js';
import { canDownload } from '../www/js/sources.js';
import { itemHash, isMediaItem } from '../www/js/media.js';
import { defaultState } from '../www/js/store.js';

const pod = (over = {}) => ({
  kind: 'podcast', collectionId: 1, collectionName: 'עושים היסטוריה', artistName: 'רן', feedUrl: 'https://feed.example/rss',
  artworkUrl600: 'https://img.example/a.jpg', genreIds: ['1487', '26'], genres: ['History', 'Podcasts'], primaryGenreName: 'History',
  collectionExplicitness: 'notExplicit', trackCount: 300, ...over,
});

test('חיפוש פודקאסטים: עברית ← החנות הישראלית; בלי תוכן בוטה', () => {
  const u = new URL(buildPodcastSearchUrl('היסטוריה'));
  assert.equal(u.host, 'itunes.apple.com');
  assert.equal(u.searchParams.get('country'), 'il');
  assert.equal(u.searchParams.get('media'), 'podcast');
  assert.equal(u.searchParams.get('explicit'), 'No');
  assert.equal(new URL(buildPodcastSearchUrl('history')).searchParams.get('country'), 'us');
  assert.throws(() => buildPodcastSearchUrl('  '));
});

test('רק קטגוריות לימודיות: קומדיה / פשע אמיתי / בוטה נפסלים', () => {
  assert.equal(isEducationalPodcast(pod()), true);
  assert.equal(isEducationalPodcast(pod({ genreIds: ['1303', '26'] })), false, 'קומדיה');
  assert.equal(isEducationalPodcast(pod({ genreIds: ['1487', '1488'] })), false, 'היסטוריה + פשע אמיתי');
  assert.equal(isEducationalPodcast(pod({ collectionExplicitness: 'explicit' })), false);
  assert.equal(isEducationalPodcast(pod({ genreIds: ['1310'] })), false, 'מוזיקה');
});

test('פירוק תוצאות: פריט אחיד, בלי פיד https ← מדולג, דפדוף', () => {
  const results = [pod(), pod({ collectionId: 2, feedUrl: 'http://insecure/rss' }), pod({ collectionId: 3, genreIds: ['1303'] })];
  const r = parsePodcastResults({ results }, 0);
  assert.equal(r.items.length, 1);
  assert.equal(r.filtered, 1);
  const it = r.items[0];
  assert.equal(it.id, 'podcast:1');
  assert.equal(it.kind, 'podcast');
  assert.equal(it.play.url, 'https://feed.example/rss');
  assert.deepEqual(it.tags, ['History']);
  assert.equal(r.next, null);
  assert.ok(isMediaItem(it));
  assert.equal(itemHash(it), '#/listen/podcast%3A1');
  // 24 תוצאות שהן המקסימום שביקשנו ← אולי יש עוד
  const many = Array.from({ length: 24 }, (_, i) => pod({ collectionId: 100 + i }));
  assert.equal(parsePodcastResults({ results: many }, 0).next, 1);
});

const FEED = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title >עושים היסטוריה</title>
<description ><![CDATA[<p>פודקאסט על <b>היסטוריה</b> &amp; מדע</p>]]></description>
<itunes:image href='https://img.example/big.jpg'/>
<item><title >פרק 2: &quot;הרומאים&quot;</title><guid>ep-2</guid><pubDate>Tue, 02 Jan 2024 10:00:00 +0000</pubDate>
<itunes:duration>01:02:03</itunes:duration><enclosure url="https://cdn.example/ep2.mp3?x=1&amp;y=2" length="1000" type="audio/mpeg"/></item>
<item><title>פרק 1</title><guid isPermaLink="false">ep-1</guid><pubDate>Mon, 01 Jan 2024 10:00:00 +0000</pubDate>
<itunes:duration>1800</itunes:duration><enclosure type="audio/mp4" url="https://cdn.example/ep1.m4a" length="500"/></item>
<item><title>סרטון</title><enclosure url="https://cdn.example/v.mp4" type="video/mp4"/></item>
<item><title>לא מאובטח</title><enclosure url="http://cdn.example/e.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

test('פרקי פודקאסט מה-RSS: רק שמע ב-https, ישויות, משך, מזהה יציב לפי guid', () => {
  const p = { id: 'podcast:1', sourceName: 'History' };
  const { episodes, description, thumb } = parsePodcastFeed(p, FEED);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].title, 'פרק 2: "הרומאים"');
  assert.equal(episodes[0].url, 'https://cdn.example/ep2.mp3?x=1&y=2');
  assert.equal(episodes[0].duration, 3723);
  assert.equal(episodes[1].duration, 1800);
  assert.equal(episodes[0].id, 'podcast:1#ep-2');
  assert.equal(episodes[0].bookId, 'podcast:1');
  assert.equal(episodes[0].kind, 'chapter');
  assert.equal(episodes[0].sourceType, 'audio');
  assert.ok(canDownload(episodes[0]), 'אפשר לשמור פרק בטלפון');
  assert.equal(description, 'פודקאסט על היסטוריה & מדע');
  assert.equal(thumb, 'https://img.example/big.jpg');
});

test('פודקאסט סדרתי (serial) — מהפרק הראשון', () => {
  const xml = FEED.replace('<title >עושים', '<itunes:type>serial</itunes:type><title >עושים');
  const { episodes } = parsePodcastFeed({ id: 'podcast:1' }, xml);
  assert.deepEqual(episodes.map((e) => e.title), ['פרק 1', 'פרק 2: "הרומאים"']);
  assert.deepEqual(episodes.map((e) => e.index), [0, 1]);
});

test('searchMedia podcast: סינון מילים אסורות מעל הקטגוריות', async () => {
  const settings = defaultState().settings;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ results: [pod(), pod({ collectionId: 2, collectionName: 'Casino history' })] }) });
  const r = await searchMedia('podcast', 'היסטוריה', settings, { fetchImpl });
  assert.deepEqual(r.items.map((v) => v.id), ['podcast:1']);
  assert.equal(r.filtered, 1);
});

test('סקירה: קישור לפרק פודקאסט לפי מזהה (לא לפי מיקום שמשתנה)', () => {
  assert.equal(itemHash({ kind: 'chapter', bookId: 'podcast:1', id: 'podcast:1#ep-2', index: 0 }), '#/listen/podcast%3A1?ep=podcast%3A1%23ep-2');
  assert.equal(itemHash({ kind: 'chapter', bookId: 'audio:x', id: 'audio:x#3', index: 2 }), '#/listen/audio%3Ax?ch=2');
});

test('סקירה: מספר המסוננים נספר רק בחלק החדש של כל עמוד', () => {
  const results = Array.from({ length: 48 }, (_, i) => pod({ collectionId: i + 1, genreIds: i % 4 === 0 ? ['1303'] : ['1487'] }));
  const p0 = parsePodcastResults({ results: results.slice(0, 24) }, 0);
  const p1 = parsePodcastResults({ results }, 1);
  assert.equal(p0.filtered, 6);
  assert.equal(p1.filtered, 6, 'רק 24 החדשים');
});

test('סקירה: פודקאסט בלי פיד https ← שגיאה, לא בקשה לכתובת ריקה', async () => {
  const { fetchPodcastEpisodes } = await import('../www/js/search.js');
  let called = false;
  await assert.rejects(fetchPodcastEpisodes({ id: 'podcast:1', play: { url: 'http://x/rss' } }, { fetchImpl: async () => { called = true; } }), /no-feed/);
  assert.equal(called, false);
});
