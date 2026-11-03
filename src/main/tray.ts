/**
 * SoulWeave 托盘（BOOT-002）
 *
 * 职责：
 * - 提供托盘图标与菜单（显示/隐藏/退出）
 * - 托盘恢复主窗时**不重播启动页**（置 global.__soulweaveTrayRestore）
 * - 支持「启动时隐藏到托盘」（配合 --hidden 自启动）
 *
 * 图标说明（见 S2_05 报告）：
 *   现有 SoulWeave_V1.7.png 是多角色插画 + 文字，缩到 16×16/32×32 后不可辨识。
 *   按用户决定「现有图标只用于快捷方式/任务栏/安装器/EXE，不得重新设计」，
 *   这里**直接缩放沿用**，不新做设计；托盘专用简化标记需用户另行决定。
 */

import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface TrayOptions {
  root: string;
  iconPath?: string;
  onShow: () => void;
  onHide: () => void;
  onQuit: () => void;
  onToggleMode?: () => void;
}

let tray: Tray | null = null;

/**
 * 解析托盘图标路径。
 *
 * 优先级：
 *   1. 环境变量 SOULWEAVE_ICON_PATH（调试用）
 *   2. 显式参数
 *   3. **专用托盘图标** assets/tray-32.png → tray-16.png
 *   4. 后备：旧品牌图（缩到 16px 后不可辨识，仅避免无图标）
 *
 * 托盘继续使用橘子图标；应用窗口、快捷方式与安装器使用 assets/app-icon.ico。
 */
export function resolveIconPath(root: string, explicit?: string): string | null {
  // S2-21：Windows 托盘优先用多尺寸 .ico（16/24/32/48/64/256），
  // 系统会按当前 DPI 自动挑选最合适的一档，比单一 PNG 更清晰可靠。
  if (process.platform === 'win32' && !explicit) {
    // 深色任务栏用高对比变体：橙色片在深底上容易糊，深色版加了奶油描边
    const dark = path.join(root, 'assets', 'tray-dark.ico');
    const light = path.join(root, 'assets', 'tray.ico');
    if (nativeTheme.shouldUseDarkColors && fs.existsSync(dark)) return dark;
    if (fs.existsSync(light)) return light;
  }
  const fromEnv = process.env.SOULWEAVE_ICON_PATH;
  const candidates = [
    fromEnv,
    explicit,
    path.join(root, 'assets', 'tray-32.png'),
    path.join(root, 'assets', 'tray-16.png'),
    path.join(root, 'assets', 'SoulWeave.png'),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/** 生成托盘用图像：按托盘尺寸缩放，保留宽高比 */
function buildTrayImage(iconPath: string | null, size: number): Electron.NativeImage {
  if (!iconPath) {
    // 无图标时退化为 1×1 透明图，避免 Tray 构造抛错（功能仍可用，只是不可见）
    return nativeImage.createEmpty();
  }
  const img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) return nativeImage.createEmpty();
  return img.resize({ width: size, height: size, quality: 'best' });
}

export function createTray(opts: TrayOptions): Tray | null {
  try {
    const iconPath = resolveIconPath(opts.root, opts.iconPath);
    // 已有按尺寸导出的专用图；直接读取，让 Electron 按 DPI 自行缩放。
    // 只有当拿到的是后备大图时才缩到托盘尺寸。
    const size = process.platform === 'win32' ? 16 : 22;
    const isDedicated = !!iconPath && /tray-(16|24|32|48|64|256)\.png$/.test(iconPath);
    const image = isDedicated
      ? nativeImage.createFromPath(iconPath!)
      : buildTrayImage(iconPath, size);

    tray = new Tray(image);
    tray.setToolTip('SoulWeave');

    const menu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => opts.onShow(),
      },
      {
        label: '隐藏到托盘',
        click: () => opts.onHide(),
      },
      { type: 'separator' },
      {
        label: '关于 SoulWeave',
        enabled: false,
      },
      {
        label: '  v' + app.getVersion() + ' · SoulWeave V1.7',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => opts.onQuit(),
      },
    ]);
    tray.setContextMenu(menu);

    // 左键点击：切换显示/隐藏
    tray.on('click', () => {
      const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      const visible = wins.some((w) => w.isVisible());
      if (visible) opts.onHide();
      else opts.onShow();
    });

    if (process.env.SOULWEAVE_DEBUG_BOOT === '1') {
      console.log('[tray] created, icon=' + (iconPath || '(none)') + ' size=' + size);
    }
    return tray;
  } catch (e) {
    console.error('[tray] 创建失败:', e);
    return null;
  }
}

export function destroyTray(): void {
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
  } catch { /* ignore */ }
  tray = null;
}

export function isTrayActive(): boolean {
  return !!tray && !tray.isDestroyed();
}
