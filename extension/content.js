/**
 * YT Studio Companion Extension - Content Script
 * Injects download buttons into YouTube, VK, Rutube, and Twitch players.
 */

(function () {
  'use strict';

  if (window.__yts_injected) return;
  window.__yts_injected = true;

  let lastUrl = location.href;
  let injectTimer = null;

  // SVG Icons
  const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>`;
  const ICON_CHEVRON = `<svg class="yts-ext-arrow" viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;

  function isVideoPage() {
    const host = location.hostname;
    const path = location.pathname;
    const search = location.search;

    if (host.includes('youtube.com')) {
      return path.startsWith('/watch') || path.startsWith('/shorts/');
    }
    if (host.includes('vk.com') || host.includes('vkvideo.ru')) {
      return path.includes('/video') || search.includes('z=video') || path.includes('/clip');
    }
    if (host.includes('rutube.ru')) {
      return path.includes('/video/');
    }
    if (host.includes('twitch.tv')) {
      return path.includes('/videos/') || (path.split('/').filter(Boolean).length === 1 && !['directory', 'p', 'search'].includes(path.split('/')[1]));
    }
    return false;
  }

  function getTargetSelector() {
    const host = location.hostname;

    if (host.includes('youtube.com')) {
      if (location.pathname.startsWith('/shorts/')) {
        return 'ytd-reel-player-overlay-renderer #actions, ytd-reel-video-renderer[is-active] #actions, #actions.ytd-reel-player-overlay-renderer';
      }
      return '#above-the-fold #top-level-buttons-computed, #top-level-buttons-computed, #actions-inner, #actions.ytd-watch-metadata';
    }
    if (host.includes('vk.com') || host.includes('vkvideo.ru')) {
      return '.VideoPageActions, .video_actions, .like_btns, .VideoPage__actions, [class*="VideoActions"]';
    }
    if (host.includes('rutube.ru')) {
      return '[class*="video-info-actions"], [class*="actions-module__actions"], [class*="video-actions"]';
    }
    if (host.includes('twitch.tv')) {
      return '[data-target="channel-header-right"], [class*="channel-info-content"] [class*="Layout-sc-"], .video-player__default-player-controls';
    }
    return null;
  }

  function createDropdown() {
    const wrap = document.createElement('div');
    wrap.className = 'yts-ext-wrap';
    wrap.id = 'yts-injected-root';

    wrap.innerHTML = `
      <button class="yts-ext-btn" id="yts-btn-main" title="Скачать через YT Studio">
        ${ICON_DOWNLOAD}
        <span>Скачать</span>
        ${ICON_CHEVRON}
      </button>
      <div class="yts-ext-dropdown">
        <div class="yts-ext-menu-header">⚡ YT Studio • Быстрое скачивание</div>
        <div class="yts-ext-menu-item" data-mode="video" data-quality="1080">
          <span>🎬 1080p Full HD</span>
          <span class="yts-item-tag">MP4</span>
        </div>
        <div class="yts-ext-menu-item" data-mode="video" data-quality="720">
          <span>🎬 720p HD</span>
          <span class="yts-item-tag">MP4</span>
        </div>
        <div class="yts-ext-menu-item" data-mode="video" data-quality="480">
          <span>🎬 480p SD</span>
          <span class="yts-item-tag">MP4</span>
        </div>
        <div class="yts-ext-menu-divider"></div>
        <div class="yts-ext-menu-item" data-mode="audio" data-quality="0" data-format="mp3">
          <span>🎵 Аудио MP3 (320 kbps)</span>
          <span class="yts-item-tag">MP3</span>
        </div>
        <div class="yts-ext-menu-item" data-mode="audio" data-quality="0" data-format="m4a">
          <span>🎵 Аудио M4A (Оригинал)</span>
          <span class="yts-item-tag">M4A</span>
        </div>
        <div class="yts-ext-menu-divider"></div>
        <div class="yts-ext-menu-item" data-action="open_panel">
          <span>🖥 Открыть веб-панель YT Studio</span>
        </div>
      </div>
    `;

    // Dropdown toggle
    const btn = wrap.querySelector('#yts-btn-main');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('yts-open');
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) {
        wrap.classList.remove('yts-open');
      }
    });

    // Item clicks
    wrap.querySelectorAll('.yts-ext-menu-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        wrap.classList.remove('yts-open');

        const action = item.getAttribute('data-action');
        if (action === 'open_panel') {
          chrome.runtime.sendMessage({ action: 'open_panel' });
          return;
        }

        const mode = item.getAttribute('data-mode') || 'video';
        const quality = parseInt(item.getAttribute('data-quality') || '1080', 10);
        const audioFormat = item.getAttribute('data-format') || 'mp3';
        const targetUrl = location.href;

        // Feedback toast
        showToast('info', 'Отправка задачи в YT Studio...');

        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'download',
            url: targetUrl,
            mode,
            quality,
            audioFormat
          });

          if (resp && resp.ok) {
            showToast(
              'success',
              `Добавлено в очередь скачивания (${mode === 'audio' ? audioFormat.toUpperCase() : quality + 'p'})!`,
              resp.serverPort
            );
          } else {
            showToast('error', (resp && resp.error) || 'Не удалось отправить задачу');
          }
        } catch (err) {
          showToast('error', 'Связь с расширением прервана. Перезагрузите страницу.');
        }
      });
    });

    return wrap;
  }

  function inject() {
    if (!isVideoPage()) {
      removeExisting();
      return;
    }

    if (document.getElementById('yts-injected-root')) {
      return; // Already injected
    }

    const sel = getTargetSelector();
    let target = sel ? document.querySelector(sel) : null;

    if (target) {
      const el = createDropdown();
      // On YouTube, insert at the beginning of actions or after like/dislike
      if (location.hostname.includes('youtube.com')) {
        target.prepend(el);
      } else {
        target.appendChild(el);
      }
    } else {
      // Floating fallback button if no container found after video element is present
      const videoEl = document.querySelector('video');
      if (videoEl && !document.getElementById('yts-injected-root')) {
        const el = createDropdown();
        el.classList.add('yts-ext-floating');
        document.body.appendChild(el);
      }
    }
  }

  function removeExisting() {
    const existing = document.getElementById('yts-injected-root');
    if (existing) existing.remove();
  }

  function scheduleInject() {
    clearTimeout(injectTimer);
    injectTimer = setTimeout(inject, 400);
  }

  // Toast UI System
  function getToastContainer() {
    let container = document.getElementById('yts-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'yts-toast-container';
      container.className = 'yts-ext-toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function showToast(type, text, serverPort) {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `yts-ext-toast ${type === 'error' ? 'yts-error' : ''}`;

    const icon = type === 'error' ? '✕' : (type === 'info' ? 'ℹ' : '✓');
    const port = serverPort || 8731;

    toast.innerHTML = `
      <div class="yts-ext-toast-icon">${icon}</div>
      <div class="yts-ext-toast-body">
        <div class="yts-ext-toast-title">YT Studio</div>
        <div class="yts-ext-toast-msg">${text}</div>
      </div>
      ${type === 'success' ? `<a class="yts-ext-toast-action" target="_blank" href="http://127.0.0.1:${port}/">Веб-панель</a>` : ''}
      <button class="yts-ext-toast-close" title="Закрыть">×</button>
    `;

    toast.querySelector('.yts-ext-toast-close').addEventListener('click', () => {
      toast.remove();
    });

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 300);
      }
    }, 4500);
  }

  // Listen for messages from background script (e.g. context menu feedback)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'show_toast') {
      showToast(msg.type || 'info', msg.message || '', msg.serverPort);
    }
  });

  // Watch URL changes for SPAs (YouTube, VK, etc.)
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removeExisting();
      scheduleInject();
    } else if (isVideoPage() && !document.getElementById('yts-injected-root')) {
      scheduleInject();
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  // YouTube specific navigation event
  window.addEventListener('yt-navigate-finish', () => {
    lastUrl = location.href;
    removeExisting();
    scheduleInject();
  });

  window.addEventListener('popstate', scheduleInject);

  // Initial injection
  scheduleInject();
})();
