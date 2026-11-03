/**
 * SoulWeave S2-26：轻提示 + 首次启动托盘引导
 *
 * 为什么需要：
 *   Windows 11 会把新出现的托盘图标收进 ^ 溢出区，应用无权自己固定。
 *   用户第一次关掉窗口后会以为程序没了（已真实发生）。
 *   这里在首次启动时给一次简短说明，只提示一次。
 */
const HINT_KEY = 'soulweave.trayHintShown';

let hideTimer = null;

export function showToast(title, body, ms = 6000) {
  const el = document.getElementById('toast');
  if (!el) return;
  const t = document.getElementById('toast-title');
  const b = document.getElementById('toast-body');
  if (t) t.textContent = title;
  if (b) b.textContent = body;
  el.hidden = false;
  if (hideTimer) clearTimeout(hideTimer);
  if (ms > 0) hideTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function hideToast() {
  const el = document.getElementById('toast');
  if (el) el.hidden = true;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

export function initToast() {
  const btn = document.getElementById('toast-close');
  btn?.addEventListener('click', () => {
    hideToast();
    try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignore */ }
  });

  // 首次启动的托盘引导
  let shown = false;
  try { shown = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { /* ignore */ }
  if (shown) return;

  // 等界面稳定后再提示，避免和启动动画抢注意力
  setTimeout(() => {
    showToast(
      'SoulWeave 在系统托盘运行',
      '找不到图标？\n· 点任务栏右侧的 ^ 展开\n· 或按 Ctrl + Alt + S 随时唤出',
      0   // 不自动消失，等用户点「知道了」
    );
  }, 3500);
}
