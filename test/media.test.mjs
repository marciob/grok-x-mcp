// Tests for lib/media.js: the media of each provider, the text lines, and the image download.
// Fixtures: real answers of mdfromx (thread of 2022753794891878460) and SocialAPI (2022753797185913015),
// saved on 2026-11-24, and an X API v2 answer in the shape of the Grokbot x_search skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fromMdfromxMedia, fromSocialapiMedia, fromV2Media, mediaLines, fetchImages, downloadUrl } from '../src/media.mjs';

const fx = f => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const PHOTO = 'https://pbs.twimg.com/media/HBJDz1rbMAAwjQh.jpg?name=orig';

test('mdfromx: the thread keeps the photo of the second post, and the first post has none', () => {
  const [a, b] = fx('mdfromx-thread-2022753794891878460.json').posts;
  assert.deepEqual(fromMdfromxMedia(a), []);
  assert.deepEqual(fromMdfromxMedia(b), [{ type: 'photo', url: PHOTO, preview: PHOTO, alt: null, width: 1502, height: 1196, duration_ms: null }]);
});

test('mdfromx: video with variants, alt text, duration in seconds', () => {
  const m = fromMdfromxMedia({ media: { all: [
    { type: 'video', url: 'https://video.twimg.com/low.mp4', thumbnail_url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg', width: 1280, height: 720, duration: 12.5,
      variants: [{ url: 'https://video.twimg.com/a.m3u8', content_type: 'application/x-mpegURL' }, { url: 'https://video.twimg.com/low.mp4', content_type: 'video/mp4', bitrate: 256000 }, { url: 'https://video.twimg.com/high.mp4', content_type: 'video/mp4', bitrate: 2176000 }] },
    { type: 'photo', url: 'https://pbs.twimg.com/media/X1.png', altText: 'A chart of costs' },
  ] } });
  assert.equal(m[0].url, 'https://video.twimg.com/high.mp4');
  assert.equal(m[0].preview, 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg');
  assert.equal(m[0].duration_ms, 12500);
  assert.equal(m[1].alt, 'A chart of costs');
  assert.equal(m[1].url, 'https://pbs.twimg.com/media/X1.png?name=orig');
});

test('SocialAPI: the same photo, with size from original_info', () => {
  const m = fromSocialapiMedia(fx('socialapi-2022753797185913015.json'));
  assert.deepEqual(m, [{ type: 'photo', url: PHOTO, preview: PHOTO, alt: null, width: 1502, height: 1196, duration_ms: null }]);
});

test('X API v2 (Grokbot): media_keys join includes.media, in order, with alt text', () => {
  const inc = [
    { media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/P1.jpg', width: 800, height: 600, alt_text: 'A cat' },
    { media_key: '7_2', type: 'video', preview_image_url: 'https://pbs.twimg.com/amplify_video_thumb/2/img/v.jpg', duration_ms: 9000, variants: [{ url: 'https://video.twimg.com/v.mp4', content_type: 'video/mp4', bitrate: 832000 }] },
  ];
  const m = fromV2Media({ attachments: { media_keys: ['7_2', '3_1', '3_missing'] } }, inc);
  assert.equal(m.length, 2);
  assert.equal(m[0].type, 'video');
  assert.equal(m[0].url, 'https://video.twimg.com/v.mp4');
  assert.equal(m[1].alt, 'A cat');
  assert.deepEqual(fromV2Media({}, inc), []);
});

test('text lines give type, size, URL and alt (none when absent)', () => {
  const [, b] = fx('mdfromx-thread-2022753794891878460.json').posts;
  const media = fromMdfromxMedia(b);
  assert.deepEqual(mediaLines(media), [`  media 1: photo 1502x1196 ${PHOTO} · alt: none`]);
  assert.match(mediaLines(media, new Map([[media[0], 1]]))[0], /attached as image 1$/);
});

test('downloadUrl: only pbs.twimg.com images, at name=medium', () => {
  assert.equal(downloadUrl(PHOTO), 'https://pbs.twimg.com/media/HBJDz1rbMAAwjQh?format=jpg&name=medium');
  assert.equal(downloadUrl('https://pbs.twimg.com/media/A1?format=png&name=orig'), 'https://pbs.twimg.com/media/A1?format=png&name=medium');
  assert.equal(downloadUrl('https://evil.example/media/x.jpg'), null);
  assert.equal(downloadUrl('http://pbs.twimg.com/media/x.jpg'), null);
  assert.equal(downloadUrl('https://video.twimg.com/v.mp4'), null);
});

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const fakeFetch = map => async url => {
  const r = map[url];
  if (!r) return new Response('no', { status: 404 });
  if (r === 'throw') throw new Error('network down');
  return new Response(r.body, { status: 200, headers: { 'content-type': r.type } });
};

test('fetchImages: base64 with the right MIME; failures become notes and do not stop the others', async () => {
  const posts = [{ media: [
    { type: 'photo', url: 'https://pbs.twimg.com/media/OK.jpg?name=orig' },
    { type: 'photo', url: 'https://pbs.twimg.com/media/GONE.jpg?name=orig' },
    { type: 'photo', url: 'https://pbs.twimg.com/media/HTML.jpg?name=orig' },
    { type: 'photo', url: 'https://pbs.twimg.com/media/BIG.jpg?name=orig' },
  ] }, { media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/LATE.jpg' }] }];
  const r = await fetchImages(posts, { maxBytes: 10 }, fakeFetch({
    'https://pbs.twimg.com/media/OK?format=jpg&name=medium': { body: jpeg, type: 'image/jpeg' },
    'https://pbs.twimg.com/media/HTML?format=jpg&name=medium': { body: '<html>', type: 'text/html' },
    'https://pbs.twimg.com/media/BIG?format=jpg&name=medium': { body: Buffer.alloc(50), type: 'image/jpeg' },
  }));
  assert.deepEqual(r.images, [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }]);
  assert.equal(r.attached.get(posts[0].media[0]), 1);
  assert.equal(r.notes.length, 3);
  assert.match(r.notes.join('\n'), /HTTP 404[\s\S]*not an image \(text\/html\)[\s\S]*too big/);
  assert.ok(!r.notes.join('').includes('LATE'), 'the 5th image is over maxImages and is not fetched');
});

test('fetchImages: a post with no media fetches nothing', async () => {
  let called = false;
  const r = await fetchImages([{ media: [] }, {}], {}, async () => { called = true; });
  assert.equal(called, false);
  assert.deepEqual(r.images, []);
});
