// Instagram (instagram.com) — Reels, Post videos, and Stories.
//
// Extracts clean MP4 video directly from the active player or Meta CDN,
// with optional audio extraction (MP3 / M4A) via offscreen processing.
(() => {
  const BUTTON_CLASS = 'yts-insta-btn';
  const OVERLAY_CLASS = 'yts-insta-overlay';
  const SHORTCODE_RE = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/;
  const SLICE_BYTES = 4 * 1024 * 1024;

  let menu;
  let busy = false;
  let toastBox;
  let toastTimer;
  let userSettings = {};

  function log(tag, text) {
    chrome.runtime.sendMessage({ t: 'yts-log', tag: `instagram/${tag}`, text }).catch(() => {});
  }

  function reportError(context, error, details) {
    console.error('[YT Studio Instagram]', error);
    return chrome.runtime.sendMessage({
      t: 'yts-error', context, error: String(error?.stack || error?.message || error), details,
    }).catch(() => null);
  }

  function createElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function safeName(value) {
    const cleaned = String(value || '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const points = [...cleaned];
    return points.length > 80 ? points.slice(0, 80).join('').trim() : cleaned;
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    return value >= 1e6 ? `${(value / 1e6).toFixed(1)} МБ` : `${Math.round(value / 1e3)} КБ`;
  }

  // ---- video & url discovery --------------------------------------------------

  function shortcodeFrom(url = location.href) {
    const match = SHORTCODE_RE.exec(url);
    return match ? match[1] : '';
  }

  function extractSrcFromFiber(video) {
    try {
      const fiberKey = Object.keys(video).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fiberKey) return null;
      let fiber = video[fiberKey];
      for (let i = 0; i < 20 && fiber; i++) {
        const props = fiber.memoizedProps;
        if (props) {
          if (typeof props.src === 'string' && props.src.startsWith('http')) return props.src;
          if (typeof props.videoData?.video_versions?.[0]?.url === 'string') {
            return props.videoData.video_versions[0].url;
          }
          if (typeof props.video?.video_versions?.[0]?.url === 'string') {
            return props.video.video_versions[0].url;
          }
        }
        fiber = fiber.return;
      }
    } catch (e) {}
    return null;
  }

  function getVideoUrl(video) {
    if (!video) return null;
    const fiberSrc = extractSrcFromFiber(video);
    if (fiberSrc) return fiberSrc;

    if (video.currentSrc && !video.currentSrc.startsWith('blob:')) return video.currentSrc;
    if (video.src && !video.src.startsWith('blob:')) return video.src;

    const source = video.querySelector('source[src]');
    if (source?.src && !source.src.startsWith('blob:')) return source.src;

    const meta = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
    if (meta?.content && meta.content.startsWith('http')) return meta.content;

    // Blob URL can still be fetched same-origin in the page context
    return video.currentSrc || video.src || null;
  }

  function getAuthorFromContainer(container) {
    if (!container) return '';
    const authorEl = container.querySelector('header a, a[role="link"] b, a[role="link"] span, [role="presentation"] a');
    const text = authorEl?.textContent?.trim();
    if (text && text.length < 40 && !text.includes(' ')) return text;

    const link = container.querySelector('header a[href^="/"], a[role="link"][href^="/"]');
    const path = link?.getAttribute('href') || '';
    const clean = path.replace(/^\/|\/$/g, '').split('/')[0];
    if (clean && clean !== 'p' && clean !== 'reel' && clean !== 'reels' && clean !== 'stories') {
      return clean;
    }
    return '';
  }

  function findActiveVideo() {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return null;

    for (const v of videos) {
      if (!v.paused && v.currentTime > 0) return v;
    }

    const centerY = window.innerHeight / 2;
    return videos.reduce((best, v) => {
      const rect = v.getBoundingClientRect();
      const dist = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      return dist < best.dist ? { v, dist } : best;
    }, { v: videos[0], dist: Infinity }).v;
  }

  function resolveVideoContext(video) {
    const container = video.closest('article') || video.closest('div[role="dialog"]') || video.closest('section') || video.parentElement;
    const author = getAuthorFromContainer(container) || location.pathname.replace(/^\/|\/$/g, '').split('/')[0] || '';
    const code = shortcodeFrom() || shortcodeFrom(container?.querySelector('a[href*="/p/"], a[href*="/reel/"]')?.href) || `${Date.now()}`;
    const url = getVideoUrl(video);
    const duration = Number(video.duration) || 0;

    let title = code;
    if (userSettings?.filenameTemplate === 'author_title' && author) {
      title = `${author} — ${code}`;
    } else if (author) {
      title = `${author}_${code}`;
    }

    return {
      video,
      container,
      url,
      author,
      code,
      title: safeName(title) || 'instagram_video',
      duration,
    };
  }

  // ---- downloads -------------------------------------------------------------

  async function saveDirect(url, filename) {
    const saved = await chrome.runtime.sendMessage({ t: 'yts-save', url, filename });
    if (!saved?.ok) throw new Error(saved?.error || 'не удалось передать загрузку браузеру');
    return saved.id;
  }

  async function followBrowserDownload(id, notification) {
    let misses = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const state = await chrome.runtime.sendMessage({ t: 'yts-download-state', id }).catch(() => null);
      if (!state?.ok) {
        if (++misses > 8) throw new Error(state?.error || 'браузер потерял загрузку');
        continue;
      }
      misses = 0;
      if (state.state === 'interrupted') {
        throw new Error(`браузер прервал загрузку (${state.error || 'причина не указана'})`);
      }
      if (state.state === 'complete') {
        notification.set('Загрузка завершена', 1);
        return;
      }
      const total = Number(state.totalBytes) || 0;
      const received = Number(state.bytesReceived) || 0;
      const pct = total ? received / total : null;
      notification.set(total ? `Скачивание · ${formatBytes(received)} из ${formatBytes(total)}` : 'Скачивание файла…', pct);
    }
  }

  async function fetchBlobDownload(url, filename, notification) {
    notification.set('Загрузка видеопотока…', 0.2);
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`сервер отказал (HTTP ${response.status})`);
    const blob = await response.blob();
    const objUrl = URL.createObjectURL(blob);
    const downloadId = await saveDirect(objUrl, filename);
    await followBrowserDownload(downloadId, notification);
    URL.revokeObjectURL(objUrl);
  }

  async function downloadAudio(ctx, notification) {
    notification.set('Подготовка звуковой дорожки…', 0.1);
    const response = await fetch(ctx.url, { credentials: 'include' });
    if (!response.ok) throw new Error(`не удалось получить видео (HTTP ${response.status})`);
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const total = bytes.length;

    const jobId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const filename = `${ctx.title}.mp3`;

    const ensured = await chrome.runtime.sendMessage({ t: 'yts-ensure' });
    if (!ensured?.ok) throw new Error(ensured?.error || 'не удалось запустить конвертер');
    const registration = await chrome.runtime.sendMessage({ t: 'yts-register-job', jobId });
    if (!registration?.ok || !Number.isInteger(registration.tabId)) {
      throw new Error(registration?.error || 'вкладка недоступна');
    }

    const started = await chrome.runtime.sendMessage({
      t: 'yts-begin',
      jobId,
      tabId: registration.tabId,
      filename,
      format: 'mp3',
      audioFormat: 'mp3',
      audioQuality: 'best',
      audioMime: 'video/mp4',
      audioSize: total,
      videoSize: 0,
      duration: ctx.duration,
    });
    if (!started?.ok) throw new Error(started?.error || 'не удалось начать обработку звука');

    const encodeBase64 = (buffer) => {
      let binary = '';
      const step = 0x8000;
      for (let offset = 0; offset < buffer.length; offset += step) {
        binary += String.fromCharCode(...buffer.subarray(offset, Math.min(offset + step, buffer.length)));
      }
      return btoa(binary);
    };

    for (let offset = 0; offset < total; offset += SLICE_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + SLICE_BYTES, total));
      await chrome.runtime.sendMessage({
        t: 'yts-chunk', jobId, track: 'audio', b64: encodeBase64(chunk),
      });
      notification.set(`Конвертация MP3 · ${Math.round((offset / total) * 100)}%`, (offset / total) * 0.8);
    }

    notification.set('Сборка MP3…', 0.9);
    const finalized = await chrome.runtime.sendMessage({ t: 'yts-finalize', jobId });
    if (!finalized?.ok) throw new Error(finalized?.error || 'сборка MP3 не удалась');
  }

  // ---- UI: Toast & Menu ------------------------------------------------------

  function getToast() {
    if (!toastBox) {
      toastBox = createElement('div', 'yts-insta-toast');
      const text = createElement('div', 'yts-insta-toast-txt');
      const bar = createElement('div', 'yts-insta-toast-bar');
      const fill = createElement('div', 'yts-insta-toast-fill');
      bar.append(fill);
      toastBox.append(text, bar);
      document.body.append(toastBox);
    }
    const textEl = toastBox.querySelector('.yts-insta-toast-txt');
    const fillEl = toastBox.querySelector('.yts-insta-toast-fill');

    return {
      set(message, fraction = 0) {
        clearTimeout(toastTimer);
        textEl.textContent = message;
        if (fraction != null && fraction >= 0) {
          fillEl.style.width = `${Math.min(100, Math.round(fraction * 100))}%`;
          fillEl.hidden = false;
        } else {
          fillEl.hidden = true;
        }
        toastBox.classList.add('show');
      },
      hide(delay = 3500) {
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastBox?.classList.remove('show'), delay);
      },
    };
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(event) {
    if (menu && !menu.contains(event.target) && !event.target.closest?.(`.${BUTTON_CLASS}`)) {
      closeMenu();
    }
  }

  async function openMenu(video, button, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (menu) { closeMenu(); return; }

    const ctx = resolveVideoContext(video);
    if (!ctx.url) {
      const toast = getToast();
      toast.set('Не удалось найти ссылку на видео в плеере', 1);
      toast.hide(4000);
      return;
    }

    menu = createElement('div', 'yts-insta-menu');
    const head = createElement('div', 'yts-insta-head', `YT Studio v${chrome.runtime.getManifest().version}`);
    menu.append(head);

    const videoItem = createElement('div', 'yts-insta-item');
    videoItem.append(createElement('b', null, 'Скачать видео (MP4)'));
    videoItem.append(createElement('span', 'yts-insta-hint', 'Оригинальное качество'));
    videoItem.addEventListener('click', async () => {
      closeMenu();
      if (busy) return;
      busy = true;
      const toast = getToast();
      try {
        const filename = `${ctx.title}.mp4`;
        toast.set('Запуск загрузки…', 0.1);
        if (ctx.url.startsWith('blob:')) {
          await fetchBlobDownload(ctx.url, filename, toast);
        } else {
          const downloadId = await saveDirect(ctx.url, filename);
          await followBrowserDownload(downloadId, toast);
        }
        toast.set(`Готово: ${filename}`, 1);
        toast.hide(4000);
      } catch (err) {
        toast.set(`Ошибка: ${String(err?.message || err)}`, 1);
        toast.hide(7000);
        void reportError('download-video', err);
      } finally {
        busy = false;
      }
    });

    const audioItem = createElement('div', 'yts-insta-item');
    audioItem.append(createElement('b', null, 'Только аудио (MP3)'));
    audioItem.append(createElement('span', 'yts-insta-hint', 'Извлечение звуковой дорожки'));
    audioItem.addEventListener('click', async () => {
      closeMenu();
      if (busy) return;
      busy = true;
      const toast = getToast();
      try {
        await downloadAudio(ctx, toast);
        toast.set(`Готово: ${ctx.title}.mp3`, 1);
        toast.hide(4000);
      } catch (err) {
        toast.set(`Ошибка: ${String(err?.message || err)}`, 1);
        toast.hide(7000);
        void reportError('download-audio', err);
      } finally {
        busy = false;
      }
    });

    menu.append(videoItem, audioItem);
    document.body.append(menu);

    const box = button.getBoundingClientRect();
    const menuWidth = 240;
    const menuHeight = 120;
    menu.style.left = `${Math.max(12, Math.min(window.innerWidth - menuWidth - 12, box.right - menuWidth))}px`;
    menu.style.top = box.top > menuHeight + 16
      ? `${box.top - menuHeight - 8}px`
      : `${Math.min(window.innerHeight - menuHeight - 12, box.bottom + 8)}px`;

    setTimeout(() => document.addEventListener('click', onOutsideClick, true), 10);
  }

  function createIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '18');
    circle.setAttribute('cy', '18');
    circle.setAttribute('r', '16.8');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', '#00f2fe');
    circle.setAttribute('stroke-width', '2.2');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', '#00f2fe');
    path.setAttribute('d', 'M18 23.5l-6.5-6.5h4V9.5h5v7.5h4L18 23.5z M10.5 26h15v2h-15z');
    svg.append(circle, path);
    return svg;
  }

  function attachButtonToVideo(video) {
    if (!video || video.dataset.ytsBound) return;
    const container = video.parentElement;
    if (!container) return;

    video.dataset.ytsBound = 'true';
    const button = createElement('button', `${BUTTON_CLASS} ${OVERLAY_CLASS}`);
    button.type = 'button';
    button.title = 'Скачать видео (YT Studio)';
    button.setAttribute('aria-label', 'Скачать видео (YT Studio)');
    button.append(createIcon());
    button.addEventListener('click', (e) => openMenu(video, button, e));

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.append(button);
  }

  function scanAndMount() {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      attachButtonToVideo(v);
    }
  }

  // Hotkey listener (Alt + Shift + D)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.t === 'yts-toggle-menu') {
      const activeVideo = findActiveVideo();
      if (activeVideo) {
        const btn = activeVideo.parentElement?.querySelector(`.${BUTTON_CLASS}`) || activeVideo;
        openMenu(activeVideo, btn);
      }
    }
  });

  // Settings integration
  (async () => {
    const settings = globalThis.YTStudioSettings;
    if (!settings) return;
    userSettings = await settings.load();
    settings.subscribe((next) => { userSettings = next; });
  })();

  setInterval(scanAndMount, 1000);
  document.addEventListener('visibilitychange', scanAndMount);
  window.addEventListener('scroll', () => { if (menu) closeMenu(); }, { passive: true });
  scanAndMount();
})();
