from fastapi import FastAPI, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
import uvicorn
import os
import socket
import qrcode
import re
import time
import logging
from io import BytesIO
import base64
from collections import defaultdict
from config import get as cfg
from downloader import VideoDownloader

# --- 日志系统 ---
os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("logs/downloader.log", encoding="utf-8", maxBytes=10*1024*1024, backupCount=5),
    ],
)
logger = logging.getLogger("yt-downloader")

app = FastAPI()

# --- 配置 ---
RATE_LIMIT_MAX = cfg("security.rate_limit_max", 10)
RATE_LIMIT_WINDOW = cfg("security.rate_limit_window", 60)
AUTH_PASSWORD = cfg("auth.password", "") or os.environ.get("AUTH_PASSWORD", "")
DOWNLOAD_DIR = cfg("download.dir", "downloads")
SERVER_PORT = cfg("server.port", 19999)

# --- 安全：CORS 限制 ---
ALLOWED_ORIGINS = [
    f"http://localhost:{SERVER_PORT}",
    f"http://127.0.0.1:{SERVER_PORT}",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"^https?://(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 安全：速率限制 ---
_rate_limit_store: dict[str, list[float]] = defaultdict(list)

def _check_rate_limit(ip: str):
    now = time.time()
    timestamps = _rate_limit_store[ip]
    _rate_limit_store[ip] = [t for t in timestamps if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_limit_store[ip]) >= RATE_LIMIT_MAX:
        logger.warning(f"速率限制触发: {ip}")
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后重试")
    _rate_limit_store[ip].append(now)

# --- 安全：密码认证 ---
def _check_auth(request: Request):
    if not AUTH_PASSWORD:
        return
    auth_header = request.headers.get("Authorization", "")
    if auth_header == f"Bearer {AUTH_PASSWORD}":
        return
    raise HTTPException(status_code=401, detail="需要密码认证")

# --- 安全：URL 验证 ---
ALLOWED_URL_PATTERNS = [
    re.compile(r'^https?://(www\.)?youtube\.com/'),
    re.compile(r'^https?://(m\.)?youtube\.com/'),
    re.compile(r'^https?://youtu\.be/'),
    re.compile(r'^https?://music\.youtube\.com/'),
]

def _validate_url(url: str) -> str:
    if not any(p.match(url) for p in ALLOWED_URL_PATTERNS):
        raise HTTPException(status_code=400, detail="仅支持 YouTube 链接")
    return url

downloader = VideoDownloader(download_dir=DOWNLOAD_DIR)

# --- API Models ---

class DownloadRequest(BaseModel):
    url: str
    proxy: str = None
    quality: str = "1080p"

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        return _validate_url(v)

class BatchDownloadRequest(BaseModel):
    urls: list[str]
    proxy: str = None
    quality: str = "1080p"

    @field_validator("urls")
    @classmethod
    def validate_urls(cls, v: list[str]) -> list[str]:
        return [_validate_url(url) for url in v]

# --- API Routes ---

@app.get("/api/info")
async def get_video_info(request: Request, url: str, proxy: str = None):
    _check_rate_limit(request.client.host)
    _check_auth(request)
    _validate_url(url)
    logger.info(f"获取视频信息: {url}")
    return downloader.get_info(url, proxy)

@app.post("/api/download")
async def start_download(req: DownloadRequest, request: Request):
    _check_rate_limit(request.client.host)
    _check_auth(request)
    task_id = downloader.start_download(req.url, req.proxy, req.quality)
    logger.info(f"创建下载任务: {task_id} -> {req.url} [{req.quality}]")
    return {"task_id": task_id, "status": "started"}

@app.post("/api/download/batch")
async def start_batch_download(req: BatchDownloadRequest, request: Request):
    _check_rate_limit(request.client.host)
    _check_auth(request)
    task_ids = []
    for url in req.urls:
        tid = downloader.start_download(url, req.proxy, req.quality)
        task_ids.append(tid)
    logger.info(f"批量创建 {len(task_ids)} 个下载任务")
    return {"task_ids": task_ids, "status": "started"}

@app.get("/api/status/{task_id}")
async def get_status(task_id: str, request: Request):
    _check_rate_limit(request.client.host)
    _check_auth(request)
    return downloader.get_status(task_id)

@app.get("/api/files")
async def list_files(request: Request):
    _check_rate_limit(request.client.host)
    _check_auth(request)
    return {"files": downloader.list_files(), "directory": downloader.download_dir}

@app.get("/api/open-folder")
async def open_folder(request: Request):
    _check_rate_limit(request.client.host)
    _check_auth(request)
    import subprocess as sp
    sp.Popen(f'explorer "{downloader.download_dir}"', shell=True)
    return {"ok": True}

@app.get("/api/qr")
async def get_qr(request: Request):
    _check_rate_limit(request.client.host)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()

    url = f"http://{IP}:{SERVER_PORT}"
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buffered = BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()

    return {"ip": IP, "url": url, "qr_image": f"data:image/png;base64,{img_str}"}

@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "active_tasks": downloader.active_task_count(),
        "download_dir": downloader.download_dir,
    }

# --- Static Files ---

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

logger.info(f"服务启动 | 端口: {SERVER_PORT} | 下载目录: {DOWNLOAD_DIR} | 认证: {'已启用' if AUTH_PASSWORD else '未启用'}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=SERVER_PORT)
