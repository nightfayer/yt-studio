// Shared utilities across background service worker, content scripts, and Node tests.
// Exposed as globalThis.YTStudioUtils in browser/extension contexts and exported
// via module.exports when loaded in CommonJS (Node.js test runner).
((root) => {
  'use strict';

  // Windows refuses these as a base name whatever the extension is.
  const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function repairFilename(value) {
    const raw = String(value || '');
    const match = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/s.exec(raw) || [];
    let base = match[1] || '';
    const extension = match[2] || '';
    base = base
      // Lone surrogates first: everything after this can assume valid text.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\p{Cf}\p{Noncharacter_Code_Point}]+/gu, '')
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.~\s]+/, '')
      .replace(/[.~\s]+$/, '');

    const points = [...base];
    if (points.length > 120) base = points.slice(0, 120).join('').replace(/[.~\s]+$/, '').trim();
    if (base.includes('~') && [...`${base}${extension}`].length <= 12) base = base.replace(/~/g, '-');
    if (RESERVED_DEVICE_NAMES.test(base)) base = `_${base}`;
    if (!base) base = 'yts-download';
    return `${base}${extension}`;
  }

  function detectPlatform(pageUrlInput, filenameInput) {
    const pageUrl = String(pageUrlInput || '');
    if (pageUrl.includes('youtube.com') || pageUrl.includes('youtu.be')) return 'YouTube';
    if (pageUrl.includes('instagram.com')) return 'Instagram';
    if (pageUrl.includes('tiktok.com')) return 'TikTok';
    if (pageUrl.includes('rutube.ru') || pageUrl.includes('rutube.sport')) return 'Rutube';
    if (pageUrl.includes('twitch.tv')) return 'Twitch';
    if (pageUrl.includes('vk.com') || pageUrl.includes('vkvideo.ru') || pageUrl.includes('vk.ru')) return 'VK';
    if (pageUrl.includes('coub.com')) return 'Coub';
    if (pageUrl.includes('zvuk.com')) return 'Zvuk';

    const fn = String(filenameInput || '');
    if (fn.startsWith('TikTok -')) return 'TikTok';
    if (fn.startsWith('Rutube -') || fn.includes('Rutube')) return 'Rutube';
    if (fn.startsWith('Twitch -') || fn.includes('Twitch')) return 'Twitch';
    if (fn.startsWith('VK -') || fn.includes('VK')) return 'VK';
    if (fn.startsWith('Coub -')) return 'Coub';
    if (fn.startsWith('Zvuk -')) return 'Zvuk';
    if (fn.includes('instagram') || fn.includes('_cover.jpg')) return 'Instagram';
    return 'YouTube';
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (!Number.isFinite(value) || value <= 0) return '';
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} МБ` : `${Math.round(value / 1e3)} КБ`;
  }

  // Tries cookie-less CORS first, then default mode, then credentialed fetch.
  // Helps across CDNs that reject credentials with wildcard CORS or require cookies.
  async function fetchWithFallback(url, options = {}) {
    const baseOpts = { cache: 'no-store', ...options };
    const modes = ['omit', undefined, 'include'];
    let lastError = null;
    let lastResponse = null;

    for (const credentials of modes) {
      const reqOpts = { ...baseOpts };
      if (credentials === undefined) {
        delete reqOpts.credentials;
      } else {
        reqOpts.credentials = credentials;
      }
      try {
        const res = await fetch(url, reqOpts);
        if (res.ok) return res;
        lastResponse = res;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('Failed to fetch');
  }

  // Streams a binary media file with optional multi-connection Range chunking
  // and Range-based resume on transient drops.
  async function fetchBytesWithResume(url, {
    attempts = 4,
    onProgress = null,
    declaredSize = 0,
    credentials = 'omit',
    cache = 'no-store',
    log = null,
    concurrency = 1,
    chunkSize = 2 * 1024 * 1024,
  } = {}) {
    if (concurrency > 1) {
      try {
        const parallelResult = await fetchBytesParallel(url, {
          attempts,
          onProgress,
          declaredSize,
          credentials,
          cache,
          log,
          concurrency,
          chunkSize,
        });
        if (parallelResult) return parallelResult;
      } catch (error) {
        log?.('fetch', `parallel fallback to sequential: ${String(error?.message || error)}`);
      }
    }

    const parts = [];
    let received = 0;
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      try {
        const response = await fetch(url, {
          credentials,
          cache,
          ...(received ? { headers: { Range: `bytes=${received}-` } } : {}),
        });
        // A server that ignores Range answers 200 with the whole file.
        if (received && response.status !== 206) {
          parts.length = 0;
          received = 0;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const total = declaredSize
          || (received + (Number(response.headers?.get?.('content-length')) || 0));
        if (!response.body) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          parts.push(bytes);
          received += bytes.length;
        } else {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.length;
            if (total) onProgress?.(Math.min(0.99, received / total));
          }
        }
        if (declaredSize && received < declaredSize) {
          throw new Error(`получено ${received} из ${declaredSize} байт`);
        }
        const merged = new Uint8Array(received);
        let offset = 0;
        for (const part of parts) {
          merged.set(part, offset);
          offset += part.length;
        }
        onProgress?.(1);
        return merged;
      } catch (error) {
        lastError = error;
        log?.('fetch', `attempt ${attempt + 1}/${attempts} failed at ${received} bytes: ${String(error?.message || error)}`);
      }
    }

    const reason = String(lastError?.message || lastError);
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch {}
    throw new Error(/failed to fetch|networkerror/i.test(reason)
      ? `не удалось получить файл${hostname ? ` с ${hostname}` : ''} (${attempts} попытки, получено ${received} байт)`
      : `файл недоступен: ${reason}`);
  }

  async function fetchRangeChunk(url, start, end, { attempts, credentials, cache, onDelta }) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      let chunkReceived = 0;
      try {
        const response = await fetch(url, {
          credentials,
          cache,
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (response.status !== 206 && response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (response.status === 200) {
          return { fullResponse: response };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        chunkReceived = bytes.length;
        onDelta?.(chunkReceived);
        return { bytes, contentRange: response.headers?.get?.('content-range') || '' };
      } catch (error) {
        lastError = error;
        if (chunkReceived) onDelta?.(-chunkReceived);
      }
    }
    throw lastError || new Error('Range chunk failed');
  }

  async function fetchBytesParallel(url, {
    attempts = 4,
    onProgress = null,
    declaredSize = 0,
    credentials = 'omit',
    cache = 'no-store',
    concurrency = 4,
    chunkSize = 2 * 1024 * 1024,
  } = {}) {
    const firstEnd = chunkSize - 1;
    let downloaded = 0;
    const report = (delta, totalSize) => {
      downloaded += delta;
      if (totalSize) onProgress?.(Math.min(0.99, downloaded / totalSize));
    };

    const first = await fetchRangeChunk(url, 0, firstEnd, {
      attempts,
      credentials,
      cache,
      onDelta: (d) => report(d, declaredSize),
    });
    if (first.fullResponse) return null;

    const rangeMatch = /bytes\s+\d+-\d+\/(\d+)/i.exec(first.contentRange || '');
    const total = declaredSize || (rangeMatch ? Number(rangeMatch[1]) : 0);
    if (!total || first.bytes.length >= total) {
      onProgress?.(1);
      return first.bytes;
    }

    const ranges = [];
    for (let offset = first.bytes.length; offset < total; offset += chunkSize) {
      ranges.push([offset, Math.min(total - 1, offset + chunkSize - 1)]);
    }

    const results = new Array(ranges.length + 1);
    results[0] = first.bytes;
    let cursor = 0;

    const worker = async () => {
      while (cursor < ranges.length) {
        const index = cursor++;
        const [start, end] = ranges[index];
        const part = await fetchRangeChunk(url, start, end, {
          attempts,
          credentials,
          cache,
          onDelta: (d) => report(d, total),
        });
        if (part.fullResponse) throw new Error('Server stopped honoring Range');
        results[index + 1] = part.bytes;
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker());
    await Promise.all(workers);

    const totalLen = results.reduce((sum, buf) => sum + buf.length, 0);
    if (total && totalLen < total) {
      throw new Error(`получено ${totalLen} из ${total} байт`);
    }
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of results) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    onProgress?.(1);
    return merged;
  }

  function getCapturedMedia(type = null) {
    try {
      if (typeof document === 'undefined') return [];
      if (typeof document.dispatchEvent === 'function' && typeof Event === 'function') {
        document.dispatchEvent(new Event('yts-media-probe'));
      }
      const raw = document.documentElement?.dataset?.ytsCapturedMedia;
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return type ? list.filter((item) => item && item.type === type) : list;
    } catch (_) {
      return [];
    }
  }

  const api = {
    RESERVED_DEVICE_NAMES,
    repairFilename,
    detectPlatform,
    formatBytes,
    fetchWithFallback,
    fetchBytesWithResume,
    fetchBytesParallel,
    getCapturedMedia,
  };

  root.YTStudioUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
