# SoulWeave 官网

纯静态多页站点。无构建工具、无 CDN、无第三方统计，可直接部署到 Cloudflare Pages 或 GitHub Pages。

## 本地预览

在仓库根目录运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory site
```

打开 `http://127.0.0.1:4173/`。

## 页面

```text
index.html            品牌首页、多角色定位、能力、真实界面、Local First
features.html         能力与边界
download.html         发布状态、系统要求、安装流程、校验与安全
releases.html         规划基线、开发候选、里程碑与版本冲突处理
announcements.html    公告中心
about.html            项目状态、路线图、许可与反馈
privacy.html          官网与桌面端隐私边界
404.html              404
docs/*.html           安装、首启、QQ、API、权限、排障与 FAQ
assets/style.css      全站唯一设计系统
assets/app.js         渐进增强：菜单、目录、复制、公告、版本与图片预览
assets/brand/         唯一品牌横幅
assets/screens2x/     现有真实产品截图
data/                 公告与版本元数据
scripts/              静态检查和浏览器验收脚本
```

## 设计约束

- 全站只加载 `assets/style.css`。`site.css` 只保留兼容导入，避免旧链接失效。
- 视觉使用冰蓝、海军蓝、浅蓝灰与白；橙金只作为局部提醒强调。
- 不伪造截图、不生成新的角色形象、不把规划功能包装成已交付功能。
- 所有动画遵守 `prefers-reduced-motion`；无 JavaScript 时正文和导航仍可阅读。
- 官网不加载第三方字体、脚本、分析或 Cookie。

## 版本事实

- `V1.7` 是需求与阶段规划基线，不是安装包版本。
- `0.1.0-s1` 是应用 `package.json` 和站点 `data/latest.json` 记录的产品开发候选。
- `0.1.0-s0` 是开发里程碑。
- 当前状态为“尚未公开发布”；没有有效公开 Release 时不展示直接下载链接。

## 验收

启动本地服务器后运行：

```powershell
cd site
node scripts/check-site.mjs
node scripts/browser-check.mjs
```

浏览器检查默认使用 Edge，覆盖 1920×1080、1440×900、1366×768、768×1024、390×844、360×800，并检查横向溢出、图片失败、控制台错误、移动导航、文档目录和图片预览。可通过 `EDGE_PATH`、`SITE_URL`、`SCREENSHOT_DIR` 覆盖环境。

官网发布前在应用仓库运行：

```powershell
npm run gate:site:abs
```

## 维护公共壳层

`scripts/apply-shell.mjs` 用于把统一导航、页脚和文档目录同步到内页。主首页、角色、功能、下载与版本页保留独立内容结构；修改公共导航时应同时更新脚本与这五个页面。

## 公告

`data/announcements/*.md` 是源文件。修改后运行：

```powershell
node data/build-announcements.mjs
```

前端只读取生成后的 JSON，并在渲染前进行 URL 协议白名单与纯文本转义。
