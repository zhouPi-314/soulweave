# ADR-2｜桌面壳选择：Electron

> **状态**：提议（待负责人批准）｜**日期**：2026-10-26｜**阶段**：S1

## 背景

V1.7 明确「不能因 DSH 使用 Electron 就直接锁定 Electron」。需实测论证。

## 实测数据【事实】

同机、同负载（每帧 120 draw calls，测 4 秒）：

| 指标 | Electron 45.0.0 | Tauri 2.12.5 | 胜者 |
|---|---|---|---|
| 安装体积 | 357 MB | **4 MB** | Tauri（89×） |
| 启动→HTML | 366 ms | **~40 ms** | Tauri（9×） |
| FPS | 142.1 | 142.0 | 持平 |
| 进程数 | **4** | 8 | Electron |
| 内存合计 | **430 MB** | 495 MB | Electron |

**真实 Live2D 双模型（Electron）**：

| 场景 | 稳态 FPS | 内存 |
|---|---|---|
| 单模型 | 144.1 | 574 MB |
| 双模型 | 133.3 | 640 MB |

## 决策

**采用 Electron 45。**

## 理由（按权重排序）

### 1. 内存更省【事实】
Electron 430 MB vs Tauri 495 MB。**「Tauri 更省内存」是误解**——Tauri 主进程只有 72 MB，但 WebView2 要起 6 个子进程（412 MB）。

### 2. 与 AIRI 同栈【事实】
AIRI 用 Electron 43.4.1 + electron-vite 5 + electron-builder 26。其 `apps/stage-tamagotchi/electron.vite.config.ts` 可直接参考。

### 3. 桌宠多窗口成熟【推断】
`transparent` + `alwaysOnTop` + `setIgnoreMouseEvents` 组合在 Electron 生态里经过大量验证。

### 4. 工具链已就绪【事实】
本机 Electron 45 已安装并实测；Tauri 需额外 2.7 GB 工具链（Rust + MinGW）。

### 5. 启动 366 ms 可接受
桌面应用不需要 40 ms 冷启动。

## 后果

### 正面
- 内存占用更低
- AIRI 复用成本最低
- 生态成熟

### 负面与缓解

| 风险 | 缓解 |
|---|---|
| 安装包 357 MB 偏大 | S11 用 electron-builder 分层打包；大资源按需下载（D56 两层分发） |
| 需装 NSIS | ✅ 已装到 `<workspace>\06_prototype\toolchain\nsis` |
| Chromium 安全更新需跟进 | 锁定版本 + 定期升级 |

## 一个必须处理的坑【事实】

实测发现：**窗口被遮挡时 Chromium 会降频到 1.2 FPS**。

修复：
```js
webPreferences: { backgroundThrottling: false }
win.setAlwaysOnTop(true, 'screen-saver');
win.webContents.setFrameRate(120);
```

**对 SoulWeave 的意义**：桌宠场景必须显式管理可见性策略——不可见时**主动降帧或暂停**，而不是让 Chromium 自作主张。

## 保留 Tauri 作为备选

若最终安装包体积成为发布阻碍，Tauri 的 4 MB 是唯一解。工具链保留在 D 盘（2.7 GB）。

## 参考

- S0 补充报告 §5
- `<workspace>\04_test-assets\analysis\stack-comparison.json`
- `<workspace>\04_test-assets\analysis\live2d-real-bench.json`
