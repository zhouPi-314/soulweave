import { swCall, swOn } from './api.js';
/**
 * S2 桌面双形态：桌宠模式引导
 *
 * 规则：
 *   - URL 带 ?mode=pet 时启用
 *   - 背景透明，隐藏 HUD
 *   - 指针按下时先做角色命中测试：
 *       命中角色 → 交给 Live2D 处理（表情/动作）
 *       未命中   → 通知主进程拖动窗口
 */
const params = new URLSearchParams(location.search);
const isPet = params.get('mode') === 'pet';

if (isPet) {
  document.body.classList.add('pet-mode');
  // html 元素也必须有 pet-mode，否则它的默认背景会把窗口填成不透明
  document.documentElement.classList.add('pet-mode');


  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 交给 Live2D 的命中测试判断是否点在角色上
    let hit = null;
    try {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const devX = (e.clientX - r.left) * dpr;
      const devY = (e.clientY - r.top) * dpr;
      const sub = window.__soulweaveLive2D?.delegate?._subdelegates?.at?.(0);
      const view = sub?._view;
      if (view) {
        hit = window.__soulweaveLive2D?.hitTestAt?.(view.transformScreenX(devX), view.transformScreenY(devY));
      }
    } catch { /* ignore */ }

    if (hit && hit.index >= 0) {
      // 点在角色身上：不拖窗口
      return;
    }
    // 点在空白处：拖动窗口
    document.body.classList.add('dragging');
    swCall('petDragStart', );
  }, true);

  const endDrag = () => {
    if (!document.body.classList.contains('dragging')) return;
    document.body.classList.remove('dragging');
    swCall('petDragEnd', );
  };
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);
  window.addEventListener('blur', endDrag);

  // 暴露给自动化验收
  window.__petMode = { active: true, hitTestAt: (x, y) => window.__hitTestAt?.(x, y) };
} else {
  window.__petMode = { active: false };
}
