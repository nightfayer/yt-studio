'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function createDomStub(url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') {
  const makeEl = (tag = 'div') => {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      dataset: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      children: [],
      textContent: '',
      innerHTML: '',
      appendChild(child) { this.children.push(child); return child; },
      append(...nodes) { this.children.push(...nodes); },
      remove() {},
      setAttribute() {},
      getAttribute() { return null; },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    };
    return el;
  };

  const head = makeEl('head');
  const body = makeEl('body');
  const docEl = makeEl('html');

  const document = {
    readyState: 'complete',
    head,
    body,
    documentElement: docEl,
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const parsed = new URL(url);
  const location = {
    href: parsed.href,
    origin: parsed.origin,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
  };

  const listeners = [];
  const chrome = {
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '2.3.4' }),
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: () => {} },
    },
    downloads: {
      download: async () => 1,
      search: async () => [],
      show: () => {},
      onChanged: { addListener: () => {} },
    },
    commands: {
      onCommand: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      reload: async () => {},
      update: async () => {},
      sendMessage: async () => ({}),
    },
    offscreen: {
      hasDocument: async () => false,
      createDocument: async () => {},
    },
  };

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    AbortSignal,
    AbortController,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    JSON,
    Math,
    Date,
    RegExp,
    Error,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    fetch: async () => ({ ok: false, status: 404, headers: new Map(), json: async () => ({}), text: async () => '' }),
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    navigator: { userAgent: 'Mozilla/5.0', clipboard: { writeText: async () => {} } },
    document,
    location,
    chrome,
    MutationObserver: FakeMutationObserver,
    HTMLElement: function HTMLElement() {},
    Element: function Element() {},
    CustomEvent: function CustomEvent(type, detail) { this.type = type; this.detail = detail; },
    Event: function Event(type) { this.type = type; },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
    getComputedStyle: () => ({}),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox._listeners = listeners;

  return vm.createContext(sandbox);
}

function runScript(context, relPath) {
  const fullPath = path.join(ROOT, relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInContext(code, context, { filename: relPath });
}

test('manifest.json references existing files and loads shared/utils.js before isolated scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
  for (const iconPath of Object.values(manifest.icons || {})) {
    assert.ok(fs.existsSync(path.join(ROOT, iconPath)), `Missing icon: ${iconPath}`);
  }
  for (const iconPath of Object.values(manifest.action.default_icon || {})) {
    assert.ok(fs.existsSync(path.join(ROOT, iconPath)), `Missing action icon: ${iconPath}`);
  }

  for (const cs of manifest.content_scripts) {
    for (const file of [...(cs.js || []), ...(cs.css || [])]) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `Missing content script asset: ${file}`);
    }
    if (cs.world === 'ISOLATED') {
      assert.equal(cs.js[0], 'shared/utils.js', `ISOLATED script group must load shared/utils.js first: ${cs.js.join(', ')}`);
    }
  }
});

test('background.js initializes via importScripts(shared/utils.js) and registers message handlers', () => {
  const ctx = createDomStub('https://www.youtube.com/');
  ctx.importScripts = (...paths) => {
    for (const p of paths) runScript(ctx, p);
  };
  runScript(ctx, 'background.js');

  assert.ok(ctx.YTStudioUtils, 'YTStudioUtils should be loaded in background');
  assert.ok(ctx._listeners.length >= 1, 'background.js should register runtime.onMessage listener');
  assert.equal(ctx.detectPlatform({ tab: { url: 'https://vk.ru/video-1_2' } }, '', 'clip.mp4'), 'VK');
  assert.equal(ctx.repairFilename('CON?.mp4'), '_CON.mp4');
});

const PLATFORM_SCRIPTS = [
  { file: 'coub.js', url: 'https://coub.com/view/abc', needsSettings: false },
  { file: 'instagram.js', url: 'https://www.instagram.com/reel/abc/', needsSettings: true },
  { file: 'tiktok.js', url: 'https://www.tiktok.com/@user/video/123', needsSettings: false },
  { file: 'vk.js', url: 'https://vkvideo.ru/video-1_2', needsSettings: true },
  { file: 'rutube.js', url: 'https://rutube.ru/video/123/', needsSettings: true },
  { file: 'zvuk.js', url: 'https://zvuk.com/track/123', needsSettings: false },
  { file: 'twitch_ui.js', url: 'https://www.twitch.tv/videos/123', needsSettings: true },
  { file: 'content_ui.js', url: 'https://www.youtube.com/watch?v=123', needsSettings: true },
];

for (const entry of PLATFORM_SCRIPTS) {
  test(`${entry.file} initializes cleanly with shared/utils.js on ${entry.url}`, () => {
    const ctx = createDomStub(entry.url);
    runScript(ctx, 'shared/utils.js');
    if (entry.needsSettings) runScript(ctx, 'settings.js');
    assert.doesNotThrow(() => runScript(ctx, entry.file));
  });
}
