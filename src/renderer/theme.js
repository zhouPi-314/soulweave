import { swCall, swOn } from './api.js';
/**
 * SoulWeave S2-26：主题跟随
 *
 * 目的：用户给窗口设了亮色背景图时，固定的深色标题栏/面板会显得割裂。
 * 提供三档：自动（跟随系统）/ 深色 / 浅色。
 *
 * 注意：**不做「自动分析背景图取色」**。
 * 原因：file:// 图片在 canvas 里会污染画布，getImageData 会抛 SecurityError，
 * 要绕过必须让主进程解码图片（PNG/JPEG/WebP 各一套），成本高、收益低。
 * 跟随系统 + 手动覆盖已经覆盖真实需求。
 */
const KEY = 'soulweave.theme';

/**
 * 主题清单。两个维度：
 *   base  —— 决定 data-theme（深色/浅色的底子，所有对比度令牌跟着它走）
 *   name  —— 决定 data-theme-name（换强调色与细节气质，不改变明暗关系）
 * 这样加一套主题只是加一行，不用复制整套 CSS。
 */
const THEMES = {
  dark:      { base: 'dark',  name: 'midnight' },
  light:     { base: 'light', name: 'dawn' },
  midnight:  { base: 'dark',  name: 'midnight' },
  graphite:  { base: 'dark',  name: 'graphite' },
  dawn:      { base: 'light', name: 'dawn' },
  sakura:    { base: 'light', name: 'sakura' },
};

let mode = 'auto';        // auto | dark | light
let systemDark = true;

function paint() {
  const key = mode === 'auto' ? (systemDark ? 'midnight' : 'dawn') : mode;
  const spec = THEMES[key] || THEMES.midnight;
  document.documentElement.dataset.theme = spec.base;
  document.documentElement.dataset.themeName = spec.name;
  return spec.base;
}

export function getTheme() {
  return { mode, systemDark, effective: document.documentElement.dataset.theme || 'dark' };
}

export function setTheme(next) {
  if (next === 'auto' || next === 'dark' || next === 'light' || Object.prototype.hasOwnProperty.call(THEMES, next)) {
    mode = next;
    try { localStorage.setItem(KEY, mode); } catch (e) { /* ignore */ }
  }
  return paint();
}

export async function initTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'auto' || saved === 'dark' || saved === 'light' || Object.prototype.hasOwnProperty.call(THEMES, saved)) mode = saved;
  } catch (e) { /* ignore */ }

  try {
    const s = await swCall('getTheme', );
    if (s && typeof s.dark === 'boolean') systemDark = s.dark;
  } catch (e) { /* ignore */ }

  paint();

  try {
    swOn('onThemeChanged', (s) => {
      if (s && typeof s.dark === 'boolean') {
        systemDark = s.dark;
        if (mode === 'auto') paint();
      }
    });
  } catch (e) { /* ignore */ }

  window.__theme = { getTheme, setTheme };
  return getTheme();
}
