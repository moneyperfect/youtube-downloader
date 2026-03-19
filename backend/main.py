from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import os
import socket
import qrcode
from io import BytesIO
import base64
from downloader import VideoDownloader

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

downloader = VideoDownloader(download_dir="downloads")

# --- API Models ---

class DownloadRequest(BaseModel):
    url: str
    proxy: str = None

# --- API Routes ---

@app.get("/api/info")
async def get_video_info(url: str, proxy: str = None):
    """获取视频基本信息"""
    return downloader.get_info(url, proxy)

@app.post("/api/download")
async def start_download(req: DownloadRequest):
    """开始下载视频"""
    task_id = downloader.start_download(req.url, req.proxy)
    return {"task_id": task_id, "status": "started"}

@app.get("/api/status/{task_id}")
async def get_status(task_id: str):
    """获取下载进度"""
    return downloader.get_status(task_id)

@app.get("/api/files")
async def list_files():
    """列出已下载的文件"""
    return {"files": downloader.list_files(), "directory": downloader.download_dir}

@app.get("/api/open-folder")
async def open_folder():
    """在文件管理器中打开下载目录"""
    import subprocess as sp
    sp.Popen(f'explorer "{downloader.download_dir}"', shell=True)
    return {"ok": True}

@app.get("/api/qr")
async def get_qr():
    """生成局域网访问二维码"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()

    url = f"http://{IP}:19999"

    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buffered = BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()

    return {"ip": IP, "url": url, "qr_image": f"data:image/png;base64,{img_str}"}

# --- Static Files ---

os.makedirs("downloads", exist_ok=True)

frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=19999)
