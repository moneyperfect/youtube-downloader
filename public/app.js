const API_BASE = '/api';

// --- 设置管理 ---
function loadSettings() {
    const saved = localStorage.getItem('ytDownloaderSettings');
    if (saved) {
        try { return JSON.parse(saved); } catch (e) { /* ignore */ }
    }
    return { proxy: '127.0.0.1:7897', concurrent: 3 };
}

function saveSettings(settings) {
    localStorage.setItem('ytDownloaderSettings', JSON.stringify(settings));
}

const settings = loadSettings();

// --- 状态 ---
const downloads = {}; // task_id -> { status, title, filename, percent, speed, eta, quality }
let authPassword = sessionStorage.getItem('authPassword') || '';

// --- DOM ---
const videoUrlInput = document.getElementById('videoUrl');
const downloadBtn = document.getElementById('downloadBtn');
const qualitySelect = document.getElementById('qualitySelect');
const downloadListEl = document.getElementById('downloadList');
const emptyStateEl = document.getElementById('emptyState');
const toastEl = document.getElementById('toast');
const activeCountEl = document.getElementById('activeCount');
const enableNotifyBtn = document.getElementById('enableNotifyBtn');
const globalProgressTextEl = document.getElementById('globalProgressText');
const globalProgressFillEl = document.getElementById('globalProgressFill');
const globalProgressTrackEl = document.getElementById('globalProgressTrack');
const searchInput = document.getElementById('searchInput');
const settingProxy = document.getElementById('settingProxy');
const settingConcurrent = document.getElementById('settingConcurrent');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const authOverlay = document.getElementById('authOverlay');
const authPasswordInput = document.getElementById('authPassword');
const authSubmitBtn = document.getElementById('authSubmitBtn');

let notificationsEnabled = false;
const notifiedTasks = new Set();

// --- 初始化 ---
async function init() {
    setupNotificationControls();
    setupSettings();
    setupSearch();
    setupAuth();
    await loadHistory();
    startPolling();
    refreshGlobalProgress();
}

// --- API 请求封装 ---
async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (authPassword) {
        headers['Authorization'] = `Bearer ${authPassword}`;
    }
    if (options.body && typeof options.body === 'object') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    options.headers = headers;

    const res = await fetch(url, options);
    if (res.status === 401) {
        showAuthDialog();
        throw new Error('需要密码认证');
    }
    if (res.status === 429) {
        throw new Error('请求过于频繁，请稍后重试');
    }
    return res;
}

// --- 密码认证 ---
function setupAuth() {
    if (!authSubmitBtn) return;
    authSubmitBtn.addEventListener('click', () => {
        authPassword = authPasswordInput.value.trim();
        if (authPassword) {
            sessionStorage.setItem('authPassword', authPassword);
            authOverlay.style.display = 'none';
            showToast('认证成功');
        }
    });
    authPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') authSubmitBtn.click();
    });
}

function showAuthDialog() {
    if (authOverlay) authOverlay.style.display = 'flex';
}

// --- 设置 ---
function setupSettings() {
    if (!settingProxy || !settingConcurrent) return;
    settingProxy.value = settings.proxy || '';
    settingConcurrent.value = String(settings.concurrent || 3);

    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', () => {
            settings.proxy = settingProxy.value.trim();
            settings.concurrent = parseInt(settingConcurrent.value, 10) || 3;
            saveSettings(settings);
            showToast('设置已保存');
        });
    }
}

// --- 搜索 ---
function setupSearch() {
    if (!searchInput) return;
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        const items = downloadListEl.querySelectorAll('.history-item');
        items.forEach(item => {
            const title = item.querySelector('.item-title')?.textContent?.toLowerCase() || '';
            item.style.display = (!query || title.includes(query)) ? '' : 'none';
        });
    });
}

// --- 下载按钮 ---
downloadBtn.addEventListener('click', async () => {
    const raw = videoUrlInput.value.trim();
    if (!raw) {
        showToast('请输入视频链接');
        return;
    }

    const urls = raw.split('\n').map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length === 0) {
        showToast('请输入有效的视频链接');
        return;
    }

    // 验证 URL 格式
    const youtubePattern = /^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/|^https?:\/\/youtu\.be\//;
    const invalid = urls.filter(u => !youtubePattern.test(u));
    if (invalid.length > 0) {
        showToast(`以下链接不是 YouTube 链接：${invalid[0].substring(0, 50)}...`);
        return;
    }

    const quality = qualitySelect.value;
    const proxy = settings.proxy || '';

    try {
        downloadBtn.disabled = true;
        downloadBtn.textContent = '提交中...';

        if (urls.length === 1) {
            // 单个下载
            const res = await apiFetch(`${API_BASE}/download`, {
                method: 'POST',
                body: { url: urls[0], proxy, quality }
            });
            const data = await res.json();
            if (data.task_id) {
                showToast('任务已提交，正在下载');
                videoUrlInput.value = '';
                addDownloadItem(data.task_id, urls[0], quality);
            } else {
                showToast('任务提交失败');
            }
        } else {
            // 批量下载
            const res = await apiFetch(`${API_BASE}/download/batch`, {
                method: 'POST',
                body: { urls, proxy, quality }
            });
            const data = await res.json();
            if (data.task_ids && data.task_ids.length > 0) {
                showToast(`已提交 ${data.task_ids.length} 个下载任务`);
                videoUrlInput.value = '';
                data.task_ids.forEach((tid, i) => addDownloadItem(tid, urls[i], quality));
            } else {
                showToast('批量任务提交失败');
            }
        }
    } catch (err) {
        showToast('请求错误: ' + err.message);
    } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '开始下载';
    }

    refreshActiveCount();
    refreshGlobalProgress();
});

// --- 通知控制 ---
function setupNotificationControls() {
    if (!enableNotifyBtn) return;
    if (!('Notification' in window)) {
        enableNotifyBtn.textContent = '浏览器不支持通知';
        enableNotifyBtn.disabled = true;
        return;
    }
    updateNotificationButton();
    enableNotifyBtn.addEventListener('click', async () => {
        if (Notification.permission === 'granted') {
            notificationsEnabled = true;
            showToast('桌面通知已启用');
        } else if (Notification.permission === 'denied') {
            showToast('通知权限已被浏览器拒绝');
        } else {
            const permission = await Notification.requestPermission();
            notificationsEnabled = permission === 'granted';
            showToast(notificationsEnabled ? '桌面通知已启用' : '未授予通知权限');
        }
        updateNotificationButton();
    });
}

function updateNotificationButton() {
    if (!enableNotifyBtn || !('Notification' in window)) return;
    if (Notification.permission === 'granted' || notificationsEnabled) {
        notificationsEnabled = true;
        enableNotifyBtn.textContent = '通知已启用';
        enableNotifyBtn.disabled = true;
    } else if (Notification.permission === 'denied') {
        enableNotifyBtn.textContent = '通知已拒绝';
        enableNotifyBtn.disabled = true;
    } else {
        enableNotifyBtn.textContent = '启用完成通知';
        enableNotifyBtn.disabled = false;
    }
}

// --- 历史记录 ---
async function loadHistory() {
    try {
        const res = await apiFetch(`${API_BASE}/files`);
        const data = await res.json();
        downloadListEl.innerHTML = '';
        if (!data.files || data.files.length === 0) {
            downloadListEl.appendChild(emptyStateEl);
            refreshActiveCount();
            return;
        }
        data.files.forEach(file => {
            const filename = typeof file === 'string' ? file : (file.name || '未知文件');
            const fileSize = typeof file === 'string' ? '--' : (file.size || '--');
            downloadListEl.appendChild(createHistoryItem({ title: filename, size: fileSize, filename }));
        });
        refreshActiveCount();
    } catch (err) {
        console.error('Failed to load history', err);
    }
}

// --- 下载项管理 ---
function addDownloadItem(taskId, url, quality) {
    if (emptyStateEl.parentNode) emptyStateEl.remove();

    const itemEl = document.createElement('div');
    itemEl.className = 'history-item';
    itemEl.id = `task-${taskId}`;

    const qualityLabel = quality ? `<span class="quality-badge">${quality}</span>` : '';

    itemEl.innerHTML = `
        <div class="item-title" title="${escapeHtml(url)}">正在获取视频信息...${qualityLabel}</div>
        <div class="item-size">--</div>
        <div class="item-status">
            <div class="progress-bar-wrap">
                <div class="progress-bar-fill" style="width: 0%"></div>
            </div>
            <div class="status-text">准备中...</div>
            <div class="speed-info"></div>
        </div>
        <div class="item-actions">${renderActionButtons('', true)}</div>
    `;

    downloadListEl.insertBefore(itemEl, downloadListEl.firstChild);
    downloads[taskId] = { id: taskId, url, status: 'starting', percent: null, quality };
}

function normalizeTaskStatus(rawStatus) {
    const value = String(rawStatus || '').toLowerCase();
    if (['completed', 'finished', 'done', 'success'].includes(value)) return 'completed';
    if (['error', 'failed', 'failure'].includes(value)) return 'error';
    return 'downloading';
}

function isTerminalStatus(status) {
    return status === 'completed' || status === 'error';
}

function updateDownloadItem(taskId, info) {
    const itemEl = document.getElementById(`task-${taskId}`);
    if (!itemEl) return;

    const titleEl = itemEl.querySelector('.item-title');
    const sizeEl = itemEl.querySelector('.item-size');
    const progressWrap = itemEl.querySelector('.progress-bar-wrap');
    const barFill = itemEl.querySelector('.progress-bar-fill');
    const statusText = itemEl.querySelector('.status-text');
    const speedInfo = itemEl.querySelector('.speed-info');
    const actionsEl = itemEl.querySelector('.item-actions');
    const prevStatus = downloads[taskId]?.status;
    const rawStatus = String(info.status || '').toLowerCase();
    const status = normalizeTaskStatus(rawStatus);

    // 更新标题
    if (info.title && titleEl.textContent.includes('正在获取视频信息...')) {
        const qualityBadge = titleEl.querySelector('.quality-badge');
        const qualityHtml = qualityBadge ? qualityBadge.outerHTML : '';
        titleEl.innerHTML = escapeHtml(info.title) + qualityHtml;
        titleEl.title = info.title;
    }

    if (status === 'downloading') {
        let percent = 0;
        let hasPercent = false;

        if (Number.isFinite(info.progress)) {
            percent = Number(info.progress);
            hasPercent = Number.isFinite(percent);
        } else if (info._percent_str) {
            percent = parseFloat(String(info._percent_str).replace('%', ''));
            hasPercent = Number.isFinite(percent);
        }

        if (hasPercent) {
            const clamped = Math.max(0, Math.min(100, percent));
            progressWrap.classList.remove('indeterminate');
            barFill.style.width = `${clamped}%`;
            barFill.style.background = '';
            downloads[taskId].percent = clamped;
        } else {
            progressWrap.classList.add('indeterminate');
            barFill.style.width = '35%';
            downloads[taskId].percent = null;
        }

        sizeEl.textContent = info.filesize || '--';

        // 速度和 ETA 显示
        const speed = info.speed || '';
        const eta = info.eta || '';
        if (rawStatus === 'processing') {
            statusText.textContent = '合并处理中...';
            speedInfo.textContent = '';
        } else if (hasPercent) {
            statusText.textContent = `${Math.round(percent)}%`;
            const parts = [];
            if (speed) parts.push(speed);
            if (eta && eta !== 'Unknown') parts.push(`剩余 ${eta}`);
            speedInfo.textContent = parts.join(' · ');
        } else {
            statusText.textContent = '下载中...';
            speedInfo.textContent = speed || '';
        }

        actionsEl.innerHTML = renderActionButtons('', true);
        downloads[taskId].status = status;
        return;
    }

    if (status === 'completed') {
        progressWrap.classList.remove('indeterminate');
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(90deg, #275935, #4f8e57)';
        sizeEl.textContent = info.filesize || sizeEl.textContent || '--';
        statusText.textContent = '下载完成';
        speedInfo.textContent = '';

        const filename = info.filename || downloads[taskId]?.filename || info.title || 'video';
        actionsEl.innerHTML = renderActionButtons(filename, false);
        downloads[taskId].filename = filename;
        downloads[taskId].percent = 100;
        downloads[taskId].status = status;

        if (prevStatus !== 'completed' && !notifiedTasks.has(taskId)) {
            const displayTitle = info.title || titleEl.textContent || filename;
            notifyDownloadComplete(displayTitle, filename);
            notifiedTasks.add(taskId);
        }
        return;
    }

    if (status === 'error') {
        progressWrap.classList.remove('indeterminate');
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(90deg, #8a1f1f, #c44f43)';
        statusText.textContent = info.error || '下载失败';
        speedInfo.textContent = '';
        actionsEl.innerHTML = renderRetryButton(taskId);
        downloads[taskId].percent = null;
        downloads[taskId].status = status;
    }
}

// --- 轮询 ---
function startPolling() {
    setInterval(async () => {
        const activeTaskIds = Object.keys(downloads).filter(id => !isTerminalStatus(downloads[id].status));
        refreshActiveCount();
        refreshGlobalProgress();
        if (activeTaskIds.length === 0) return;

        for (const taskId of activeTaskIds) {
            try {
                const res = await apiFetch(`${API_BASE}/status/${taskId}`);
                const data = await res.json();
                if (data && data.status) {
                    if (data.filename) downloads[taskId].filename = data.filename;
                    updateDownloadItem(taskId, data);
                }
            } catch (err) {
                console.warn('Poll error', err);
            }
        }
        refreshActiveCount();
        refreshGlobalProgress();
    }, 1000);
}

// --- 进度统计 ---
function refreshActiveCount() {
    if (!activeCountEl) return;
    const activeCount = Object.values(downloads).filter(t => !isTerminalStatus(t.status)).length;
    activeCountEl.textContent = `${activeCount} 个活动任务`;
}

function refreshGlobalProgress() {
    if (!globalProgressTextEl || !globalProgressFillEl || !globalProgressTrackEl) return;
    const activeTasks = Object.values(downloads).filter(t => !isTerminalStatus(t.status));
    if (activeTasks.length === 0) {
        globalProgressTrackEl.classList.remove('indeterminate');
        globalProgressFillEl.style.width = '0%';
        globalProgressTextEl.textContent = '暂无活动下载';
        return;
    }
    const numericPercents = activeTasks.map(t => t.percent).filter(v => Number.isFinite(v));
    if (numericPercents.length === 0) {
        globalProgressTrackEl.classList.add('indeterminate');
        globalProgressFillEl.style.width = '35%';
        globalProgressTextEl.textContent = `进行中 ${activeTasks.length} 项 · 正在连接...`;
        return;
    }
    const avg = Math.round(numericPercents.reduce((a, b) => a + b, 0) / numericPercents.length);
    globalProgressTrackEl.classList.remove('indeterminate');
    globalProgressFillEl.style.width = `${avg}%`;
    globalProgressTextEl.textContent = `进行中 ${activeTasks.length} 项 · 平均 ${avg}%`;
}

// --- 通知 ---
function notifyDownloadComplete(title, filename) {
    showToast(`下载完成: ${title}`);
    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
        const notice = new Notification('下载完成', { body: title });
        notice.onclick = () => { window.focus(); openFile(filename); };
    } catch (err) {
        console.warn('Notification failed', err);
    }
}

// --- 全局操作 ---
window.openFile = async (filename) => {
    showToast('打开目录并定位文件: ' + filename);
    await apiFetch(`${API_BASE}/open-folder`);
};

window.openFolder = async () => {
    showToast('打开下载目录');
    await apiFetch(`${API_BASE}/open-folder`);
};

window.retryDownload = (taskId) => {
    const task = downloads[taskId];
    if (!task || !task.url) return;
    // 重新提交
    const proxy = settings.proxy || '';
    const quality = task.quality || '1080p';
    apiFetch(`${API_BASE}/download`, {
        method: 'POST',
        body: { url: task.url, proxy, quality }
    }).then(res => res.json()).then(data => {
        if (data.task_id) {
            showToast('已重新提交下载任务');
            // 移除旧的失败项
            const oldEl = document.getElementById(`task-${taskId}`);
            if (oldEl) oldEl.remove();
            delete downloads[taskId];
            addDownloadItem(data.task_id, task.url, quality);
        }
    }).catch(err => showToast('重试失败: ' + err.message));
};

// --- 工具函数 ---
function createHistoryItem(file) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
        <div class="item-title" title="${escapeHtml(file.title)}">${escapeHtml(file.title)}</div>
        <div class="item-size">${escapeHtml(file.size)}</div>
        <div class="item-status">
            <div class="progress-bar-wrap">
                <div class="progress-bar-fill" style="width:100%;background:linear-gradient(90deg, #275935, #4f8e57)"></div>
            </div>
            <div class="status-text">下载完成</div>
            <div class="speed-info"></div>
        </div>
        <div class="item-actions">${renderActionButtons(file.filename, false, false)}</div>
    `;
    return div;
}

function renderRetryButton(taskId) {
    return `<button class="action-btn btn-retry" onclick="retryDownload('${taskId}')" title="重试">重试</button>`;
}

function renderActionButtons(filename, disabled) {
    if (disabled) {
        return `
            <button class="action-btn btn-play" disabled title="播放">播放</button>
            <button class="action-btn btn-folder" disabled title="打开文件夹">文件夹</button>
        `;
    }
    return `
        <button class="action-btn btn-play" onclick="openFile('${escapeJsString(filename)}')" title="播放">播放</button>
        <button class="action-btn btn-folder" onclick="openFolder()" title="打开文件夹">文件夹</button>
    `;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeJsString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2800);
}

init();
