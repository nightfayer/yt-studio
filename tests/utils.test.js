'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../shared/utils.js');

test('repairFilename strips illegal Windows chars, control chars, and trailing dots', () => {
  assert.equal(utils.repairFilename('Video: <Test>? | "Name".mp4'), 'Video Test Name.mp4');
  assert.equal(utils.repairFilename('...hidden~file... .mp3'), 'hidden~file.mp3');
  assert.equal(utils.repairFilename('???|.m4a'), 'yts-download.m4a');
});

test('repairFilename protects reserved Windows device names and 8.3 tilde names', () => {
  assert.equal(utils.repairFilename('CON.mp4'), '_CON.mp4');
  assert.equal(utils.repairFilename('nul.mp3'), '_nul.mp3');
  assert.equal(utils.repairFilename('ABCD~1.MP3'), 'ABCD-1.MP3');
});

test('repairFilename truncates by code points without leaving lone surrogates', () => {
  const emojiTitle = `${'😀'.repeat(130)}.mp4`;
  const repaired = utils.repairFilename(emojiTitle);
  assert.ok(repaired.endsWith('.mp4'));
  assert.equal([...repaired.slice(0, -4)].length, 120);
  // Ensure no lone surrogate remains
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(repaired), false);
});

test('detectPlatform identifies platforms by URL and fallback filename', () => {
  assert.equal(utils.detectPlatform('https://www.youtube.com/watch?v=123', 'video.mp4'), 'YouTube');
  assert.equal(utils.detectPlatform('https://www.instagram.com/reel/abc/', 'clip.mp4'), 'Instagram');
  assert.equal(utils.detectPlatform('https://www.tiktok.com/@user/video/1', 'clip.mp4'), 'TikTok');
  assert.equal(utils.detectPlatform('https://rutube.ru/video/1/', 'clip.mp4'), 'Rutube');
  assert.equal(utils.detectPlatform('https://www.twitch.tv/videos/1', 'clip.mp4'), 'Twitch');
  assert.equal(utils.detectPlatform('https://vkvideo.ru/video-1_2', 'clip.mp4'), 'VK');
  assert.equal(utils.detectPlatform('https://coub.com/view/abc', 'clip.mp4'), 'Coub');
  assert.equal(utils.detectPlatform('https://zvuk.com/track/1', 'track.flac'), 'Zvuk');
  assert.equal(utils.detectPlatform('', 'TikTok - author.mp4'), 'TikTok');
  assert.equal(utils.detectPlatform('', 'post_cover.jpg'), 'Instagram');
});

test('formatBytes formats sizes in KB and MB and handles empty values', () => {
  assert.equal(utils.formatBytes(0), '');
  assert.equal(utils.formatBytes(NaN), '');
  assert.equal(utils.formatBytes(512_000), '512 КБ');
  assert.equal(utils.formatBytes(2_500_000), '2.5 МБ');
});

test('fetchWithFallback tries omit, default, and include credentials', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(opts.credentials ?? 'default');
    if (opts.credentials === 'include') {
      return { ok: true, status: 200 };
    }
    throw new TypeError('Failed to fetch');
  };

  try {
    const res = await utils.fetchWithFallback('https://cdn.example.com/video.mp4');
    assert.equal(res.ok, true);
    assert.deepEqual(calls, ['omit', 'default', 'include']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBytesWithResume resumes via Range after mid-stream failure', async () => {
  const originalFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async (_url, opts) => {
    attempt++;
    if (attempt === 1) {
      assert.equal(opts.headers, undefined);
      let chunkSent = false;
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-length', '6']]),
        body: {
          getReader() {
            return {
              async read() {
                if (!chunkSent) {
                  chunkSent = true;
                  return { done: false, value: new Uint8Array([1, 2, 3]) };
                }
                throw new Error('network drop');
              },
            };
          },
        },
      };
    }
    assert.equal(opts.headers?.Range, 'bytes=3-');
    return {
      ok: true,
      status: 206,
      headers: new Map([['content-length', '3']]),
      async arrayBuffer() {
        return new Uint8Array([4, 5, 6]).buffer;
      },
    };
  };

  try {
    const result = await utils.fetchBytesWithResume('https://cdn.example.com/media.mp4', {
      attempts: 3,
      declaredSize: 6,
      concurrency: 1,
    });
    assert.deepEqual(Array.from(result), [1, 2, 3, 4, 5, 6]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBytesWithResume downloads multi-chunk Range requests in parallel', async () => {
  const originalFetch = globalThis.fetch;
  const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const rangesRequested = [];

  globalThis.fetch = async (_url, opts) => {
    const range = opts.headers?.Range;
    rangesRequested.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    const start = Number(match[1]);
    const end = Math.min(payload.length - 1, Number(match[2]));
    const slice = payload.slice(start, end + 1);
    return {
      ok: true,
      status: 206,
      headers: new Map([['content-range', `bytes ${start}-${end}/${payload.length}`]]),
      async arrayBuffer() {
        return slice.buffer;
      },
    };
  };

  try {
    const result = await utils.fetchBytesWithResume('https://cdn.example.com/parallel.mp4', {
      concurrency: 3,
      chunkSize: 4,
    });
    assert.deepEqual(Array.from(result), Array.from(payload));
    assert.deepEqual(rangesRequested, ['bytes=0-3', 'bytes=4-7', 'bytes=8-9']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
