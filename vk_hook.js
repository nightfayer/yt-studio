// vk_hook.js — runs in PAGE context (world: "MAIN") at document_start.
// Captures VK player metadata (files, url240..url2160, dash_sep, title) from
// network responses and global player state so vk.js can download even when
// unhashed video_ext.php requests are blocked by VK.
(() => {
  if (window.__ytsVkHookInstalled) return;
  window.__ytsVkHookInstalled = true;

  const CACHE_ATTR = 'ytsVkCache';
  const cache = new Map();

  function normalizeFiles(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const files = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || !value.startsWith('http')) continue;
      if (/^mp4_\d+$/i.test(key) || key === 'dash_sep' || key === 'hls') {
        files[key.toLowerCase()] = value;
      } else {
        const urlMatch = /^url(\d+)$/i.exec(key);
        if (urlMatch) files[`mp4_${urlMatch[1]}`] = value;
      }
    }
    return Object.keys(files).length ? files : null;
  }

  function extractFromObject(obj, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || depth > 7 || seen.has(obj)) return null;
    seen.add(obj);

    const directFiles = normalizeFiles(obj.files) || normalizeFiles(obj);
    if (directFiles) {
      const oid = obj.oid ?? obj.owner_id ?? obj.ownerId ?? '';
      const id = obj.vid ?? obj.id ?? obj.video_id ?? obj.videoId ?? '';
      return {
        key: oid && id ? `${oid}_${id}` : '',
        files: directFiles,
        title: String(obj.md_title || obj.title || ''),
        duration: Number(obj.duration) || 0,
      };
    }

    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        const found = extractFromObject(val, depth + 1, seen);
        if (found) return found;
      }
    }
    return null;
  }

  function extractFromText(text) {
    if (!text || typeof text !== 'string') return null;
    if (!text.includes('mp4_') && !text.includes('url720') && !text.includes('url480') && !text.includes('dash_sep') && !text.includes('"files"')) {
      return null;
    }

    try {
      const parsed = JSON.parse(text);
      const fromJson = extractFromObject(parsed);
      if (fromJson) return fromJson;
    } catch (_) {}

    const unescaped = text.includes('\\"') ? text.replace(/\\"/g, '"').replace(/\\\\\//g, '/') : text.replace(/\\\//g, '/');
    const files = {};
    const urlPattern = /"(mp4_\d+|url\d+|dash_sep|hls)"\s*:\s*"(https?:[^"]+)"/gi;
    let m;
    while ((m = urlPattern.exec(unescaped)) !== null) {
      const k = m[1].toLowerCase();
      const url = m[2].replace(/\\u0026/g, '&');
      if (k.startsWith('url')) files[`mp4_${k.slice(3)}`] = url;
      else files[k] = url;
    }
    if (!Object.keys(files).length) return null;

    const oidMatch = /"(?:oid|owner_id)"\s*:\s*(-?\d+)/.exec(unescaped);
    const idMatch = /"(?:vid|id|video_id)"\s*:\s*(\d+)/.exec(unescaped);
    const titleMatch = /"(?:md_title|title)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(unescaped);
    const durMatch = /"duration"\s*:\s*(\d+)/.exec(unescaped);
    let title = '';
    if (titleMatch) {
      try { title = JSON.parse(`"${titleMatch[1]}"`); } catch (_) { title = titleMatch[1]; }
    }
    return {
      key: oidMatch && idMatch ? `${oidMatch[1]}_${idMatch[1]}` : '',
      files,
      title,
      duration: durMatch ? Number(durMatch[1]) : 0,
    };
  }

  function publish(entry) {
    if (!entry || !entry.files) return;
    const key = entry.key || '_latest';
    cache.set(key, entry);
    if (entry.key) cache.set('_latest', entry);
    try {
      const serialized = JSON.stringify(Object.fromEntries(cache.entries()));
      if (document.documentElement) {
        document.documentElement.dataset[CACHE_ATTR] = serialized;
      }
      window.postMessage({ source: 'yts-vk-hook', entry }, '*');
    } catch (_) {}
  }

  function probeGlobals() {
    const candidates = [
      window.mvcur?.player?.vars,
      window.mvcur?.mvData,
      window.cur?.videoPlayer?.vars,
      window.cur?.mvData,
      window.playerParams,
    ];
    for (const candidate of candidates) {
      const found = extractFromObject(candidate);
      if (found) publish(found);
    }
  }

  document.addEventListener('yts-vk-probe', probeGlobals, true);

  // Hook fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      promise.then((res) => {
        try {
          const url = String(res?.url || args[0]?.url || args[0] || '');
          if (!/(al_video|video_ext|vk\.com|vk\.ru|vkvideo\.ru)/i.test(url)) return;
          res.clone().text().then((text) => {
            const found = extractFromText(text);
            if (found) publish(found);
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
      return promise;
    };
  }

  // Hook XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytsUrl = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (!/(al_video|video_ext|vk\.com|vk\.ru|vkvideo\.ru)/i.test(this.__ytsUrl || '')) return;
        if (typeof this.responseText === 'string') {
          const found = extractFromText(this.responseText);
          if (found) publish(found);
        }
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };
})();
