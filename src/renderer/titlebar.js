import { swCall, swOn } from './api.js';
/**
 * SoulWeave S2-23：自绘标题栏
 *
 * 背景：完整窗口为了让「透明」真的透明，必须 transparent:true；
 * 而 Windows 上透明窗口的原生标题栏也随之不可见（实测标题都看不到）。
 * 因此改为 frame:false + 自绘标题栏，把窗口控制权拿回自己手里。
 *
 * 拖拽由 CSS 的 -webkit-app-region: drag 提供（比手写 IPC 拖动更顺滑、不丢帧），
 * 但按钮必须显式 no-drag，否则点击会被当作拖拽。
 */
export function initTitlebar() {
  const bar = document.getElementById('titlebar');
  if (!bar) return;

  const isPet = document.body.classList.contains('pet-mode');
  if (isPet) { bar.style.display = 'none'; return; }

  const btnMin = document.getElementById('tb-min');
  const btnMax = document.getElementById('tb-max');
  const btnClose = document.getElementById('tb-close');

  const call = async (action) => {
    try { return await swCall('windowControl', action); } catch (e) { return null; }
  };

  btnMin?.addEventListener('click', () => call('minimize'));
  btnClose?.addEventListener('click', () => call('close'));
  btnMax?.addEventListener('click', async () => {
    const r = await call('maximize');
    if (r && typeof r.maximized === 'boolean') setMaxIcon(r.maximized);
  });

  // 双击标题栏空白处 = 最大化/还原（与系统行为一致）
  bar.addEventListener('dblclick', async (e) => {
    if (e.target.closest('.tb-actions')) return;
    const r = await call('maximize');
    if (r && typeof r.maximized === 'boolean') setMaxIcon(r.maximized);
  });

  function setMaxIcon(max) {
    if (!btnMax) return;
    // Segoe 图标：E922 最大化 / E923 还原
    btnMax.innerHTML = max ? '&#xE923;' : '&#xE922;';
    btnMax.title = max ? '还原' : '最大化';
  }

  // 初始状态 + 订阅变化
  (async () => {
    try {
      const s = await swCall('getWindowState', );
      if (s) setMaxIcon(!!s.maximized);
    } catch (e) { /* ignore */ }
  })();

  try {
    swOn('onWindowStateChanged', (s) => { if (s) setMaxIcon(!!s.maximized); });
  } catch (e) { /* ignore */ }
}
