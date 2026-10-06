// Action popup: shows the installed version and the update-check state that
// background.js keeps in chrome.storage.local under 'yts_update'.

const statusBox = document.getElementById('status');
const releaseLink = document.getElementById('release-link');
const recheckButton = document.getElementById('recheck');
// Always this address: GitHub redirects it to whatever the newest release is,
// so the link is correct even when the update check could not run — a
// per-version URL from yts.json would freeze on a stale release.
const LATEST_RELEASE_URL = 'https://github.com/nightfayer/yt-studio/releases/latest';

document.getElementById('current-version').textContent = `v${chrome.runtime.getManifest().version}`;

function render(state) {
  releaseLink.href = LATEST_RELEASE_URL;
  statusBox.className = 'status';
  releaseLink.hidden = true;

  if (!state || (!state.checkedAt && !state.error)) {
    statusBox.textContent = 'Обновления ещё не проверялись.';
    return;
  }
  if (state.available) {
    statusBox.classList.add('update');
    statusBox.textContent = `Доступна новая версия v${state.latest}!`;
    releaseLink.hidden = false;
    return;
  }
  if (state.error && !state.latest) {
    statusBox.classList.add('error');
    statusBox.textContent = `Не удалось проверить обновления: ${state.error}`;
    return;
  }
  const checked = state.checkedAt ? new Date(state.checkedAt).toLocaleString() : '';
  statusBox.textContent = `Установлена последняя версия.${checked ? ` Проверено: ${checked}` : ''}`;
}

async function refresh(force) {
  if (force) {
    statusBox.className = 'status';
    statusBox.textContent = 'Проверка обновлений…';
    // The check is now a 26px icon, so the spinner on it is the only sign that
    // anything is happening — without it the click reads as a dead button.
    recheckButton.classList.add('busy');
    recheckButton.disabled = true;
    const result = await chrome.runtime.sendMessage({ t: 'yts-check-update' }).catch((error) => ({
      error: String(error?.message || error),
    }));
    recheckButton.classList.remove('busy');
    recheckButton.disabled = false;
    render(result);
    return;
  }
  const stored = await chrome.storage.local.get('yts_update').catch(() => ({}));
  render(stored.yts_update);
  refresh(true);
}

recheckButton.addEventListener('click', () => refresh(true));
refresh(false);

// Player quality preferences. Applied by content_ui.js/content_hook.js on
// YouTube and by twitch_ui.js on Twitch; this popup only edits the record.
const settingsHint = document.getElementById('settings-hint');

function fillQualitySelect(select, heights) {
  // `screen` here is the display the popup — and therefore the browser window
  // — is on, so the number quoted next to "Как у монитора" is what that same
  // window will resolve 'auto' to.
  const monitor = globalThis.YTStudioSettings.monitorHeight();
  const options = [
    ['auto', `Как у монитора (${monitor}p)`],
    ['max', 'Максимальное'],
    ...heights.map((height) => [String(height), `${height}p`]),
  ];
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
}

// Active download progress watcher
const activeDownloadBox = document.getElementById('active-download');
const dlTitle = document.getElementById('dl-title');
const dlPercent = document.getElementById('dl-percent');
const dlProgressFill = document.getElementById('dl-progress-fill');
const dlStatus = document.getElementById('dl-status');

function renderActiveDownload(dl) {
  if (!dl || !dl.updatedAt || Date.now() - dl.updatedAt > 15_000) {
    activeDownloadBox.hidden = true;
    return;
  }
  activeDownloadBox.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(Number(dl.percent) || 0)));
  dlTitle.textContent = dl.filename || 'Скачивание медиа…';
  dlPercent.textContent = `${pct}%`;
  dlProgressFill.style.width = `${pct}%`;
  dlStatus.textContent = dl.status || 'Обработка…';
}

async function checkActiveDownload() {
  const stored = await chrome.storage.local.get('yts_active_download').catch(() => ({}));
  renderActiveDownload(stored.yts_active_download);
}

checkActiveDownload();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.yts_active_download) {
    renderActiveDownload(changes.yts_active_download.newValue);
  }
});

async function setupSettings() {
  const { YOUTUBE_HEIGHTS, TWITCH_HEIGHTS, VK_HEIGHTS, RUTUBE_HEIGHTS, save, load } = globalThis.YTStudioSettings;
  const youtubeQuality = document.getElementById('yt-quality');
  const youtubeLock = document.getElementById('yt-lock');
  const twitchQuality = document.getElementById('tw-quality');
  const twitchLock = document.getElementById('tw-lock');
  const vkQuality = document.getElementById('vk-quality');
  const rtQuality = document.getElementById('rt-quality');
  const nameTemplate = document.getElementById('name-template');

  fillQualitySelect(youtubeQuality, YOUTUBE_HEIGHTS);
  fillQualitySelect(twitchQuality, TWITCH_HEIGHTS);
  fillQualitySelect(vkQuality, VK_HEIGHTS || [2160, 1440, 1080, 720, 480, 360, 240]);
  fillQualitySelect(rtQuality, RUTUBE_HEIGHTS || [1080, 720, 480, 360]);

  const current = await load();
  youtubeQuality.value = String(current.youtubeQuality);
  youtubeLock.checked = current.youtubeLock;
  twitchQuality.value = String(current.twitchQuality);
  twitchLock.checked = current.twitchLock;
  if (vkQuality) vkQuality.value = String(current.vkQuality || 'auto');
  if (rtQuality) rtQuality.value = String(current.rutubeQuality || 'auto');
  if (nameTemplate) nameTemplate.value = String(current.filenameTemplate || 'title');
  const subfoldersToggle = document.getElementById('subfolders-enabled');
  if (subfoldersToggle) subfoldersToggle.checked = Boolean(current.subfolders);

  const note = (text) => { settingsHint.textContent = text; };
  const persist = async (patch, message) => {
    try {
      await save(patch);
      note(message);
    } catch (error) {
      note(`Не удалось сохранить настройку: ${String(error?.message || error)}`);
    }
  };

  youtubeQuality.addEventListener('change', () => persist(
    { youtubeQuality: youtubeQuality.value },
    'Сохранено. На открытых вкладках YouTube — обновите страницу (F5).',
  ));
  twitchQuality.addEventListener('change', () => persist(
    { twitchQuality: twitchQuality.value },
    'Сохранено. Twitch применяет качество при следующей загрузке плеера.',
  ));
  youtubeLock.addEventListener('change', () => persist(
    { youtubeLock: youtubeLock.checked },
    youtubeLock.checked
      ? 'Качество YouTube закреплено: плеер не будет понижать его сам.'
      : 'YouTube снова может понижать качество при слабой сети.',
  ));
  twitchLock.addEventListener('change', () => persist(
    { twitchLock: twitchLock.checked },
    twitchLock.checked
      ? 'Качество Twitch закреплено: авто-режим плеера выключен.'
      : 'Twitch снова может выбирать качество сам.',
  ));
  if (vkQuality) {
    vkQuality.addEventListener('change', () => persist(
      { vkQuality: vkQuality.value },
      'Сохранено. Качество для VK Видео обновлено.',
    ));
  }
  if (rtQuality) {
    rtQuality.addEventListener('change', () => persist(
      { rutubeQuality: rtQuality.value },
      'Сохранено. Качество для Rutube обновлено.',
    ));
  }
  if (nameTemplate) {
    nameTemplate.addEventListener('change', () => persist(
      { filenameTemplate: nameTemplate.value },
      'Сохранено. Формат имени файла обновлен.',
    ));
  }
  if (subfoldersToggle) {
    subfoldersToggle.addEventListener('change', () => persist(
      { subfolders: subfoldersToggle.checked },
      subfoldersToggle.checked
        ? 'Сортировка включена: файлы сохраняются в YT Studio/{Сервис}/.'
        : 'Сортировка отключена: файлы сохраняются в общую папку загрузок.',
    ));
  }
}

setupSettings().catch((error) => {
  settingsHint.textContent = `Настройки недоступны: ${String(error?.message || error)}`;
});

// Files that finished processing but that the browser did not accept for
// saving (a service-worker restart at the wrong moment). They wait in the
// extension's private storage until saved from here.
const recoveredBox = document.getElementById('recovered');
const saveRecoveredButton = document.getElementById('save-recovered');

function formatSize(bytes) {
  const megabytes = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return '';
  return megabytes >= 1024 ? ` (${(megabytes / 1024).toFixed(1)} ГБ)` : ` (${Math.round(megabytes)} МБ)`;
}

async function refreshRecovered() {
  const stored = await chrome.storage.local.get('yts_recovered').catch(() => ({}));
  const pending = (Array.isArray(stored.yts_recovered) ? stored.yts_recovered : [])
    .filter((entry) => entry && !entry.savedAt);
  recoveredBox.hidden = pending.length === 0;
  saveRecoveredButton.hidden = pending.length === 0;
  if (!pending.length) return pending.length;
  // These controls only ever appear after a download finished processing but
  // the browser refused to accept the file, so say exactly that — an unexplained
  // button here reads like a mystery feature.
  recoveredBox.textContent = pending.length === 1
    ? `Загрузка завершилась, но браузер не принял файл «${pending[0].filename}»`
      + `${formatSize(pending[0].bytes)}. Он сохранён во временном хранилище — нажмите кнопку ниже.`
    : `Готовых файлов, которые браузер не принял: ${pending.length}.`
      + ' Они сохранены во временном хранилище — нажмите кнопку ниже.';
  return pending.length;
}

saveRecoveredButton.addEventListener('click', async () => {
  saveRecoveredButton.disabled = true;
  saveRecoveredButton.textContent = 'Сохраняю…';
  const result = await chrome.runtime.sendMessage({ t: 'yts-flush-recovered' })
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  saveRecoveredButton.disabled = false;
  saveRecoveredButton.textContent = 'Сохранить готовый файл';
  const stillPending = await refreshRecovered();
  if (!stillPending) {
    recoveredBox.hidden = false;
    recoveredBox.textContent = 'Готово: файл отправлен в загрузки браузера.';
  } else {
    recoveredBox.textContent = `Не удалось сохранить: ${result?.error || 'ошибка'}.`
      + ' Попробуйте ещё раз или перезапустите браузер.';
  }
});

refreshRecovered();

// Manual journal export: the debug file is otherwise only produced by errors,
// which hides silent misbehaviour (wasted retries, reload loops) from reports.
const exportButton = document.getElementById('export-log');
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  exportButton.textContent = 'Сохраняю журнал…';
  const result = await chrome.runtime.sendMessage({
    t: 'yts-error',
    context: 'manual-export',
    error: 'Журнал сохранён по запросу пользователя (это не ошибка).',
  }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  exportButton.disabled = false;
  exportButton.textContent = result?.ok
    ? 'Журнал сохранён в загрузки (YTS-debug.txt)'
    : `Не удалось сохранить журнал: ${result?.error || 'ошибка'}`;
});

// ---- Recent downloads history ------------------------------------------

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  return value >= 1e9 ? `${(value / 1e9).toFixed(1)} ГБ`
    : value >= 1e6 ? `${(value / 1e6).toFixed(1)} МБ`
    : `${Math.round(value / 1e3)} КБ`;
}

async function renderRecentDownloads() {
  const container = document.getElementById('recent-downloads-list');
  if (!container || !chrome.downloads?.search) return;

  const stored = await chrome.storage.local.get('yts_download_ids').catch(() => ({}));
  const myIds = new Set(Array.isArray(stored.yts_download_ids) ? stored.yts_download_ids : []);

  const items = await chrome.downloads.search({ limit: 40, orderBy: ['-startTime'] }).catch(() => []);
  const relevant = items.filter((item) =>
    myIds.has(item.id) ||
    item.byExtensionId === chrome.runtime.id ||
    (item.filename && item.filename.includes('YT Studio'))
  ).slice(0, 15);

  if (!relevant.length) {
    container.innerHTML = '<div class="recent-empty">История загрузок пуста</div>';
    return;
  }

  container.innerHTML = '';
  for (const item of relevant) {
    const el = document.createElement('div');
    el.className = 'recent-item';

    const info = document.createElement('div');
    info.className = 'recent-info';

    const rawName = item.filename || '';
    const name = rawName.split(/[/\\]/).pop() || 'Файл';
    const nameEl = document.createElement('span');
    nameEl.className = 'recent-name';
    nameEl.textContent = name;
    nameEl.title = rawName;

    const metaEl = document.createElement('span');
    metaEl.className = 'recent-meta';

    let statusText = 'Завершено';
    let statusClass = 'status-complete';
    if (item.state === 'in_progress') {
      const pct = item.totalBytes ? Math.round((item.bytesReceived / item.totalBytes) * 100) : 0;
      statusText = pct ? `${pct}%` : 'Скачивание…';
      statusClass = 'status-in_progress';
    } else if (item.state === 'interrupted') {
      statusText = 'Прервано';
      statusClass = 'status-interrupted';
    }

    const sizeText = item.fileSize || item.totalBytes ? formatFileSize(item.fileSize || item.totalBytes) : '';
    metaEl.innerHTML = `<span class="${statusClass}">${statusText}</span>${sizeText ? ` · <span>${sizeText}</span>` : ''}`;

    info.append(nameEl, metaEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-show-btn';
    btn.textContent = 'Папка';
    btn.title = 'Показать в папке загрузок';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.downloads.show(item.id);
    });

    el.append(info, btn);
    container.append(el);
  }
}

renderRecentDownloads();
chrome.downloads?.onChanged?.addListener(() => renderRecentDownloads());
chrome.downloads?.onCreated?.addListener(() => renderRecentDownloads());
