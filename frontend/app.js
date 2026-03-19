const API_BASE = 'http://localhost:19999/api';
const DEFAULT_PROXY = '127.0.0.1:7897';

// State
const downloads = {}; // task_id -> { status, title, filename }

// DOM Elements
const videoUrlInput = document.getElementById('videoUrl');
const downloadBtn = document.getElementById('downloadBtn');
const downloadListEl = document.getElementById('downloadList');
const emptyStateEl = document.getElementById('emptyState');
const toastEl = document.getElementById('toast');
const activeCountEl = document.getElementById('activeCount');
const enableNotifyBtn = document.getElementById('enableNotifyBtn');
const globalProgressTextEl = document.getElementById('globalProgressText');
const globalProgressFillEl = document.getElementById('globalProgressFill');
const globalProgressTrackEl = document.getElementById('globalProgressTrack');

let notificationsEnabled = false;
const notifiedTasks = new Set();

// --- Initialization ---
async function init() {
    setupNotificationControls();
    await loadHistory();
    startPolling();
    refreshGlobalProgress();
}

// --- Event Listeners ---
downloadBtn.addEventListener('click', async () => {
    const url = videoUrlInput.value.trim();
    const proxy = DEFAULT_PROXY;

    if (!url) {
        showToast('请输入视频链接');
        return;
    }

    try {
        downloadBtn.disabled = true;
        downloadBtn.textContent = '下载中...';

        const res = await fetch(`${API_BASE}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, proxy })
        });

        const data = await res.json();

        if (data.task_id) {
            showToast('任务已提交，正在下载');
            videoUrlInput.value = '';
            addDownloadItem(data.task_id, url);
            refreshActiveCount();
            refreshGlobalProgress();
        } else {
            showToast('任务提交失败');
        }
    } catch (err) {
        showToast('请求错误: ' + err.message);
    } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '开始下载';
    }
});

// --- Logic ---
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
            updateNotificationButton();
            return;
        }

        if (Notification.permission === 'denied') {
            notificationsEnabled = false;
            showToast('通知权限已被浏览器拒绝');
            updateNotificationButton();
            return;
        }

        const permission = await Notification.requestPermission();
        notificationsEnabled = permission === 'granted';
        showToast(notificationsEnabled ? '桌面通知已启用' : '未授予通知权限');
        updateNotificationButton();
    });
}

function updateNotificationButton() {
    if (!enableNotifyBtn || !('Notification' in window)) return;

    if (Notification.permission === 'granted' || notificationsEnabled) {
        notificationsEnabled = true;
        enableNotifyBtn.textContent = '通知已启用';
        enableNotifyBtn.disabled = true;
        return;
    }

    if (Notification.permission === 'denied') {
        enableNotifyBtn.textContent = '通知已拒绝';
        enableNotifyBtn.disabled = true;
        return;
    }

    enableNotifyBtn.textContent = '启用完成通知';
    enableNotifyBtn.disabled = false;
}

async function loadHistory() {
    try {
        const res = await fetch(`${API_BASE}/files`);
        const data = await res.json();

        downloadListEl.innerHTML = '';
        if (!data.files || data.files.length === 0) {
            downloadListEl.appendChild(emptyStateEl);
            refreshActiveCount();
            return;
        }

        data.files.forEach((file) => {
            const filename = typeof file === 'string' ? file : (file.name || '未知文件');
            const fileSize = typeof file === 'string' ? '--' : (file.size || '--');
            const item = createHistoryItem({
                title: filename,
                size: fileSize,
                filename
            });
            downloadListEl.appendChild(item);
        });

        refreshActiveCount();
    } catch (err) {
        console.error('Failed to load history', err);
    }
}

function addDownloadItem(taskId, url) {
    if (emptyStateEl.parentNode) {
        emptyStateEl.remove();
    }

    const itemEl = document.createElement('div');
    itemEl.className = 'history-item';
    itemEl.id = `task-${taskId}`;

    itemEl.innerHTML = `
        <div class="item-title" title="${escapeHtml(url)}">正在获取视频信息...</div>
        <div class="item-size">--</div>
        <div class="item-status">
            <div class="progress-bar-wrap">
                <div class="progress-bar-fill" style="width: 0%"></div>
            </div>
            <div class="status-text">准备中...</div>
        </div>
        <div class="item-actions">${renderActionButtons('', true)}</div>
    `;

    downloadListEl.insertBefore(itemEl, downloadListEl.firstChild);
    downloads[taskId] = { id: taskId, url, status: 'starting', percent: null };
}

function normalizeTaskStatus(rawStatus) {
    const value = String(rawStatus || '').toLowerCase();
    if (['completed', 'finished', 'done', 'success'].includes(value)) return 'completed';
    if (['error', 'failed', 'failure'].includes(value)) return 'error';
    return 'downloading'; // pending / started / downloading / processing / unknown
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
    const actionsEl = itemEl.querySelector('.item-actions');
    const prevStatus = downloads[taskId]?.status;
    const rawStatus = String(info.status || '').toLowerCase();
    const status = normalizeTaskStatus(rawStatus);

    if (info.title && titleEl.textContent === '正在获取视频信息...') {
        titleEl.textContent = info.title;
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
            downloads[taskId].percent = clamped;
        } else {
            progressWrap.classList.add('indeterminate');
            barFill.style.width = '35%';
            downloads[taskId].percent = null;
        }

        sizeEl.textContent = info.filesize || info._total_bytes_str || info._downloaded_bytes_str || '--';
        if (rawStatus === 'processing') {
            statusText.textContent = '合并处理中...';
        } else if (info._percent_str) {
            statusText.textContent = info._percent_str;
        } else if (hasPercent) {
            statusText.textContent = `${Math.round(percent)}%`;
        } else {
            statusText.textContent = '下载中...';
        }

        actionsEl.innerHTML = renderActionButtons('', true);
        downloads[taskId].status = status;
        return;
    }

    if (status === 'completed') {
        progressWrap.classList.remove('indeterminate');
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(90deg, #275935, #4f8e57)';
        sizeEl.textContent = info.filesize || info._total_bytes_str || sizeEl.textContent || '--';
        statusText.textContent = '下载完成';

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
        statusText.textContent = '下载失败';
        actionsEl.innerHTML = renderActionButtons('', true);
        downloads[taskId].percent = null;
        downloads[taskId].status = status;
    }
}

function startPolling() {
    setInterval(async () => {
        const activeTaskIds = Object.keys(downloads).filter((id) => {
            const task = downloads[id];
            return !isTerminalStatus(task.status);
        });

        refreshActiveCount();
        refreshGlobalProgress();
        if (activeTaskIds.length === 0) return;

        for (const taskId of activeTaskIds) {
            try {
                const res = await fetch(`${API_BASE}/status/${taskId}`);
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

function refreshActiveCount() {
    if (!activeCountEl) return;

    const activeCount = Object.values(downloads).filter((task) => !isTerminalStatus(task.status)).length;
    activeCountEl.textContent = `${activeCount} 个活动任务`;
}

function refreshGlobalProgress() {
    if (!globalProgressTextEl || !globalProgressFillEl || !globalProgressTrackEl) return;

    const activeTasks = Object.values(downloads).filter((task) => !isTerminalStatus(task.status));
    if (activeTasks.length === 0) {
        globalProgressTrackEl.classList.remove('indeterminate');
        globalProgressFillEl.style.width = '0%';
        globalProgressTextEl.textContent = '暂无活动下载';
        return;
    }

    const numericPercents = activeTasks
        .map((task) => task.percent)
        .filter((value) => Number.isFinite(value));

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

function notifyDownloadComplete(title, filename) {
    showToast(`下载完成: ${title}`);

    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') {
        return;
    }

    try {
        const notice = new Notification('下载完成', {
            body: `${title}`
        });

        notice.onclick = () => {
            window.focus();
            openFile(filename);
        };
    } catch (err) {
        console.warn('Notification failed', err);
    }
}

// Global handlers for inline onclick
window.openFile = async (filename) => {
    showToast('打开目录并定位文件: ' + filename);
    await fetch(`${API_BASE}/open-folder`);
};

window.openFolder = async () => {
    showToast('打开下载目录');
    await fetch(`${API_BASE}/open-folder`);
};

// --- Utilities ---
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
        </div>
        <div class="item-actions">${renderActionButtons(file.filename, false)}</div>
    `;
    return div;
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
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 2800);
}

init();
