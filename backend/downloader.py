import subprocess
import threading
import re
import os
import uuid
import glob
import imageio_ffmpeg

class DownloadTask:
    def __init__(self, task_id, url):
        self.task_id = task_id
        self.url = url
        self.status = "pending"   # pending / downloading / processing / completed / error
        self.progress = 0.0
        self.filename = ""
        self.error = ""
        self.title = ""
        self.speed = ""
        self.eta = ""
        self.filesize = ""

class VideoDownloader:
    def __init__(self, download_dir="downloads"):
        self.download_dir = os.path.abspath(download_dir)
        os.makedirs(self.download_dir, exist_ok=True)
        self.tasks = {}
        self.ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        print(f"[INIT] ffmpeg 路径: {self.ffmpeg_path}")
        print(f"[INIT] 下载目录: {self.download_dir}")
        # 启动时清理不完整的中间文件
        self._cleanup_partial_files()

    def _cleanup_partial_files(self):
        """清理 .f*.mp4 / .f*.m4a 等未合并的中间文件"""
        patterns = [
            os.path.join(self.download_dir, "*.f*.mp4"),
            os.path.join(self.download_dir, "*.f*.m4a"),
            os.path.join(self.download_dir, "*.f*.webm"),
            os.path.join(self.download_dir, "*.ytdl"),
            os.path.join(self.download_dir, "*.part"),
        ]
        count = 0
        for pattern in patterns:
            for f in glob.glob(pattern):
                try:
                    os.remove(f)
                    count += 1
                    print(f"[CLEANUP] 删除中间文件: {os.path.basename(f)}")
                except Exception:
                    pass
        if count:
            print(f"[CLEANUP] 共清理 {count} 个中间文件")

    def get_info(self, url, proxy=None):
        """获取视频信息（标题、时长等）"""
        cmd = [
            "yt-dlp",
            "--dump-json",
            "--no-download",
            "--no-warnings",
            "--no-check-certificates",
            "--ffmpeg-location", self.ffmpeg_path,
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
                return {"error": result.stderr}
        except Exception as e:
            return {"error": str(e)}

    def start_download(self, url, proxy=None):
        """启动下载任务，返回 task_id"""
        task_id = str(uuid.uuid4())[:8]
        task = DownloadTask(task_id, url)
        self.tasks[task_id] = task

        thread = threading.Thread(target=self._download_worker, args=(task, proxy), daemon=True)
        thread.start()
        return task_id

    def get_status(self, task_id):
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
        }

    def list_files(self):
        """列出已下载的文件"""
        files = []
        try:
            for f in os.listdir(self.download_dir):
                filepath = os.path.join(self.download_dir, f)
                if os.path.isfile(filepath):
                    # 跳过中间文件
                    if re.search(r'\.f\d+\.\w+$', f) or f.endswith('.ytdl') or f.endswith('.part'):
                        continue
                    size_bytes = os.path.getsize(filepath)
                    if size_bytes < 1024:
                        size_str = f"{size_bytes} B"
                    elif size_bytes < 1024 * 1024:
                        size_str = f"{size_bytes / 1024:.1f} KB"
                    else:
                        size_str = f"{size_bytes / (1024*1024):.1f} MB"
                    files.append({
                        "name": f,
                        "size": size_str,
                        "size_bytes": size_bytes,
                    })
            files.sort(key=lambda x: x["size_bytes"], reverse=True)
        except Exception:
            pass
        return files

    def _download_worker(self, task, proxy):
        """在后台线程执行 yt-dlp CLI 下载"""
        cmd = [
            "yt-dlp",
            "--newline",                        # 每行输出进度
            "--no-warnings",
            "--ffmpeg-location", self.ffmpeg_path,
            "--merge-output-format", "mp4",      # 合并为 mp4
            # 格式：最佳视频+最佳音频，优先 H.264 编码（兼容性最强）
            "-f", "bv[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv[vcodec^=avc1]+ba/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b",
            "--format-sort", "vcodec:h264,res,ext:mp4:m4a",  # 强制优先 H.264 > VP9 > AV1
            "-o", os.path.join(self.download_dir, "%(title)s.%(ext)s"),
            # === 反 403 策略 ===
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            # === 网络韧性 ===
            "--no-part",
            "--retries", "30",
            "--fragment-retries", "30",
            "--retry-sleep", "linear=1::2",
            "--no-check-certificates",
            "--socket-timeout", "30",
            "--extractor-retries", "5",
            "--file-access-retries", "5",
            "--continue",
        ]
        # 如果用户手动放了 cookies.txt，自动使用
        cookies_file = os.path.join(os.path.dirname(self.download_dir), "cookies.txt")
        if os.path.exists(cookies_file):
            cmd += ["--cookies", cookies_file]
            print(f"[COOKIES] 使用 cookies 文件: {cookies_file}")
        
        if proxy:
            cmd += ["--proxy", proxy]
        cmd.append(task.url)

        print(f"[DOWNLOAD] 执行命令: {' '.join(cmd)}")
        task.status = "downloading"

        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

            for line in process.stdout:
                line = line.strip()
                if not line:
                    continue
                print(f"[YT-DLP] {line}")
                self._parse_progress(task, line)

            process.wait()

            if process.returncode == 0:
                task.status = "completed"
                task.progress = 100.0
                self._find_downloaded_file(task)
                print(f"[DONE] 任务 {task.task_id} 完成: {task.filename}")
            else:
                task.status = "error"
                if not task.error:
                    task.error = f"yt-dlp 返回错误码: {process.returncode}"
                print(f"[ERROR] 任务 {task.task_id} 失败: {task.error}")

        except Exception as e:
            task.status = "error"
            task.error = str(e)
            print(f"[EXCEPTION] {e}")

    def _parse_progress(self, task, line):
        """解析 yt-dlp 的输出行，提取进度"""
        # 匹配: [download]  45.2% of  120.50MiB at  2.30MiB/s ETA 00:30
        match = re.search(r'\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)', line)
        if match:
            task.progress = float(match.group(1))
            task.filesize = match.group(2)
            task.speed = match.group(3)
            task.eta = match.group(4)
            task.status = "downloading"
            return

        # 匹配没有 ETA 的进度行: [download] 100% of 120.50MiB
        match = re.search(r'\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)', line)
        if match:
            task.progress = float(match.group(1))
            task.filesize = match.group(2)
            return

        # 匹配: [download] Destination: filename.mp4
        match = re.search(r'\[download\] Destination:\s+(.+)', line)
        if match:
            task.filename = os.path.basename(match.group(1))
            return

        # 匹配: [Merger] Merging formats...
        if '[Merger]' in line or 'Merging' in line:
            task.status = "processing"
            task.progress = 99.0
            return

        # 匹配: [youtube] 提取标题
        match = re.search(r'\[download\]\s+(.+)\s+has already been downloaded', line)
        if match:
            task.filename = os.path.basename(match.group(1))
            task.status = "completed"
            task.progress = 100.0
            return

        # 匹配: ERROR
        if 'ERROR' in line:
            task.error = line
            return

    def _find_downloaded_file(self, task):
        """尝试找到最新下载的文件"""
        if task.filename and not re.search(r'\.f\d+\.\w+$', task.filename):
            return
        # 找 downloads 目录下最新的 .mp4 文件（排除中间文件）
        try:
            files = [f for f in os.listdir(self.download_dir) 
                     if f.endswith('.mp4') and not re.search(r'\.f\d+\.mp4$', f)]
            if files:
                files.sort(key=lambda f: os.path.getmtime(os.path.join(self.download_dir, f)), reverse=True)
                task.filename = files[0]
        except Exception:
            pass
