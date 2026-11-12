// Universal MAIN-world media stream hook (run_at: document_start).
// Passively records media URLs (.m3u8, .mpd, .mp4, .webm, .m4a, .mp3, .flac)
// requested by any player via fetch/XHR without modifying or delaying traffic.
(() => {
  if (window.__ytsUniversalMediaHook) return;
  window.__ytsUniversalMediaHook = true;

  const DATASET_KEY = 'ytsCapturedMedia';
  const MAX_ITEMS = 40;
  const items = [];
  const seen = new Set();

  function classifyUrl(rawUrl, contentType = '') {
    const url = String(rawUrl || '');
    if (!/^https?:\/\//i.test(url)) return null;
    const ct = String(contentType || '').toLowerCase();

    if (/\.m3u8(\?|$|#)/i.test(url) || ct.includes('mpegurl')) return 'hls';
    if (/\.mpd(\?|$|#)/i.test(url) || ct.includes('dash+xml')) return 'dash';
    if (/\.(mp4|m4v|webm)(\?|$|#)/i.test(url) || /^video\/(mp4|webm)/.test(ct)) return 'mp4';
    if (/\.(m4a|mp3|flac|aac|ogg)(\?|$|#)/i.test(url) || /^audio\//.test(ct)) return 'audio';
    return null;
  }

  function record(url, contentType = '') {
    const type = classifyUrl(url, contentType);
    if (!type) return;
    const cleanUrl = String(url);
    if (seen.has(cleanUrl)) return;
    seen.add(cleanUrl);
    items.unshift({ type, url: cleanUrl, ts: Date.now() });
    if (items.length > MAX_ITEMS) {
      const removed = items.pop();
      if (removed) seen.delete(removed.url);
    }
    try {
      if (document.documentElement) {
        document.documentElement.dataset[DATASET_KEY] = JSON.stringify(items);
      }
    } catch (_) {}
  }

  function scanPerformance() {
    try {
      const entries = performance.getEntriesByType?.('resource') || [];
      for (const entry of entries) {
        if (entry?.name) record(entry.name);
      }
    } catch (_) {}
  }

  document.addEventListener('yts-media-probe', scanPerformance, true);

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (reqUrl) record(reqUrl);
      const promise = origFetch.apply(this, args);
      promise.then((res) => {
        try {
          const ct = res?.headers?.get?.('content-type') || '';
          record(res?.url || reqUrl, ct);
        } catch (_) {}
      }).catch(() => {});
      return promise;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytsMediaUrl = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__ytsMediaUrl) record(this.__ytsMediaUrl);
    this.addEventListener('load', function () {
      try {
        const ct = this.getResponseHeader?.('content-type') || '';
        record(this.responseURL || this.__ytsMediaUrl, ct);
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };
})();
