'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal browser globals so settings.js can load cleanly in Node.js.
globalThis.window = { devicePixelRatio: 1 };
globalThis.screen = { width: 1920, height: 1080 };
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
};

require('../settings.js');
const settings = globalThis.YTStudioSettings;

test('YTStudioSettings.normalize preserves defaults for missing keys and validates values', () => {
  const normalized = settings.normalize({
    youtubeQuality: 9999,
    vkQuality: 1080,
    filenameTemplate: 'author_title',
    subfolders: 1,
  });
  assert.equal(normalized.youtubeQuality, 'auto');
  assert.equal(normalized.youtubeLock, true);
  assert.equal(normalized.twitchLock, true);
  assert.equal(normalized.vkQuality, 1080);
  assert.equal(normalized.filenameTemplate, 'author_title');
  assert.equal(normalized.subfolders, true);
});

test('YTStudioSettings.resolveHeight picks best rung within target or max', () => {
  const rungs = [360, 720, 1080, 1440];
  assert.equal(settings.resolveHeight('max', rungs), 1440);
  assert.equal(settings.resolveHeight('auto', rungs), 1080);
  assert.equal(settings.resolveHeight(720, rungs), 720);
  assert.equal(settings.resolveHeight(480, rungs), 360);
  assert.equal(settings.resolveHeight(240, [720, 1080]), 720);
  assert.equal(settings.resolveHeight('auto', []), null);
});
