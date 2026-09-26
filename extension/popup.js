/**
 * YT Studio Companion Extension - Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('server-status');
  const statusText = document.getElementById('status-text');
  const btnRefresh = document.getElementById('btn-refresh');
  const offlineBanner = document.getElementById('offline-banner');
  const appVersion = document.getElementById('app-version');

  const tabTitle = document.getElementById('tab-title');
  const tabUrl = document.getElementById('tab-url');
  const tabPlatform = document.getElementById('tab-platform');
  const formatPills = document.querySelectorAll('.pill');
  const btnDownloadTab = document.getElementById('btn-download-tab');
  const downloadFeedback = document.getElementById('download-feedback');

  const jobsList = document.getElementById('jobs-list');
  const jobsCount = document.getElementById('jobs-count');
  const btnOpenWeb = document.getElementById('btn-open-web');

  let activeTab = null;
  let serverOnline = false;
  let serverPort = 8731;
  let selectedMode = 'video';
  let selectedQuality = 1080;
  let selectedFormat = 'mp3';
  let pollInterval = null;

  // 1. Get active tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      activeTab = tabs[0];
      tabTitle.textContent = activeTab.title || 'Без названия';
      tabUrl.textContent = activeTab.url || '';

      const u = (activeTab.url || '').toLowerCase();
      tabPlatform.className = 'platform-tag';

      if (u.includes('youtube.com') || u.includes('youtu.be')) {
        tabPlatform.textContent = 'YouTube';
        tabPlatform.classList.add('yt');
      } else if (u.includes('vk.com') || u.includes('vkvideo.ru')) {
        tabPlatform.textContent = 'VK Видео';
        tabPlatform.classList.add('vk');
      } else if (u.includes('rutube.ru')) {
        tabPlatform.textContent = 'Rutube';
        tabPlatform.classList.add('rutube');
      } else if (u.includes('twitch.tv')) {
        tabPlatform.textContent = 'Twitch';
        tabPlatform.classList.add('twitch');
      } else if (u.startsWith('http://') || u.startsWith('https://')) {
        tabPlatform.textContent = 'Web';
      } else {
        tabPlatform.textContent = 'Браузер';
        btnDownloadTab.disabled = true;
      }
    }
  } catch (err) {
    tabTitle.textContent = 'Не удалось получить вкладку';
  }

  // 2. Format pills selection
  formatPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      formatPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');

      selectedMode = pill.getAttribute('data-mode') || 'video';
      selectedQuality = parseInt(pill.getAttribute('data-quality') || '1080', 10);
      selectedFormat = pill.getAttribute('data-format') || 'mp3';

      if (selectedMode === 'audio') {
        btnDownloadTab.querySelector('.btn-text').textContent = `Скачать ${selectedFormat.toUpperCase()} в YT Studio`;
      } else {
        btnDownloadTab.querySelector('.btn-text').textContent = `Скачать ${selectedQuality}p в YT Studio`;
      }
    });
  });

  // 3. Check server status
  async function checkServer() {
    statusText.textContent = 'Поиск...';
    statusBadge.className = 'status-badge';

    const resp = await chrome.runtime.sendMessage({ action: 'get_status' });

    if (resp && resp.ok && resp.server) {
      serverOnline = true;
      serverPort = resp.server.port || 8731;
      statusBadge.classList.add('online');
      statusText.textContent = `Онлайн :${serverPort}`;
      offlineBanner.style.display = 'none';
      if (resp.server.version) {
        appVersion.textContent = `v${resp.server.version}`;
      }
      btnDownloadTab.disabled = false;
      await updateJobs();
    } else {
      serverOnline = false;
      statusBadge.classList.add('offline');
      statusText.textContent = 'Офлайн';
      offlineBanner.style.display = 'flex';
      btnDownloadTab.disabled = true;
      jobsList.innerHTML = '<div class="jobs-empty">Сервер не запущен</div>';
      jobsCount.textContent = '0';
    }
  }

  // 4. Download active tab
  btnDownloadTab.addEventListener('click', async () => {
    if (!activeTab || !activeTab.url || !activeTab.url.startsWith('http')) {
      showFeedback('error', 'Неподдерживаемая страница');
      return;
    }

    if (!serverOnline) {
      showFeedback('error', 'Сервер не запущен. Запустите Start.bat');
      return;
    }

    btnDownloadTab.disabled = true;
    showFeedback('info', 'Отправка задачи...');

    const resp = await chrome.runtime.sendMessage({
      action: 'download',
      url: activeTab.url,
      mode: selectedMode,
      quality: selectedQuality,
      audioFormat: selectedFormat
    });

    btnDownloadTab.disabled = false;

    if (resp && resp.ok) {
      showFeedback('success', '✓ Видео добавлено в очередь скачивания!');
      await updateJobs();
    } else {
      showFeedback('error', (resp && resp.error) || 'Ошибка отправки задачи');
    }
  });

  function showFeedback(type, text) {
    downloadFeedback.style.display = 'block';
    downloadFeedback.className = `download-feedback ${type}`;
    downloadFeedback.textContent = text;
    setTimeout(() => {
      if (downloadFeedback.parentNode) {
        downloadFeedback.style.display = 'none';
      }
    }, 4000);
  }

  // 5. Update active jobs
  async function updateJobs() {
    if (!serverOnline) return;

    try {
      const resp = await chrome.runtime.sendMessage({ action: 'get_jobs' });
      if (resp && resp.ok && Array.isArray(resp.jobs)) {
        const active = resp.jobs.filter((j) =>
          ['downloading', 'processing', 'queued'].includes(j.status)
        );

        jobsCount.textContent = active.length;

        if (active.length === 0) {
          jobsList.innerHTML = '<div class="jobs-empty">Нет активных загрузок</div>';
          return;
        }

        jobsList.innerHTML = active
          .slice(0, 3)
          .map((j) => {
            const pct = Math.max(0, Math.min(100, Math.round(j.progress || 0)));
            const speed = j.speedBps ? `${(j.speedBps / 1024 / 1024).toFixed(1)} МБ/с` : '';
            return `
              <div class="job-item">
                <div class="job-title" title="${escapeHtml(j.title || 'Видео')}">${escapeHtml(j.title || 'Видео')}</div>
                <div class="job-bar">
                  <div class="job-fill" style="width: ${pct}%"></div>
                </div>
                <div class="job-meta">
                  <span>${escapeHtml(j.stage || 'Загрузка')} • ${pct}%</span>
                  <span>${speed}</span>
                </div>
              </div>
            `;
          })
          .join('');
      }
    } catch {
      // Fail silently
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>'"]/g, (tag) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  // 6. Navigation / Actions
  btnRefresh.addEventListener('click', checkServer);

  btnOpenWeb.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'open_panel' });
  });

  // Initial check
  await checkServer();

  // Poll jobs while popup open
  pollInterval = setInterval(updateJobs, 1500);

  window.addEventListener('unload', () => {
    if (pollInterval) clearInterval(pollInterval);
  });
});
