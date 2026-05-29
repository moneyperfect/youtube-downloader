const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOG_DIR, 'downloader.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

function rotateIfNeeded() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;
        const stats = fs.statSync(LOG_FILE);
        if (stats.size < MAX_SIZE) return;

        // 删除最旧的备份
        const oldest = path.join(LOG_DIR, `downloader.${MAX_FILES}.log`);
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

        // 轮转现有备份
        for (let i = MAX_FILES - 1; i >= 1; i--) {
            const src = path.join(LOG_DIR, `downloader.${i}.log`);
            const dst = path.join(LOG_DIR, `downloader.${i + 1}.log`);
            if (fs.existsSync(src)) fs.renameSync(src, dst);
        }

        // 当前日志变为 .1
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'downloader.1.log'));
    } catch (e) {
        // 忽略轮转错误
    }
}

function formatMessage(level, msg) {
    const now = new Date().toISOString();
    return `${now} [${level}] ${msg}`;
}

function write(level, msg) {
    const formatted = formatMessage(level, msg);
    console.log(formatted);

    rotateIfNeeded();
    try {
        fs.appendFileSync(LOG_FILE, formatted + '\n', 'utf-8');
    } catch (e) {
        // 忽略写入错误
    }
}

module.exports = {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    debug: (msg) => write('DEBUG', msg),
};
