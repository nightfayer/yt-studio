/**
 * YT Studio Companion Extension - Service Worker (Manifest V3)
 * Handles auto-discovery of local YT Studio backend, context menus, and API communication.
 */

const PORTS = Array.from({ length: 15 }, (_, i) => 8731 + i); // 8731..8745
const DEFAULT_PORT = 8731;

// Discover active YT Studio backend server
async function discoverServer() {
  const current = await chrome.storage.local.get(['port', 'token']);
  
  // Try current known port first
  if (current.port) {
    const verified = await checkPort(current.port);
    if (verified) return verified;
  }

  // Scan port range
  for (const port of PORTS) {
    const res = await checkPort(port);
    if (res) return res;
  }

  await chrome.storage.local.set({ online: false });
  await updateBadge(false);
  return null;
}

// Ping specific port for /api/status handshake
async function checkPort(port) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 600);
    const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const data = await resp.json();
      if (data && data.ok) {
        const info = {
          port,
          token: data.token,
          version: data.version || '4.2.0',
          outputDir: data.outputDir || '',
          online: true,
          lastSeen: Date.now()
        };
        await chrome.storage.local.set(info);
        await updateBadge(true);
        return info;
      }
    }
  } catch {
    // Port closed or not responding
  }
  return null;
}

// Update action icon badge
async function updateBadge(online) {
  try {
    if (online) {
      await chrome.action.setBadgeBackgroundColor({ color: '#00d26a' });
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setTitle({ title: 'YT Studio: Подключено' });
    } else {
      await chrome.action.setBadgeBackgroundColor({ color: '#666666' });
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'YT Studio: Сервер не найден (запустите Start.bat)' });
    }
  } catch {
    // Ignore badge errors
  }
}

// Send download request to backend
async function sendDownload(options) {
  let server = await discoverServer();
  if (!server) {
    return { ok: false, error: 'Сервер YT Studio не запущен. Запустите Start.bat на компьютере.' };
  }

  const payload = {
    url: options.url,
    mode: options.mode || 'video',
    quality: options.quality || 1080,
    audioFormat: options.audioFormat || 'mp3',
    compat: false,
    subs: false,
    playlist: false
  };

  try {
    const resp = await fetch(`http://127.0.0.1:${server.port}/api/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YTS-Token': server.token || ''
      },
      body: JSON.stringify(payload)
    });

    if (resp.ok) {
      const job = await resp.json();
      return { ok: true, job, serverPort: server.port };
    } else {
      const err = await resp.json().catch(() => ({}));
      return { ok: false, error: err.error || `Ошибка сервера (${resp.status})` };
    }
  } catch (e) {
    return { ok: false, error: 'Не удалось отправить запрос на сервер YT Studio' };
  }
}

// Fetch active jobs from backend
async function fetchJobs() {
  const server = await discoverServer();
  if (!server) return { ok: false, jobs: [] };

  try {
    const resp = await fetch(`http://127.0.0.1:${server.port}/api/jobs`, {
      headers: { 'X-YTS-Token': server.token || '' }
    });
    if (resp.ok) {
      const jobs = await resp.json();
      return { ok: true, jobs, serverPort: server.port };
    }
  } catch {
    // Fail silently
  }
  return { ok: false, jobs: [] };
}

// Context menus setup
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(async () => {
    chrome.contextMenus.create({
      id: 'yts-download-video-best',
      title: '🎬 Скачать видео в YT Studio (1080p)',
      contexts: ['page', 'link', 'video']
    });

    chrome.contextMenus.create({
      id: 'yts-download-audio-mp3',
      title: '🎵 Скачать аудио MP3 в YT Studio (320k)',
      contexts: ['page', 'link', 'video']
    });

    chrome.contextMenus.create({
      id: 'yts-open-panel',
      title: '⚡ Открыть веб-панель YT Studio',
      contexts: ['action']
    });
  });

  await discoverServer();
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.srcUrl || info.pageUrl || (tab && tab.url);
  if (!targetUrl) return;

  if (info.menuItemId === 'yts-open-panel') {
    const { port = DEFAULT_PORT } = await chrome.storage.local.get('port');
    await chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
    return;
  }

  const isAudio = info.menuItemId === 'yts-download-audio-mp3';
  const mode = isAudio ? 'audio' : 'video';
  const quality = isAudio ? 0 : 1080;
  const audioFormat = 'mp3';

  // Visual feedback: temporarily set badge to working state
  await chrome.action.setBadgeBackgroundColor({ color: '#00b4d8' });
  await chrome.action.setBadgeText({ text: '...' });

  const result = await sendDownload({ url: targetUrl, mode, quality, audioFormat });

  if (result.ok) {
    await chrome.action.setBadgeBackgroundColor({ color: '#00d26a' });
    await chrome.action.setBadgeText({ text: '✓' });
    setTimeout(async () => {
      await updateBadge(true);
    }, 2500);

    // If active tab has content script, notify it to show toast
    if (tab && tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'show_toast',
          type: 'success',
          message: `Добавлено в очередь: ${isAudio ? 'MP3' : 'Видео'}!`,
          serverPort: result.serverPort
        });
      } catch {
        // Content script might not be injected on this page
      }
    }
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: '#ff3366' });
    await chrome.action.setBadgeText({ text: '!' });
    setTimeout(async () => {
      await updateBadge(false);
    }, 3500);

    if (tab && tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'show_toast',
          type: 'error',
          message: result.error || 'Ошибка добавления в очередь'
        });
      } catch {
        // Ignore
      }
    }
  }
});

// Handle messages from content scripts and popup UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case 'get_status': {
        const server = await discoverServer();
        sendResponse({ ok: !!server, server });
        break;
      }
      case 'download': {
        const result = await sendDownload(message);
        sendResponse(result);
        break;
      }
      case 'get_jobs': {
        const result = await fetchJobs();
        sendResponse(result);
        break;
      }
      case 'open_panel': {
        const { port = DEFAULT_PORT } = await chrome.storage.local.get('port');
        await chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }
  })();
  return true; // Keep channel open for async response
});

// Periodic background check every 2 minutes
chrome.alarms.create('checkServerAlarm', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkServerAlarm') {
    await discoverServer();
  }
});
