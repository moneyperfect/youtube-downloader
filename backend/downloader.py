import subprocess
import threading
import re
import os
import uuid
import glob
import time
import imageio_ffmpeg

class DownloadTask:
    def __init__(self, task_id, url, quality="1080p"):
        self.task_id = task_id
        self.url = url
        self.quality = quality
        self.status = "pending"   # pending / downloading / processing / completed / error
        self.progress = 0.0
        self.filename = ""
        self.error = ""
        self.title = ""
        self.speed = ""
        self.eta = ""
        self.filesize = ""
        self.last_progress_time = time.time()

# --- 错误分类 ---
ERROR_MESSAGES = {
    "Video is private": "视频为私有，无法下载",
    "Sign in to confirm your age": "年龄限制视频，请在项目根目录放置 cookies.txt",
    "This video is not available": "视频不可用，可能已被删除",
    "Video unavailable": "视频不可用",
    "HTTP Error 403": "访问被拒绝，可能是地区限制或代理问题",
    "HTTP Error 404": "视频不存在或已被删除",
    "HTTP Error 429": "请求过于频繁，请稍后重试",
    "Network error": "网络连接失败，请检查代理设置",
    "Too Many Requests": "请求过于频繁，请稍后重试",
    "urlopen error": "网络连接失败，请检查网络或代理",
    "SSL": "SSL 证书错误，请检查网络环境",
    "timeout": "连接超时，请检查网络",
    "Proxy": "代理连接失败，请检查代理设置",
    "ERROR: Sign in": "需要登录，请提供 cookies.txt",
    "This live event will begin": "直播尚未开始",
    "This video is only available": "该视频有地区限制",
}

def classify_error(error_msg: str) -> str:
    """将 yt-dlp 错误信息映射为友好中文提示"""
    for keyword, friendly_msg in ERROR_MESSAGES.items():
        if keyword.lower() in error_msg.lower():
            return friendly_msg
    if len(error_msg) > 200:
        return f"下载失败：{error_msg[:200]}..."
    return f"下载失败：{error_msg}"

def sanitize_filename(name: str) -> str:
    """消毒文件名，移除危险字符"""
    # 移除路径遍历字符
    name = name.replace("..", "").replace("/", "").replace("\\", "")
    # 移除 Windows 非法字符
    name = re.sub(r'[<>:"|?*]', '', name)
    # 限制长度
    if len(name) > 200:
        name = name[:200]
    return name.strip() or "video"

# --- 画质格式映射 ---
QUALITY_FORMATS = {
    "1080p": "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba[ext=m4a]/bv*+ba/b",
    "720p": "bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba[ext=m4a]/bv*+ba/b",
    "480p": "bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=480]+ba[ext=m4a]/bv*+ba/b",
    "audio": "ba[ext=m4a]/ba/b",
}

DOWNLOAD_TIMEOUT = 300  # 5 分钟无进度视为超时

class VideoDownloader:
    def __init__(self, download_dir="downloads"):
        self.download_dir = os.path.abspath(download_dir)
        os.makedirs(self.download_dir, exist_ok=True)
        self.tasks: dict[str, DownloadTask] = {}
        self.ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        self._cleanup_partial_files()
        self._lock = threading.Lock()

    def _cleanup_partial_files(self):
        """清理未合并的中间文件"""
        patterns = [
            os.path.join(self.download_dir, "*.f*.mp4"),
            os.path.join(self.download_dir, "*.f*.m4a"),
            os.path.join(self.download_dir, "*.f*.webm"),
            os.path.join(self.download_dir, "*.ytdl"),
            os.path.join(self.download_dir, "*.part"),
        ]
        for pattern in patterns:
            for f in glob.glob(pattern):
                try:
                    os.remove(f)
                except Exception:
                    pass

    def get_info(self, url: str, proxy: str = None) -> dict:
        """获取视频信息"""
        cmd = [
            "yt-dlp", "--dump-json", "--no-download", "--no-warnings",
            "--no-check-certificates", "--ffmpeg-location", self.ffmpeg_path,
        ]
        if proxy:
            cmd += ["--proxy", proxy]
        cmd.append(url)

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, encoding="utf-8")
            if result.returncode == 0:
                import json
                info = json.loads(result.stdout)
                return {
                    "title": info.get("title", "未知"),
                    "duration": info.get("duration", 0),
                    "thumbnail": info.get("thumbnail", ""),
                    "uploader": info.get("uploader", "未知"),
                    "view_count": info.get("view_count", 0),
                }
            else:
                return {"error": classify_error(result.stderr)}
        except Exception as e:
            return {"error": classify_error(str(e))}

    def start_download(self, url: str, proxy: str = None, quality: str = "1080p") -> str:
        """启动下载任务，返回 task_id"""
        task_id = str(uuid.uuid4())[:8]
        task = DownloadTask(task_id, url, quality)
        with self._lock:
            self.tasks[task_id] = task

        thread = threading.Thread(target=self._download_worker, args=(task, proxy), daemon=True)
        thread.start()
        return task_id

    def get_status(self, task_id: str) -> dict:
        """获取下载状态"""
        task = self.tasks.get(task_id)
        if not task:
            return {"error": "任务不存在"}
        return {
            "task_id": task.task_id,
            "status": task.status,
            "progress": round(task.progress, 1),
            "filename": task.filename,
            "title": task.title,
            "speed": task.speed,
            "eta": task.eta,
            "error": task.error,
            "filesize": task.filesize,
            "quality": task.quality,
        }

    def list_files(self) -> list[dict]:
        """列出已下载的文件"""
        files = []
        try:
            for f in os.listdir(self.download_dir):
                filepath = os.path.join(self.download_dir, f)
                if os.path.isfile(filepath):
                    if re.search(r'\.f\d+\.\w+$', f) or f.endswith('.ytdl') or f.endswith('.part'):
                        continue
                    size_bytes = os.path.getsize(filepath)
                    if size_bytes < 1024:
                        size_str = f"{size_bytes} B"
                    elif size_bytes < 1024 * 1024:
                        size_str = f"{size_bytes / 1024:.1f} KB"
                    else:
                        size_str = f"{size_bytes / (1024*1024):.1f} MB"
                    files.append({"name": f, "size": size_str, "size_bytes": size_bytes})
            files.sort(key=lambda x: x["size_bytes"], reverse=True)
        except Exception:
            pass
        return files

    def active_task_count(self) -> int:
        """返回活跃任务数"""
        return sum(1 for t in self.tasks.values() if t.status in ("pending", "downloading", "processing"))

    def _download_worker(self, task: DownloadTask, proxy: str = None):
        """后台线程执行下载"""
        fmt = QUALITY_FORMATS.get(task.quality, QUALITY_FORMATS["1080p"])

        cmd = [
            "yt-dlp", "--newline", "--no-warnings",
            "--ffmpeg-location", self.ffmpeg_path,
            "--merge-output-format", "mp4",
            "-f", fmt,
            "--format-sort", "vcodec:h264,res,ext:mp4:m4a",
            "-o", os.path.join(self.download_dir, "%(title)s.%(ext)s"),
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "--no-part", "--retries", "30", "--fragment-retries", "30",
            "--retry-sleep", "linear=1::2", "--no-check-certificates",
            "--socket-timeout", "30", "--extractor-retries", "5",
            "--file-access-retries", "5", "--continue",
        ]

        cookies_file = os.path.join(os.path.dirname(self.download_dir), "cookies.txt")
        if os.path.exists(cookies_file):
            cmd += ["--cookies", cookies_file]

        if proxy:
            cmd += ["--proxy", proxy]
        cmd.append(task.url)

        task.status = "downloading"
        task.last_progress_time = time.time()

        # 超时检测线程
        def _timeout_checker():
            while task.status in ("downloading", "processing"):
                if time.time() - task.last_progress_time > DOWNLOAD_TIMEOUT:
                    task.status = "error"
                    task.error = "下载超时，可能是网络问题，请检查代理设置后重试"
                    return
                time.sleep(10)

        timeout_thread = threading.Thread(target=_timeout_checker, daemon=True)
        timeout_thread.start()

        try:
            process = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
            )

            for line in process.stdout:
                line = line.strip()
                if line:
                    self._parse_progress(task, line)

            process.wait()

            if process.returncode == 0:
                task.status = "completed"
                task.progress = 100.0
                self._find_downloaded_file(task)
            else:
                task.status = "error"
                if not task.error:
                    task.error = classify_error(f"yt-dlp 返回错误码: {process.returncode}")

        except Exception as e:
            task.status = "error"
            task.error = classify_error(str(e))

    def _parse_progress(self, task: DownloadTask, line: str):
        """解析 yt-dlp 输出，提取进度"""
        # [download] 45.2% of 120.50MiB at 2.30MiB/s ETA 00:30
        match = re.search(r'\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)', line)
        if match:
            task.progress = float(match.group(1))
            task.filesize = match.group(2)
            task.speed = match.group(3)
            task.eta = match.group(4)
            task.status = "downloading"
            task.last_progress_time = time.time()
            return

        # [download] 100% of 120.50MiB
        match = re.search(r'\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)', line)
        if match:
            task.progress = float(match.group(1))
            task.filesize = match.group(2)
            task.last_progress_time = time.time()
            return

        # [download] Destination: filename.mp4
        match = re.search(r'\[download\] Destination:\s+(.+)', line)
        if match:
            task.filename = sanitize_filename(os.path.basename(match.group(1)))
            return

        # [Merger] Merging formats...
        if '[Merger]' in line or 'Merging' in line:
            task.status = "processing"
            task.progress = 99.0
            task.last_progress_time = time.time()
            return

        # already been downloaded
        match = re.search(r'\[download\]\s+(.+)\s+has already been downloaded', line)
        if match:
            task.filename = sanitize_filename(os.path.basename(match.group(1)))
            task.status = "completed"
            task.progress = 100.0
            return

        # ERROR
        if 'ERROR' in line:
            task.error = classify_error(line)

    def _find_downloaded_file(self, task: DownloadTask):
        """找到最新下载的文件"""
        if task.filename and not re.search(r'\.f\d+\.\w+$', task.filename):
            return
        try:
            files = [f for f in os.listdir(self.download_dir)
                     if f.endswith('.mp4') and not re.search(r'\.f\d+\.mp4$', f)]
            if files:
                files.sort(key=lambda f: os.path.getmtime(os.path.join(self.download_dir, f)), reverse=True)
                task.filename = files[0]
        except Exception:
            pass
