const express = require('express');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { get } = require('./config');
const { VideoDownloader } = require('./downloader');
const logger = require('./logger');

const app = express();
const PORT = get('server.port', 19999);
const DOWNLOAD_DIR = get('download.dir', 'downloads');
const AUTH_PASSWORD = get('auth.password', '') || process.env.AUTH_PASSWORD || '';
const RATE_LIMIT_MAX = get('security.rateLimitMax', 10);
const RATE_LIMIT_WINDOW = get('security.rateLimitWindow', 60);

// --- 中间件 ---
app.use(express.json());

// CORS
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = [
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`,
    ];
    const isLan = /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):\d+$/.test(origin || '');

    if (origin && (allowed.includes(origin) || isLan)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 速率限制
const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW * 1000,
    max: RATE_LIMIT_MAX,
    message: { error: '请求过于频繁，请稍后重试' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// 密码认证
app.use('/api/', (req, res, next) => {
    if (!AUTH_PASSWORD) return next();
    const auth = req.headers.authorization || '';
    if (auth === `Bearer ${AUTH_PASSWORD}`) return next();
    res.status(401).json({ error: '需要密码认证' });
});

// URL 验证
const ALLOWED_URL_PATTERNS = [
    /^https?:\/\/(www\.)?youtube\.com\//,
    /^https?:\/\/(m\.)?youtube\.com\//,
    /^https?:\/\/youtu\.be\//,
    /^https?:\/\/music\.youtube\.com\//,
];

function validateUrl(url) {
    if (!ALLOWED_URL_PATTERNS.some(p => p.test(url))) {
        throw { status: 400, message: '仅支持 YouTube 链接' };
    }
    return url;
}

// --- 下载器实例 ---
const downloader = new VideoDownloader(DOWNLOAD_DIR);

// --- API 路由 ---

app.get('/api/info', async (req, res) => {
    try {
        const { url, proxy } = req.query;
        validateUrl(url);
        logger.info(`获取视频信息: ${url}`);
        const info = await downloader.getInfo(url, proxy);
        res.json(info);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message || '服务器错误' });
    }
});

app.post('/api/download', (req, res) => {
    try {
        const { url, proxy, quality } = req.body;
        validateUrl(url);
        const taskId = downloader.startDownload(url, proxy, quality);
        logger.info(`创建下载任务: ${taskId} -> ${url} [${quality || '1080p'}]`);
        res.json({ task_id: taskId, status: 'started' });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message || '服务器错误' });
    }
});

app.post('/api/download/batch', (req, res) => {
    try {
        const { urls, proxy, quality } = req.body;
        if (!Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: '请提供 URL 列表' });
        }
        urls.forEach(validateUrl);
        const taskIds = urls.map(url => downloader.startDownload(url, proxy, quality));
        logger.info(`批量创建 ${taskIds.length} 个下载任务`);
        res.json({ task_ids: taskIds, status: 'started' });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message || '服务器错误' });
    }
});

app.get('/api/status/:taskId', (req, res) => {
    const status = downloader.getStatus(req.params.taskId);
    res.json(status);
});

app.get('/api/files', (req, res) => {
    res.json({ files: downloader.listFiles(), directory: downloader.downloadDir });
});

app.get('/api/open-folder', (req, res) => {
    const dir = downloader.downloadDir;
    if (process.platform === 'win32') {
        exec(`explorer "${dir}"`);
    } else if (process.platform === 'darwin') {
        exec(`open "${dir}"`);
    } else {
        exec(`xdg-open "${dir}"`);
    }
    res.json({ ok: true });
});

app.get('/api/qr', async (req, res) => {
    const interfaces = os.networkInterfaces();
    let ip = '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ip = iface.address;
                break;
            }
        }
    }
    const url = `http://${ip}:${PORT}`;
    try {
        const qrImage = await QRCode.toDataURL(url, { width: 200 });
        res.json({ ip, url, qr_image: qrImage });
    } catch (e) {
        res.status(500).json({ error: '生成二维码失败' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        active_tasks: downloader.activeTaskCount(),
        download_dir: downloader.downloadDir,
    });
});

// --- 静态文件 ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- 启动 ---
app.listen(PORT, '0.0.0.0', () => {
    logger.info(`服务启动 | 端口: ${PORT} | 下载目录: ${DOWNLOAD_DIR} | 认证: ${AUTH_PASSWORD ? '已启用' : '未启用'}`);
    console.log(`\n  YouTube 下载器已启动`);
    console.log(`  访问: http://localhost:${PORT}\n`);
});
