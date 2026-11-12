'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const utils = require('../shared/utils.js');

const ROOT = path.resolve(__dirname, '..');

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('real HTTP download via fetchBytesWithResume (4 parallel Range workers)', async () => {
  const payload = Buffer.alloc(100 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;

  let rangeHits = 0;
  const { server, baseUrl } = await startTestServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      rangeHits++;
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(match[1]);
      const end = match[2] ? Math.min(payload.length - 1, Number(match[2])) : payload.length - 1;
      const chunk = payload.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(chunk);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(payload.length),
    });
    res.end(payload);
  });

  try {
    const progressValues = [];
    const downloaded = await utils.fetchBytesWithResume(`${baseUrl}/video.mp4`, {
      concurrency: 4,
      chunkSize: 16 * 1024,
      onProgress: (p) => progressValues.push(p),
    });

    assert.equal(downloaded.length, payload.length);
    assert.equal(Buffer.compare(Buffer.from(downloaded), payload), 0);
    assert.ok(rangeHits >= 4, `expected parallel range requests, got ${rangeHits}`);
    assert.equal(progressValues[progressValues.length - 1], 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('real HTTP download falls back cleanly when server ignores Range (200 OK)', async () => {
  const payload = Buffer.from('YTStudio-Fallback-Stream-Payload-2026');
  const { server, baseUrl } = await startTestServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(payload.length),
    });
    res.end(payload);
  });

  try {
    const downloaded = await utils.fetchBytesWithResume(`${baseUrl}/fallback.mp4`, {
      concurrency: 4,
      chunkSize: 10,
    });
    assert.equal(Buffer.compare(Buffer.from(downloaded), payload), 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('background.js yts-save routes downloads to platform subfolders and sanitizes filenames', async () => {
  const downloadCalls = [];
  const storageData = {
    yts_settings: { subfolders: true },
    yts_download_ids: [],
  };
  const messageListeners = [];

  const sandbox = vm.createContext({
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    URL,
    Promise,
    Map,
    Set,
    JSON,
    Math,
    Date,
    RegExp,
    Error,
    AbortSignal,
    fetch: async () => ({ ok: false, status: 404, headers: new Map() }),
    importScripts: (...paths) => {
      for (const p of paths) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), sandbox, { filename: p });
      }
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '2.3.4' }),
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        sendMessage: async () => ({ ok: true }),
      },
      storage: {
        local: {
          get: async (keys) => {
            if (typeof keys === 'string') return { [keys]: storageData[keys] };
            return { ...storageData };
          },
          set: async (patch) => Object.assign(storageData, patch),
          remove: async (k) => { delete storageData[k]; },
        },
      },
      alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
      downloads: {
        download: async (opts) => {
          downloadCalls.push(opts);
          return downloadCalls.length;
        },
        search: async ({ id }) => [{ id, state: 'complete', totalBytes: 1024, bytesReceived: 1024 }],
        onChanged: { addListener: () => {} },
      },
      commands: { onCommand: { addListener: () => {} } },
      tabs: { query: async () => [] },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    },
  });
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, {
    filename: 'background.js',
  });

  const onMessage = messageListeners[0];
  assert.ok(typeof onMessage === 'function');

  const cases = [
    { tabUrl: 'https://www.youtube.com/watch?v=1', rawName: 'Video: Test?.mp4', expected: 'YT Studio/YouTube/Video Test.mp4' },
    { tabUrl: 'https://www.instagram.com/reel/1/', rawName: 'Reel|Clip.mp4', expected: 'YT Studio/Instagram/Reel Clip.mp4' },
    { tabUrl: 'https://www.tiktok.com/@u/video/1', rawName: 'TikTok - Clip.mp4', expected: 'YT Studio/TikTok/TikTok - Clip.mp4' },
    { tabUrl: 'https://vk.ru/video-1_2', rawName: 'VK - Movie.mp4', expected: 'YT Studio/VK/VK - Movie.mp4' },
    { tabUrl: 'https://rutube.ru/video/1/', rawName: 'Rutube - Show.mp4', expected: 'YT Studio/Rutube/Rutube - Show.mp4' },
    { tabUrl: 'https://www.twitch.tv/videos/1', rawName: 'Twitch - Stream.mp4', expected: 'YT Studio/Twitch/Twitch - Stream.mp4' },
    { tabUrl: 'https://coub.com/view/1', rawName: 'Coub - Loop.mp4', expected: 'YT Studio/Coub/Coub - Loop.mp4' },
    { tabUrl: 'https://zvuk.com/track/1', rawName: 'CON.flac', expected: 'YT Studio/Zvuk/_CON.flac' },
  ];

  for (const c of cases) {
    const res = await new Promise((resolve) => {
      onMessage(
        { t: 'yts-save', url: 'blob:https://example.com/123', filename: c.rawName },
        { tab: { url: c.tabUrl } },
        resolve,
      );
    });
    assert.equal(res.ok, true);
  }

  assert.equal(downloadCalls.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    assert.equal(downloadCalls[i].filename, cases[i].expected);
    assert.equal(downloadCalls[i].saveAs, false);
  }

  const stateRes = await new Promise((resolve) => {
    onMessage({ t: 'yts-download-state', id: 1 }, {}, resolve);
  });
  assert.equal(stateRes.ok, true);
  assert.equal(stateRes.state, 'complete');
});
