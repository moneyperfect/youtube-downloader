# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

YouTube 视频下载器 — 本地 Web 应用，用于下载 YouTube 视频。UI 采用文艺复兴羊皮纸风格（"Studio Aureo"）。用户粘贴链接，后端通过 `yt-dlp` 二进制下载，前端轮询获取实时进度。支持批量下载、画质选择、密码认证。

**技术栈**：Node.js (Express) + yt-dlp 二进制 + 原生前端

## 启动方式

```bash
# 安装依赖
npm install

# 启动服务
npm start
# → 访问 http://localhost:19999

# 开发模式（自动重启）
npm run dev

# 打包为单个 exe
npm run build

# 可选：设置密码保护
AUTH_PASSWORD=your_password npm start

# 或使用 Windows 批处理启动
启动下载器.bat
```

## 架构

```
src/
  server.js      — Express 服务器：API 路由、安全中间件、静态文件托管
  downloader.js  — VideoDownloader 类：通过 child_process 调用 yt-dlp 二进制
  config.js      — 配置加载器：从 config.json 读取，支持环境变量覆盖
  logger.js      — 日志系统：控制台 + 文件轮转（10MB×5）

public/
  index.html     — 单页 UI（文艺复兴羊皮纸主题）
  style.css      — 全部样式（暖金/棕色配色，Cinzel Decorative + Noto Serif SC 字体）
  app.js         — 原生 JS：1 秒轮询、进度解析、批量下载、搜索过滤、设置持久化

config.json      — 配置文件（端口、代理、下载目录、安全参数）
bin/             — yt-dlp 二进制文件目录（可选，回退到系统 PATH）
logs/            — 日志目录（downloader.log，自动轮转）
```

### 关键设计决策

- **yt-dlp 二进制调用** — 通过 `child_process.spawn` 调用 yt-dlp 可执行文件。优先使用 `bin/` 目录下的本地二进制，回退到系统 PATH。
- **无数据库** — 下载任务存储在内存 Map 中（重启丢失）。已下载文件持久保存在 `downloads/`。
- **前端轮询** — `app.js` 每 1 秒轮询 `GET /api/status/:taskId`。未使用 WebSocket。
- **代理配置** — 默认代理从 `config.json` 读取，前端可在设置面板修改并保存到 localStorage。
- **Cookies** — 若项目根目录存在 `cookies.txt`，yt-dlp 会自动使用。
- **错误分类** — `classifyError()` 将 yt-dlp 错误映射为友好中文提示。
- **超时检测** — 定时器监控下载进度，5 分钟无变化自动标记为失败。
- **安全性** — URL 验证（仅 YouTube）、CORS 收紧、express-rate-limit 速率限制、可选密码认证。
- **日志系统** — 自实现 logger，输出到控制台 + `logs/downloader.log`（10MB 轮转，5 个备份）。

### 打包分发

```bash
npm run build
# 输出 dist/yt-downloader.exe（单文件，包含 Node.js 运行时 + 所有代码）
```

打包后用户无需安装 Node.js，直接运行 exe 即可。

### API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/info?url=&proxy=` | 获取视频元数据 |
| `POST` | `/api/download` | 启动下载 `{url, proxy?, quality?}` |
| `POST` | `/api/download/batch` | 批量下载 `{urls[], proxy?, quality?}` |
| `GET` | `/api/status/:taskId` | 轮询下载进度（含 speed、eta） |
| `GET` | `/api/files` | 列出已下载文件 |
| `GET` | `/api/open-folder` | 打开下载目录 |
| `GET` | `/api/qr` | 生成局域网访问二维码 |
| `GET` | `/api/health` | 健康检查 |

### 画质选项

`quality` 参数：`1080p`（默认）、`720p`、`480p`、`audio`。映射在 `downloader.js` 的 `QUALITY_FORMATS` 中定义。

## UI 设计语言

暖色羊皮纸/文艺复兴美学。`style.css` 中 `:root` 的关键 CSS 变量：
- 背景：深棕色（`#1d1410`）配合暖色径向渐变
- 文字：墨棕色（`#2a1c13`）
- 强调色：酒红色（`#6f1c1f` / `#91232a`）用于主按钮
- 金色（`#c5a25f`）用于装饰元素
- 字体：Cinzel Decorative（标题）、Noto Serif SC（中文正文）、Cormorant Garamond（英文正文）

修改 UI 时，保持暖色/有机质感。禁用纯黑和纯白。

## 修改验证流程

修改后执行以下黑盒验证：
1. `npm start` → 终端显示 "YouTube 下载器已启动"，无报错
2. 浏览器访问 `http://localhost:19999` → 页面正常渲染
3. 粘贴一个 YouTube 链接 → 视频元数据正确显示
4. 点击下载 → 进度条实时更新 → 下载完成
5. 批量粘贴多个链接 → 多个任务同时开始
6. 故意输入非 YouTube 链接 → 返回 400 错误
7. 访问 `/api/health` → 返回系统状态 JSON
