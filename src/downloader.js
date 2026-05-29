const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

// 错误分类映射
const ERROR_MESSAGES = {
    'Video is private': '视频为私有，无法下载',
    'Sign in to confirm your age': '年龄限制视频，请在项目根目录放置 cookies.txt',
    'This video is not available': '视频不可用，可能已被删除',
    'Video unavailable': '视频不可用',
    'HTTP Error 403': '访问被拒绝，可能是地区限制或代理问题',
    'HTTP Error 404': '视频不存在或已被删除',
    'HTTP Error 429': '请求过于频繁，请稍后重试',
    'Network error': '网络连接失败，请检查代理设置',
    'Too Many Requests': '请求过于频繁，请稍后重试',
    'urlopen error': '网络连接失败，请检查网络或代理',
    'SSL': 'SSL 证书错误，请检查网络环境',
    'timeout': '连接超时，请检查网络',
    'Proxy': '代理连接失败，请检查代理设置',
    'ERROR: Sign in': '需要登录，请提供 cookies.txt',
    'This live event will begin': '直播尚未开始',
    'This video is only available': '该视频有地区限制',
};

// 画质格式映射
const QUALITY_FORMATS = {
    '1080p': 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba[ext=m4a]/bv*+ba/b',
    '720p': 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba[ext=m4a]/bv*+ba/b',
    '480p': 'bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=480]+ba[ext=m4a]/bv*+ba/b',
    'audio': 'ba[ext=m4a]/ba/b',
};

const DOWNLOAD_TIMEOUT = 5 * 60 * 1000; // 5 分钟

function classifyError(msg) {
    const lower = msg.toLowerCase();
    for (const [keyword, friendly] of Object.entries(ERROR_MESSAGES)) {
        if (lower.includes(keyword.toLowerCase())) {
            return friendly;
        }
    }
    return msg.length > 200 ? `下载失败：${msg.substring(0, 200)}...` : `下载失败：${msg}`;
}

function sanitizeFilename(name) {
    return name
        .replace(/\.\./g, '')
        .replace(/[/\\]/g, '')
        .replace(/[<>:"|?*]/g, '')
        .substring(0, 200)
        .trim() || 'video';
}

class DownloadTask {
    constructor(taskId, url, quality = '1080p') {
        this.taskId = taskId;
        this.url = url;
        this.quality = quality;
        this.status = 'pending'; // pending / downloading / processing / completed / error
        this.progress = 0;
        this.filename = '';
        this.error = '';
        this.title = '';
        this.speed = '';
        this.eta = '';
        this.filesize = '';
        this.lastProgressTime = Date.now();
        this._timeoutTimer = null;
    }
}

class VideoDownloader {
    constructor(downloadDir = 'downloads') {
        this.downloadDir = path.resolve(downloadDir);
        if (!fs.existsSync(this.downloadDir)) {
            fs.mkdirSync(this.downloadDir, { recursive: true });
        }
        this.tasks = new Map();
        this.ytdlpPath = this._findYtdlp();
        this._cleanupPartialFiles();
        logger.info(`yt-dlp 路径: ${this.ytdlpPath}`);
        logger.info(`下载目录: ${this.downloadDir}`);
    }

    _findYtdlp() {
        // 优先使用 bin/ 目录下的二进制
        const binDir = path.join(__dirname, '..', 'bin');
        const isWin = process.platform === 'win32';
        const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp';

        const localPath = path.join(binDir, binaryName);
        if (fs.existsSync(localPath)) return localPath;

        // 回退到系统 PATH
        return binaryName;
    }

    _cleanupPartialFiles() {
        const patterns = ['.f*.mp4', '.f*.m4a', '.f*.webm', '.ytdl', '.part'];
        try {
            const files = fs.readdirSync(this.downloadDir);
            for (const file of files) {
                if (patterns.some(p => file.includes(p.replace('*', ''))) ||
                    file.endsWith('.ytdl') || file.endsWith('.part')) {
                    try {
                        fs.unlinkSync(path.join(this.downloadDir, file));
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    }

    getInfo(url, proxy) {
        return new Promise((resolve) => {
            const args = [
                '--dump-json', '--no-download', '--no-warnings',
                '--no-check-certificates',
            ];
            if (proxy) args.push('--proxy', proxy);
            args.push(url);

            const proc = spawn(this.ytdlpPath, args, { timeout: 30000 });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d) => stdout += d);
            proc.stderr.on('data', (d) => stderr += d);

            proc.on('close', (code) => {
                if (code === 0) {
                    try {
                        const info = JSON.parse(stdout);
                        resolve({
                            title: info.title || '未知',
                            duration: info.duration || 0,
                            thumbnail: info.thumbnail || '',
                            uploader: info.uploader || '未知',
                            view_count: info.view_count || 0,
                        });
                    } catch (e) {
                        resolve({ error: '解析视频信息失败' });
                    }
                } else {
                    resolve({ error: classifyError(stderr || '获取视频信息失败') });
                }
            });

            proc.on('error', (e) => {
                resolve({ error: classifyError(e.message) });
            });
        });
    }

    startDownload(url, proxy, quality = '1080p') {
        const taskId = crypto.randomBytes(4).toString('hex');
        const task = new DownloadTask(taskId, url, quality);
        this.tasks.set(taskId, task);

        this._downloadWorker(task, proxy);
        return taskId;
    }

    getStatus(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return { error: '任务不存在' };
        return {
            task_id: task.taskId,
            status: task.status,
            progress: Math.round(task.progress * 10) / 10,
            filename: task.filename,
            title: task.title,
            speed: task.speed,
            eta: task.eta,
            error: task.error,
            filesize: task.filesize,
            quality: task.quality,
        };
    }

    listFiles() {
        try {
            const files = fs.readdirSync(this.downloadDir)
                .filter(f => {
                    if (!f.endsWith('.mp4') && !f.endsWith('.webm') && !f.endsWith('.m4a')) return false;
                    if (/\.f\d+\.\w+$/.test(f)) return false;
                    return true;
                })
                .map(f => {
                    const filepath = path.join(this.downloadDir, f);
                    const stats = fs.statSync(filepath);
                    const sizeBytes = stats.size;
                    let size;
                    if (sizeBytes < 1024) size = `${sizeBytes} B`;
                    else if (sizeBytes < 1024 * 1024) size = `${(sizeBytes / 1024).toFixed(1)} KB`;
                    else size = `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
                    return { name: f, size, size_bytes: sizeBytes };
                })
                .sort((a, b) => b.size_bytes - a.size_bytes);
            return files;
        } catch (e) {
            return [];
        }
    }

    activeTaskCount() {
        let count = 0;
        for (const task of this.tasks.values()) {
            if (['pending', 'downloading', 'processing'].includes(task.status)) count++;
        }
        return count;
    }

    _downloadWorker(task, proxy) {
        const fmt = QUALITY_FORMATS[task.quality] || QUALITY_FORMATS['1080p'];
        const cookiesPath = path.join(path.dirname(this.downloadDir), 'cookies.txt');
        const hasCookies = fs.existsSync(cookiesPath);

        const args = [
            '--newline', '--no-warnings',
            '--merge-output-format', 'mp4',
            '-f', fmt,
            '--format-sort', 'vcodec:h264,res,ext:mp4:m4a',
            '-o', path.join(this.downloadDir, '%(title)s.%(ext)s'),
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '--no-part', '--retries', '30', '--fragment-retries', '30',
            '--retry-sleep', 'linear=1::2', '--no-check-certificates',
            '--socket-timeout', '30', '--extractor-retries', '5',
            '--file-access-retries', '5', '--continue',
        ];

        if (hasCookies) args.push('--cookies', cookiesPath);
        if (proxy) args.push('--proxy', proxy);
        args.push(task.url);

        task.status = 'downloading';
        task.lastProgressTime = Date.now();

        // 超时检测
        task._timeoutTimer = setInterval(() => {
            if (Date.now() - task.lastProgressTime > DOWNLOAD_TIMEOUT) {
                task.status = 'error';
                task.error = '下载超时，可能是网络问题，请检查代理设置后重试';
                clearInterval(task._timeoutTimer);
                proc.kill();
            }
        }, 10000);

        logger.info(`开始下载: ${task.taskId} -> ${task.url} [${task.quality}]`);

        const proc = spawn(this.ytdlpPath, args);
        let buffer = '';

        proc.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行
            for (const line of lines) {
                if (line.trim()) this._parseProgress(task, line.trim());
            }
        });

        proc.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (line) this._parseProgress(task, line);
        });

        proc.on('close', (code) => {
            clearInterval(task._timeoutTimer);
            // 处理剩余 buffer
            if (buffer.trim()) this._parseProgress(task, buffer.trim());

            if (code === 0) {
                task.status = 'completed';
                task.progress = 100;
                this._findDownloadedFile(task);
                logger.info(`下载完成: ${task.taskId} -> ${task.filename}`);
            } else {
                task.status = 'error';
                if (!task.error) {
                    task.error = classifyError(`yt-dlp 返回错误码: ${code}`);
                }
                logger.error(`下载失败: ${task.taskId} -> ${task.error}`);
            }
        });

        proc.on('error', (e) => {
            clearInterval(task._timeoutTimer);
            task.status = 'error';
            task.error = classifyError(e.message);
            logger.error(`下载异常: ${task.taskId} -> ${e.message}`);
        });
    }

    _parseProgress(task, line) {
        // [download] 45.2% of 120.50MiB at 2.30MiB/s ETA 00:30
        let match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/);
        if (match) {
            task.progress = parseFloat(match[1]);
            task.filesize = match[2];
            task.speed = match[3];
            task.eta = match[4];
            task.status = 'downloading';
            task.lastProgressTime = Date.now();
            return;
        }

        // [download] 100% of 120.50MiB
        match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*(\S+)/);
        if (match) {
            task.progress = parseFloat(match[1]);
            task.filesize = match[2];
            task.lastProgressTime = Date.now();
            return;
        }

        // [download] Destination: filename.mp4
        match = line.match(/\[download\] Destination:\s+(.+)/);
        if (match) {
            task.filename = sanitizeFilename(path.basename(match[1]));
            return;
        }

        // [Merger] Merging formats...
        if (line.includes('[Merger]') || line.includes('Merging')) {
            task.status = 'processing';
            task.progress = 99;
            task.lastProgressTime = Date.now();
            return;
        }

        // already been downloaded
        match = line.match(/\[download\]\s+(.+)\s+has already been downloaded/);
        if (match) {
            task.filename = sanitizeFilename(path.basename(match[1]));
            task.status = 'completed';
            task.progress = 100;
            return;
        }

        // ERROR
        if (line.includes('ERROR')) {
            task.error = classifyError(line);
        }
    }

    _findDownloadedFile(task) {
        if (task.filename && !/\.f\d+\.\w+$/.test(task.filename)) return;
        try {
            const files = fs.readdirSync(this.downloadDir)
                .filter(f => f.endsWith('.mp4') && !/\.f\d+\.mp4$/.test(f));
            if (files.length > 0) {
                files.sort((a, b) => {
                    const sa = fs.statSync(path.join(this.downloadDir, a));
                    const sb = fs.statSync(path.join(this.downloadDir, b));
                    return sb.mtimeMs - sa.mtimeMs;
                });
                task.filename = files[0];
            }
        } catch (e) { /* ignore */ }
    }
}

module.exports = { VideoDownloader };
