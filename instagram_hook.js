// instagram_hook.js — runs in the PAGE context (world: "MAIN")
// Extracts clean CDN MP4 URLs from Instagram React fiber tree.
(() => {
  if (window.__ytsInstaHookInstalled) return;
  window.__ytsInstaHookInstalled = true;

  function findDirectUrl(video) {
    if (!video) return null;
    let curr = video;
    const visited = new Set();
    let foundUrl = null;

    function searchProps(obj, depth = 0) {
      if (!obj || depth > 6 || foundUrl || visited.has(obj)) return;
      if (typeof obj !== 'object') return;
      visited.add(obj);

      if (Array.isArray(obj.video_versions) && obj.video_versions[0]?.url) {
        foundUrl = obj.video_versions[0].url;
        return;
      }

      for (const k of Object.keys(obj)) {
        if (foundUrl) return;
        const val = obj[k];
        if (typeof val === 'string') {
          if (val.startsWith('http') && (val.includes('.mp4') || val.includes('cdninstagram.com') || val.includes('fbcdn.net')) && !val.includes('.jpg') && !val.includes('.webp')) {
            foundUrl = val;
            return;
          }
        } else if (typeof val === 'object' && val !== null) {
          searchProps(val, depth + 1);
        }
      }
    }

    while (curr && curr !== document.body && !foundUrl) {
      const fiberKey = Object.keys(curr).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fiberKey) {
        let fiber = curr[fiberKey];
        for (let i = 0; i < 25 && fiber && !foundUrl; i++) {
          if (fiber.memoizedProps) searchProps(fiber.memoizedProps);
          fiber = fiber.return;
        }
      }
      curr = curr.parentElement;
    }
    return foundUrl;
  }

  function findCoverUrl(video) {
    if (!video) return null;
    if (video.poster && video.poster.startsWith('http')) return video.poster;
    let curr = video;
    const visited = new Set();
    let foundCover = null;

    function searchProps(obj, depth = 0) {
      if (!obj || depth > 6 || foundCover || visited.has(obj)) return;
      if (typeof obj !== 'object') return;
      visited.add(obj);

      if (Array.isArray(obj.image_versions2?.candidates) && obj.image_versions2.candidates[0]?.url) {
        foundCover = obj.image_versions2.candidates[0].url;
        return;
      }
      if (typeof obj.display_url === 'string' && obj.display_url.startsWith('http')) {
        foundCover = obj.display_url;
        return;
      }

      for (const k of Object.keys(obj)) {
        if (foundCover) return;
        const val = obj[k];
        if (typeof val === 'string') {
          if (val.startsWith('http') && (val.includes('.jpg') || val.includes('.webp') || val.includes('.jpeg')) && (val.includes('cdninstagram.com') || val.includes('fbcdn.net'))) {
            foundCover = val;
            return;
          }
        } else if (typeof val === 'object' && val !== null) {
          searchProps(val, depth + 1);
        }
      }
    }

    while (curr && curr !== document.body && !foundCover) {
      const fiberKey = Object.keys(curr).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fiberKey) {
        let fiber = curr[fiberKey];
        for (let i = 0; i < 25 && fiber && !foundCover; i++) {
          if (fiber.memoizedProps) searchProps(fiber.memoizedProps);
          fiber = fiber.return;
        }
      }
      curr = curr.parentElement;
    }
    return foundCover;
  }

  function resolveVideo(video) {
    if (!video) return;
    const url = findDirectUrl(video);
    if (url) {
      video.dataset.ytsDirectUrl = url;
    }
    const cover = findCoverUrl(video);
    if (cover) {
      video.dataset.ytsCoverUrl = cover;
    }
  }

  // Synchronous response to isolated world query event
  document.addEventListener('yts-get-instagram-url', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      resolveVideo(e.target);
    }
  }, true);

  // Proactive resolution on loadedmetadata and play
  document.addEventListener('loadedmetadata', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      delete e.target.dataset.ytsDirectUrl;
      delete e.target.dataset.ytsCoverUrl;
      resolveVideo(e.target);
    }
  }, true);

  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      resolveVideo(e.target);
    }
  }, true);

  // Periodic scan for visible videos
  setInterval(() => {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      if (!v.dataset.ytsDirectUrl) resolveVideo(v);
    }
  }, 1500);
})();
