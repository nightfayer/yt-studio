# -*- coding: utf-8 -*-
"""
YT Studio - portable YouTube video / MP3 downloader.
Backend: Python stdlib only. Frontend: index.html (opens in your browser).
Dependencies (yt-dlp, ffmpeg) are auto-installed into ./bin on first run.
"""

import glob
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(APP_DIR, "bin")
DOWNLOAD_DIR = os.path.join(APP_DIR, "downloads")
TMP_ROOT = os.path.join(APP_DIR, ".tmp")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
HISTORY_PATH = os.path.join(APP_DIR, "history.json")

PORT_RANGE = range(8731, 8781)
MAX_PARALLEL = 3

IS_WIN = os.name == "nt"
EXE = ".exe" if IS_WIN else ""
YTDLP = os.path.join(BIN_DIR, "yt-dlp" + EXE)
FFMPEG = os.path.join(BIN_DIR, "ffmpeg" + EXE)
FFPROBE = os.path.join(BIN_DIR, "ffprobe" + EXE)

YTDLP_URL = ("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
             if IS_WIN else
             "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp")

# Several sources: the first one that answers wins.
FFMPEG_SOURCES = [
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl.zip",
    "https://github.com/GyanD/codexffmpeg/releases/download/7.1/"
    "ffmpeg-7.1-essentials_build.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
]

NO_WINDOW = subprocess.CREATE_NO_WINDOW if IS_WIN else 0
TOKEN = secrets.token_urlsafe(24)

APP_VERSION = "1.3.0"

setup_state = {"stage": "idle", "message": "", "done": False, "error": None,
               "ytdlpVersion": None, "appVersion": APP_VERSION}


# ---------------------------------------------------------------- config

DEFAULT_CONFIG = {
    "outputDir": DOWNLOAD_DIR,
    "proxy": "",
    "browserCookies": "none",
    "playerClient": "android,web",
    "downloadSubs": False,
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, dict):
                cfg.update(loaded)
    except Exception:
        pass
    return cfg


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


CONFIG = load_config()


def out_dir():
    d = CONFIG.get("outputDir") or DOWNLOAD_DIR
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        d = DOWNLOAD_DIR
        os.makedirs(d, exist_ok=True)
    return d


# ---------------------------------------------------------------- history

def load_history():
    try:
        if os.path.exists(HISTORY_PATH):
            with open(HISTORY_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
    except Exception:
        pass
    return []


def save_history(history_list):
    try:
        with open(HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(history_list[-50:], f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ---------------------------------------------------------------- jobs & state

jobs = {}
jobs_lock = threading.Lock()
slots = threading.Semaphore(MAX_PARALLEL)

# Preload persistent history into jobs
for item in load_history():
    if isinstance(item, dict) and "id" in item:
        jobs[item["id"]] = item


def public_job(j):
    """Returns a serializable, safe copy of a job dictionary."""
    return {k: v for k, v in j.items() if k != "proc"}


def _persist_history_locked():
    completed = [public_job(j) for j in jobs.values()
                 if j.get("status") in ("done", "error", "cancelled")]
    save_history(completed)


def safe_update_job(jid, **kwargs):
    with jobs_lock:
        if jid not in jobs:
            jobs[jid] = {"id": jid}
        jobs[jid].update(kwargs)
        if kwargs.get("status") in ("done", "error", "cancelled"):
            _persist_history_locked()


def safe_get_jobs():
    with jobs_lock:
        return [public_job(j) for j in jobs.values()]


def safe_get_job(jid):
    with jobs_lock:
        j = jobs.get(jid)
        return public_job(j) if j else None


def safe_cancel_job(jid):
    with jobs_lock:
        j = jobs.get(jid)
        if j:
            j["status"] = "cancelled"
            proc = j.get("proc")
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
            _persist_history_locked()


def safe_clear_jobs():
    with jobs_lock:
        to_del = [k for k, v in jobs.items()
                  if v.get("status") in ("done", "error", "cancelled")]
        for k in to_del:
            del jobs[k]
        _persist_history_locked()


# ---------------------------------------------------------------- folder picker

def pick_folder(initial_dir=None):
    """Opens a native OS folder dialog without pip dependencies."""
    init = initial_dir or out_dir()

    # Try tkinter first (included in Python on Windows/macOS)
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(initialdir=init, title="Выберите папку сохранения YT Studio")
        root.destroy()
        if folder:
            return os.path.normpath(folder)
    except Exception:
        pass

    # Windows fallback: PowerShell FolderBrowserDialog
    if IS_WIN:
        try:
            esc = init.replace("'", "''")
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$f.Description = 'Выберите папку сохранения YT Studio'; "
                "$f.SelectedPath = '%s'; "
                "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"
                % esc
            )
            p = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                               capture_output=True, text=True, timeout=60,
                               creationflags=NO_WINDOW)
            lines = [l.strip() for l in p.stdout.splitlines() if l.strip()]
            if lines and os.path.isdir(lines[-1]):
                return os.path.normpath(lines[-1])
        except Exception:
            pass

    return None


# ---------------------------------------------------------------- setup

def _fetch(url, dest, label):
    setup_state["message"] = label
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        total = int(r.headers.get("Content-Length") or 0)
        buf, got = io.BytesIO(), 0
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            buf.write(chunk)
            got += len(chunk)
            if total:
                setup_state["message"] = "%s  %d%%" % (label, got * 100 // total)
            else:
                setup_state["message"] = "%s  %.1f МБ" % (label, got / 1048576)
        data = buf.getvalue()
    if dest:
        with open(dest, "wb") as f:
            f.write(data)
    return data


def _extract_ffmpeg(zip_bytes):
    wanted = ("ffmpeg" + EXE, "ffprobe" + EXE)
    found = False
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base in wanted:
                with z.open(name) as src, open(os.path.join(BIN_DIR, base), "wb") as dst:
                    shutil.copyfileobj(src, dst)
                if base == wanted[0]:
                    found = True
    if not found:
        raise RuntimeError("в архиве нет ffmpeg")


def ytdlp_version():
    try:
        p = subprocess.run([YTDLP, "--version"], capture_output=True,
                           timeout=30, creationflags=NO_WINDOW)
        return p.stdout.decode("utf-8", "replace").strip() or None
    except Exception:
        return None


def ensure_deps():
    try:
        os.makedirs(BIN_DIR, exist_ok=True)

        if not os.path.exists(YTDLP):
            setup_state["stage"] = "yt-dlp"
            _fetch(YTDLP_URL, YTDLP, "Загрузка yt-dlp")
            if not IS_WIN:
                os.chmod(YTDLP, 0o755)

        if not os.path.exists(FFMPEG):
            system_ffmpeg = shutil.which("ffmpeg")
            if system_ffmpeg:
                shutil.copy2(system_ffmpeg, FFMPEG)
                probe_exe = shutil.which("ffprobe")
                if probe_exe:
                    shutil.copy2(probe_exe, os.path.join(BIN_DIR, "ffprobe" + EXE))
            elif IS_WIN:
                setup_state["stage"] = "ffmpeg"
                errors = []
                for i, url in enumerate(FFMPEG_SOURCES, 1):
                    try:
                        data = _fetch(url, None, "Загрузка FFmpeg (источник %d)" % i)
                        setup_state["message"] = "Распаковка FFmpeg"
                        _extract_ffmpeg(data)
                        break
                    except Exception as e:
                        errors.append("%d: %s" % (i, e))
                else:
                    raise RuntimeError("не удалось получить FFmpeg — " +
                                       "; ".join(errors))
            elif sys.platform == "darwin":
                raise RuntimeError("FFmpeg не найден. Установите: brew install ffmpeg")
            else:
                raise RuntimeError("FFmpeg не найден. Установите его пакетным "
                                   "менеджером, например: sudo apt install ffmpeg")

        setup_state["ytdlpVersion"] = ytdlp_version()
        setup_state["stage"] = "ready"
        setup_state["message"] = "Готово"
        setup_state["done"] = True
    except Exception as e:
        setup_state["error"] = str(e)
        setup_state["message"] = "Ошибка: %s" % e


def update_ytdlp():
    """yt-dlp self-update; falls back to a fresh download."""
    try:
        p = subprocess.run([YTDLP, "-U"], capture_output=True, timeout=180,
                           creationflags=NO_WINDOW)
        out = (p.stdout + p.stderr).decode("utf-8", "replace").strip()
        if p.returncode != 0:
            raise RuntimeError(out.splitlines()[-1] if out else "ошибка обновления")
    except Exception:
        try:
            os.remove(YTDLP)
        except Exception:
            pass
        _fetch(YTDLP_URL, YTDLP, "Загрузка yt-dlp")
        if not IS_WIN:
            os.chmod(YTDLP, 0o755)
        out = "Загружена свежая сборка"
    setup_state["ytdlpVersion"] = ytdlp_version()
    return {"message": out[-400:], "version": setup_state["ytdlpVersion"]}


# ---------------------------------------------------------------- probing

def extra_network_args():
    """Returns extra arguments for proxy, browser cookies, and throttling bypass."""
    args = []
    proxy = (CONFIG.get("proxy") or "").strip()
    if proxy:
        args += ["--proxy", proxy]

    cookies = (CONFIG.get("browserCookies") or "none").strip().lower()
    if cookies and cookies != "none":
        args += ["--cookies-from-browser", cookies]

    client = (CONFIG.get("playerClient") or "android,web").strip()
    if client and client != "default":
        args += ["--extractor-args", "youtube:player_client=" + client]

    return args


def run_json(args, timeout=75):
    """Runs yt-dlp and parses its JSON, with a hard time limit.

    Without a limit a single unreachable request can keep the browser spinner
    running for minutes, which looks like a freeze.
    """
    cmd = [YTDLP, "--ignore-config", "--no-warnings",
           "--socket-timeout", "15", "--retries", "2"] + extra_network_args() + args
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout,
                           creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            "yt-dlp не ответил за %d с. Проверьте интернет и ссылку, "
            "затем обновите yt-dlp в настройках." % timeout)

    txt = p.stdout.decode("utf-8", "replace")
    if p.returncode != 0 or not txt.strip():
        err = [l.strip() for l in
               (p.stderr or b"").decode("utf-8", "replace").splitlines()
               if l.strip()]
        msg = err[-1] if err else "yt-dlp не смог прочитать ссылку"
        raise RuntimeError(msg.replace("ERROR: ", ""))
    try:
        return json.loads(txt)
    except ValueError:
        raise RuntimeError("yt-dlp вернул неожиданный ответ")


AUDIO_BITRATES = [320, 256, 192, 160, 128, 96, 64]


def probe(url):
    """Returns metadata + the qualities actually available for this video."""
    playlist, first_entry = None, None
    m = re.search(r"[?&]list=([\w-]+)", url)
    # RD.. / UL.. are auto-generated "mixes": endless and pointless to scan.
    is_mix = bool(m and m.group(1).startswith(("RD", "UL")))
    if (m and not is_mix) or "/playlist" in url:
        try:
            flat = run_json(["-J", "--flat-playlist", "--playlist-end", "500",
                             url], timeout=45)
            entries = [e for e in (flat.get("entries") or []) if e]
            if flat.get("_type") == "playlist" and len(entries) > 1:
                playlist = {"count": len(entries),
                            "title": flat.get("title") or "Плейлист"}
                first_entry = (entries[0].get("url") or entries[0].get("id"))
        except Exception:
            pass

    try:
        info = run_json(["-J", "--no-playlist", url])
    except Exception:
        # A pure playlist link has no video of its own: read the first item so
        # the quality list still reflects real formats.
        if not first_entry:
            raise
        info = run_json(["-J", "--no-playlist", first_entry])

    by_height, best_abr, has_avc = {}, 0, set()
    for f in info.get("formats") or []:
        vcodec = f.get("vcodec")
        acodec = f.get("acodec")
        if vcodec and vcodec != "none":
            h, fps = f.get("height"), f.get("fps") or 0
            if not h:
                continue
            prev = by_height.get(h)
            if not prev or fps > prev["fps"]:
                by_height[h] = {"height": h, "fps": fps}
            if str(vcodec).startswith("avc1"):
                has_avc.add(h)
        if acodec and acodec != "none" and (not vcodec or vcodec == "none"):
            best_abr = max(best_abr, int(f.get("abr") or 0))

    video = []
    for h in sorted(by_height, reverse=True):
        fps = by_height[h]["fps"]
        video.append({"height": h,
                      "label": "%dp%s" % (h, "60" if fps >= 50 else ""),
                      "avc": h in has_avc})

    # 0 = Original lossless audio without MP3 re-encoding
    audio = [0] + list(AUDIO_BITRATES)

    return {
        "sourceAbr": round(best_abr) if best_abr else None,
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "durationText": info.get("duration_string"),
        "thumbnail": info.get("thumbnail"),
        "viewCount": info.get("view_count"),
        "webpage": info.get("webpage_url") or url,
        "originalUrl": url,
        "video": video,
        "audio": audio,
        "playlist": playlist,
    }


# ---------------------------------------------------------------- download

PROG = "###"
# Numeric fields only: the UI formats them and draws the live speed graph.
PROGRESS_TEMPLATE = (
    "download:" + PROG
    + "|%(progress.downloaded_bytes)s"
    + "|%(progress.total_bytes)s"
    + "|%(progress.total_bytes_estimate)s"
    + "|%(progress.speed)s"
    + "|%(progress.eta)s"
    + "|%(info.vcodec)s|"
)
ITEM_RE = re.compile(r"Downloading item (\d+) of (\d+)")


def _num(s):
    try:
        v = float(str(s).strip())
        return v if v >= 0 else None
    except (TypeError, ValueError):
        return None


def build_cmd(url, mode, quality, compat, whole_playlist, tmp_dir, subs=False):
    base = [
        YTDLP, "--newline", "--no-warnings", "--no-mtime", "--ignore-config",
        "--windows-filenames", "--trim-filenames", "160",
        "--ffmpeg-location", BIN_DIR,
        "--concurrent-fragments", "4", "--retries", "10",
        "--progress-template", PROGRESS_TEMPLATE,
        "--print", "after_move:filepath",
        "-P", "home:" + out_dir(), "-P", "temp:" + tmp_dir,
    ] + extra_network_args()

    if subs or CONFIG.get("downloadSubs"):
        base += ["--write-subs", "--write-auto-subs", "--sub-langs", "ru.*,en.*",
                 "--embed-subs"]

    if whole_playlist:
        base += ["--yes-playlist",
                 "-o", os.path.join("%(playlist_title,playlist|Playlist)s",
                                    "%(playlist_index)02d - %(title)s.%(ext)s")]
    else:
        base += ["--no-playlist", "-o", "%(title)s.%(ext)s"]

    if mode == "audio":
        # 0 = lossless extraction of original YouTube audio stream without re-encoding
        if str(quality) in ("0", "original", "best"):
            return base + ["-f", "bestaudio/best", "-x",
                           "--embed-thumbnail", "--embed-metadata", url]
        return base + ["-f", "bestaudio/best", "-x", "--audio-format", "mp3",
                       "--audio-quality", "%dK" % int(quality),
                       "--embed-thumbnail", "--embed-metadata", url]

    # An MP4 container with an Opus track plays silently in most Windows
    # players, so AAC (mp4a) audio is requested first and Opus is transcoded
    # to AAC during the merge as a fallback.
    h = int(quality)
    avc = "[vcodec^=avc1]" if compat else ""
    sel = "/".join([
        "bv*[height<=%d]%s+ba[acodec^=mp4a]" % (h, avc),
        "bv*[height<=%d]%s+ba" % (h, avc),
        "bv*[height<=%d]+ba[acodec^=mp4a]" % h,
        "bv*[height<=%d]+ba" % h,
        "b[height<=%d]" % h,
        "bv*+ba", "b",
    ])
    return base + [
        "-f", sel, "--merge-output-format", "mp4", "--embed-metadata",
        "--postprocessor-args", "Merger:-movflags +faststart",
        url,
    ]


def audio_codec(path):
    """Returns the audio codec of a file, '' when there is no audio track,
    or None when it cannot be determined."""
    if not path or not os.path.exists(path) or not os.path.exists(FFPROBE):
        return None
    try:
        p = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of",
             "default=nw=1:nk=1", path],
            capture_output=True, timeout=90, creationflags=NO_WINDOW)
        return p.stdout.decode("utf-8", "replace").strip()
    except Exception:
        return None


# Codecs that a plain MP4 container should not carry: Windows players show
# such a file as "video without sound".
BAD_IN_MP4 = ("opus", "vorbis")


def transcode_audio_to_aac(path):
    """Rewrites the file in place with an AAC audio track, video untouched."""
    tmp = path + ".fix.mp4"
    p = subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-i", path,
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", tmp],
        capture_output=True, timeout=3600, creationflags=NO_WINDOW)
    if p.returncode != 0 or not os.path.exists(tmp):
        try:
            os.remove(tmp)
        except Exception:
            pass
        raise RuntimeError((p.stderr or b"").decode("utf-8", "replace")[-300:])
    os.replace(tmp, path)


def verify_audio(job):
    """Guarantees the finished MP4 actually plays with sound."""
    codec = audio_codec(job.get("file"))
    if codec is None:
        return
    job["acodec"] = codec or None
    if codec == "":
        job["warn"] = ("В файле нет звуковой дорожки. Нажмите «Обновить yt-dlp» "
                       "в настройках и попробуйте снова.")
        return
    if codec.lower() in BAD_IN_MP4:
        job["stage"] = "Перекодирование звука в AAC"
        job["progress"] = 99
        try:
            transcode_audio_to_aac(job["file"])
            job["acodec"] = "aac"
        except Exception as e:
            job["warn"] = ("Звук в формате %s — часть плееров его не "
                           "воспроизводит (%s)" % (codec, str(e)[:120]))


def apply_progress(job_id, line):
    """One progress line -> live numbers + an honest single progress bar.

    A video download runs in two passes (video stream, then audio stream), so
    each pass is mapped onto its own slice of the bar instead of restarting it.
    """
    parts = line.split("|")
    if len(parts) < 7:
        return
    done = _num(parts[1])
    total = _num(parts[2]) or _num(parts[3])
    speed = _num(parts[4])
    eta = _num(parts[5])
    vcodec = (parts[6] or "").strip()

    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return

        job["speedBps"] = speed
        job["etaSec"] = int(eta) if eta is not None else None
        job["bytesDone"] = int(done) if done is not None else None
        job["bytesTotal"] = int(total) if total is not None else None
        job["tick"] = job.get("tick", 0) + 1

        pct = (done / total * 100.0) if (done is not None and total) else 0.0
        pct = max(0.0, min(100.0, pct))

        if job["mode"] == "audio":
            job["progress"] = pct * 0.85
            job["stage"] = "Скачивание аудио"
        elif vcodec and vcodec not in ("none", "NA", "None"):
            job["progress"] = pct * 0.70
            job["stage"] = "Скачивание видео"
        else:
            job["progress"] = 70 + pct * 0.22
            job["stage"] = "Скачивание аудиодорожки"

        # In a playlist the bar reflects the whole queue, not the current item.
        if job.get("total"):
            idx = max(1, job.get("index") or 1)
            job["progress"] = ((idx - 1) + job["progress"] / 100.0) / job["total"] * 100.0


def worker(job_id, url, mode, quality, compat, whole_playlist, subs=False):
    tmp_dir = os.path.join(TMP_ROOT, job_id)
    os.makedirs(tmp_dir, exist_ok=True)
    safe_update_job(job_id, stage="Ожидание слота")

    with slots:
        with jobs_lock:
            cur_st = jobs.get(job_id, {}).get("status")
        if cur_st == "cancelled":
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return

        safe_update_job(job_id, status="running", stage="Подготовка")
        log = []
        try:
            cmd = build_cmd(url, mode, quality, compat, whole_playlist, tmp_dir, subs)
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 creationflags=NO_WINDOW)
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]["proc"] = p

            for raw in p.stdout:
                text = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not text:
                    continue

                if text.startswith(PROG + "|"):
                    apply_progress(job_id, text)
                    continue

                log.append(text)
                del log[:-60]

                item = ITEM_RE.search(text)
                if item:
                    safe_update_job(job_id, index=int(item.group(1)), total=int(item.group(2)))
                elif "[Merger]" in text:
                    safe_update_job(job_id, stage="Склейка видео и звука", speedBps=None, etaSec=None)
                    with jobs_lock:
                        if not jobs.get(job_id, {}).get("total"):
                            jobs[job_id]["progress"] = 94
                elif "[ExtractAudio]" in text:
                    safe_update_job(job_id, stage="Извлечение аудио", speedBps=None, etaSec=None)
                    with jobs_lock:
                        if not jobs.get(job_id, {}).get("total"):
                            jobs[job_id]["progress"] = 88
                elif "[ThumbnailsConvertor]" in text or "[EmbedThumbnail]" in text:
                    safe_update_job(job_id, stage="Добавление обложки", speedBps=None, etaSec=None)
                    with jobs_lock:
                        if not jobs.get(job_id, {}).get("total"):
                            jobs[job_id]["progress"] = 96
                elif "[Metadata]" in text:
                    safe_update_job(job_id, stage="Запись тегов", speedBps=None, etaSec=None)
                    with jobs_lock:
                        if not jobs.get(job_id, {}).get("total"):
                            jobs[job_id]["progress"] = 98
                elif "[EmbedSubtitle]" in text:
                    safe_update_job(job_id, stage="Встраивание субтитров", speedBps=None, etaSec=None)
                elif os.path.isabs(text) and os.path.exists(text):
                    with jobs_lock:
                        if job_id in jobs:
                            jobs[job_id]["file"] = text
                            jobs[job_id]["files"] = jobs[job_id].get("files", 0) + 1

            p.wait()
            safe_update_job(job_id, log="\n".join(log[-40:]))

            with jobs_lock:
                st = jobs.get(job_id, {}).get("status")
            if st == "cancelled":
                safe_update_job(job_id, stage="Отменено")
            elif p.returncode == 0:
                with jobs_lock:
                    target_job = dict(jobs.get(job_id, {}))
                if mode == "video" and not whole_playlist:
                    verify_audio(target_job)
                    safe_update_job(job_id, acodec=target_job.get("acodec"), warn=target_job.get("warn"))
                safe_update_job(job_id, progress=100, stage="Завершено", status="done",
                                speedBps=None, etaSec=None)
            else:
                errs = [l for l in log if "ERROR" in l or "error" in l]
                err_msg = (errs[-1] if errs else (log[-1] if log else "неизвестная ошибка"))
                safe_update_job(job_id, status="error", stage="Ошибка",
                                error=err_msg.replace("ERROR: ", ""))
        except Exception as e:
            safe_update_job(job_id, status="error", stage="Ошибка", error=str(e),
                            log="\n".join(log[-40:]))
        finally:
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id].pop("proc", None)
            shutil.rmtree(tmp_dir, ignore_errors=True)


def sweep_temp():
    """Cleans only the isolated .tmp directory. Does NOT touch user downloads."""
    try:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)
    except Exception:
        pass


# ---------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "YTStudio"

    def log_message(self, *a):
        pass

    # -- security: loopback only, token-gated API, SameSite=Strict cookie
    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", "[::1]", "::1")

    def _token_ok(self):
        if self.headers.get("X-YTS-Token") == TOKEN:
            return True
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "yts" and v == TOKEN:
                return True
        return False

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origin) is not None

    def _send(self, code, body, ctype="application/json; charset=utf-8", cookie=False):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie",
                             "yts=%s; Path=/; SameSite=Strict; HttpOnly" % TOKEN)
        self.end_headers()
        self.wfile.write(body)

    def _guard(self):
        if not self._host_ok():
            self._send(403, {"error": "forbidden host"})
            return False
        if not self._origin_ok() or not self._token_ok():
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ("/", "/index.html"):
            if not self._host_ok():
                return self._send(403, "forbidden", "text/plain; charset=utf-8")
            try:
                with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                    return self._send(200, f.read(),
                                      "text/html; charset=utf-8", cookie=True)
            except FileNotFoundError:
                return self._send(404, "index.html не найден",
                                  "text/plain; charset=utf-8")

        if not path.startswith("/api/"):
            return self._send(404, {"error": "not found"})
        if not self._guard():
            return

        if path == "/api/setup":
            return self._send(200, setup_state)

        if path == "/api/config":
            return self._send(200, {
                "outputDir": out_dir(),
                "proxy": CONFIG.get("proxy", ""),
                "browserCookies": CONFIG.get("browserCookies", "none"),
                "playerClient": CONFIG.get("playerClient", "android,web"),
                "downloadSubs": bool(CONFIG.get("downloadSubs", False)),
                "ytdlpVersion": setup_state["ytdlpVersion"]
            })

        if path == "/api/jobs":
            return self._send(200, safe_get_jobs())

        if path == "/api/events":
            # Server-Sent Events (SSE) stream for real-time UI updates
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            last_data = ""
            pings = 0
            while True:
                current_jobs = safe_get_jobs()
                dumped = json.dumps(current_jobs, ensure_ascii=False)
                if dumped != last_data:
                    last_data = dumped
                    pings = 0
                    msg = ("data: %s\n\n" % dumped).encode("utf-8")
                    try:
                        self.wfile.write(msg)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        break
                else:
                    pings += 1
                    if pings >= 25:  # ~12 sec heartbeat ping
                        pings = 0
                        try:
                            self.wfile.write(b": ping\n\n")
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError, OSError):
                            break
                time.sleep(0.45)
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]

        # The body is always consumed first: leaving it unread would desync the
        # next request on a keep-alive connection.
        raw = b""
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if 0 < n <= 1 << 20:
                raw = self.rfile.read(n)
        except Exception:
            raw = b""

        if not path.startswith("/api/"):
            return self._send(404, {"error": "not found"})
        if not self._guard():
            return

        try:
            body = json.loads(raw or b"{}")
            if not isinstance(body, dict):
                body = {}
        except Exception:
            body = {}

        try:
            if path == "/api/info":
                url = (body.get("url") or "").strip()
                if not url:
                    return self._send(400, {"error": "Пустая ссылка"})
                return self._send(200, probe(url))

            if path == "/api/download":
                dl_url = (body.get("url") or "").strip()
                if not dl_url.startswith(("http://", "https://")):
                    return self._send(400, {"error": "Некорректная ссылка"})
                try:
                    dl_quality = int(body.get("quality"))
                except (TypeError, ValueError):
                    return self._send(400, {"error": "Не выбрано качество"})
                if body.get("mode") not in ("video", "audio"):
                    return self._send(400, {"error": "Неизвестный режим"})

                jid = "%d%03d" % (time.time() * 1000, len(jobs) % 1000)
                job = {"id": jid, "title": body.get("title") or "",
                       "mode": body.get("mode"),
                       "quality": dl_quality,
                       "compat": bool(body.get("compat")),
                       "playlist": bool(body.get("playlist")),
                       "subs": bool(body.get("subs", False)),
                       "thumb": body.get("thumb"), "progress": 0,
                       "stage": "В очереди", "status": "queued",
                       "file": None, "speedBps": None, "etaSec": None,
                       "bytesDone": None, "bytesTotal": None, "tick": 0,
                       "index": None, "total": None, "error": None, "log": "",
                       "warn": None, "acodec": None}

                with jobs_lock:
                    jobs[jid] = job

                threading.Thread(target=worker, args=(
                    jid, dl_url, job["mode"], job["quality"],
                    job["compat"], job["playlist"], job["subs"]), daemon=True).start()
                return self._send(200, public_job(job))

            if path == "/api/cancel":
                safe_cancel_job(str(body.get("id")))
                return self._send(200, {"ok": True})

            if path == "/api/clear":
                safe_clear_jobs()
                return self._send(200, {"ok": True})

            if path == "/api/update":
                return self._send(200, update_ytdlp())

            if path == "/api/pickDir":
                picked = pick_folder(CONFIG.get("outputDir"))
                if picked:
                    CONFIG["outputDir"] = picked
                    save_config(CONFIG)
                    return self._send(200, {"dir": picked})
                return self._send(200, {"dir": None})

            if path == "/api/reveal":
                target = body.get("path") or out_dir()
                if not os.path.exists(target):
                    target = out_dir()
                if IS_WIN:
                    if os.path.isfile(target):
                        subprocess.Popen(["explorer", "/select,",
                                          os.path.normpath(target)])
                    else:
                        os.startfile(target)
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", "-R", target] if os.path.isfile(target)
                                     else ["open", target])
                else:
                    subprocess.Popen(["xdg-open", os.path.dirname(target)
                                      if os.path.isfile(target) else target])
                return self._send(200, {"ok": True})

            if path == "/api/setOutput":
                d = (body.get("dir") or "").strip().strip('"')
                if not d or not os.path.isabs(d):
                    return self._send(400, {"error": "Нужен полный путь к папке"})
                try:
                    os.makedirs(d, exist_ok=True)
                    probe_file = os.path.join(d, ".yts_write_test")
                    open(probe_file, "w").close()
                    os.remove(probe_file)
                except Exception as e:
                    return self._send(400, {"error": "Папка недоступна: %s" % e})
                CONFIG["outputDir"] = d
                save_config(CONFIG)
                return self._send(200, {"outputDir": d})

            if path == "/api/setNetwork":
                if "proxy" in body:
                    CONFIG["proxy"] = str(body["proxy"]).strip()
                if "browserCookies" in body:
                    CONFIG["browserCookies"] = str(body["browserCookies"]).strip()
                if "playerClient" in body:
                    CONFIG["playerClient"] = str(body["playerClient"]).strip()
                if "downloadSubs" in body:
                    CONFIG["downloadSubs"] = bool(body["downloadSubs"])
                save_config(CONFIG)
                return self._send(200, {"ok": True})

            self._send(404, {"error": "not found"})
        except subprocess.TimeoutExpired:
            self._send(504, {"error": "yt-dlp не ответил вовремя"})
        except Exception as e:
            self._send(500, {"error": str(e)})


def bind_server():
    last = None
    for port in PORT_RANGE:
        try:
            return ThreadingHTTPServer(("127.0.0.1", port), Handler), port
        except OSError as e:
            last = e
    raise SystemExit("Не удалось занять ни один порт %d-%d: %s"
                     % (PORT_RANGE[0], PORT_RANGE[-1], last))


def main():
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    sweep_temp()
    threading.Thread(target=ensure_deps, daemon=True).start()

    srv, port = bind_server()
    url = "http://127.0.0.1:%d/" % port
    print("=" * 58)
    print("  YT Studio v%s" % APP_VERSION)
    print("  %s" % url)
    print("  Закройте это окно, чтобы остановить сервер.")
    print("=" * 58)
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with jobs_lock:
            for j in list(jobs.values()):
                proc = j.get("proc")
                if proc:
                    try:
                        proc.kill()
                    except Exception:
                        pass
        sweep_temp()


if __name__ == "__main__":
    if sys.version_info < (3, 8):
        raise SystemExit("Нужен Python 3.8 или новее.")
    main()
