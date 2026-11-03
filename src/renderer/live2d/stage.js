/**
 * SoulWeave Live2D 舞台封装
 *
 * 底层是 Cubism Web Samples（Live2D Open Software License）。
 * 资源路径由 cubism-app/lappdefine.ts 的 ResourcesPath 决定 = './models/'
 */

import { LAppDelegate } from './cubism-app/lappdelegate.ts';
import { swCall, swOn } from '../api.js';

export class SoulWeaveLive2D {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onFps = opts.onFps || (() => {});
    this._frames = 0;
    this._t0 = performance.now();
  }

  initialize() {
    const delegate = LAppDelegate.getInstance();
    if (!delegate.initialize()) return false;
    this.delegate = delegate;

    LAppDelegate.onFrameTick = () => {
      this._frames++;
      const el = performance.now() - this._t0;
      if (el >= 1000) {
        this.onFps(Math.round((this._frames / el) * 1000));
        this._frames = 0;
        this._t0 = performance.now();
      }
    };
    return true;
  }

  /**
   * 按索引加载模型（索引对应 lappdefine.ts 的 ModelDir）
   */
  loadByIndex(index = 0) {
    const sub = this.delegate._subdelegates?.at?.(0);
    if (!sub) throw new Error('subdelegate 不可用');
    const mgr = sub.getLive2DManager?.();
    if (!mgr) throw new Error('Live2DManager 不可用');
    if (typeof mgr.loadByIndexPublic === 'function') {
      mgr.loadByIndexPublic(index);
    } else {
      throw new Error('loadByIndexPublic 未注入');
    }
  }

  run() { this.delegate.run(); }

  /**
   * 同步 canvas 分辨率到实际显示尺寸
   *
   * 修复：Cubism SDK 的 resizeCanvas() 在 initialize() 时若 clientWidth 尚未就绪，
   * canvas 会停留在 HTML 默认 300x150，导致画面被拉伸模糊。
   * 这里在布局完成后显式补齐。
   */
  /**
   * 同步 canvas 分辨率到实际显示尺寸
   *
   * @param {boolean} force 为 true 时即使尺寸未变也重建 view / deviceToScreen。
   *
   * 【S2-1 修复 2026-10-27】原实现只改 c.width/height 后调 onResize()，
   * 但尺寸没变时直接 return，不会再调 onResize()。
   * 后果：高 DPI（如 150%）下若首次 syncSize 发生在布局稳定之前，
   * deviceToScreen 会停留在旧的画布尺寸，导致**启动后首次点击/拖拽全部落空**，
   * 必须手动拖一下窗口才恢复。force 参数用于在启动阶段强制重建。
   */
  syncSize(force = false) {
    const c = this.canvas;
    // S2-10：按画质预设限制渲染分辨率（0 = 不限制）
    const cap = Number(window.__dprCap || 0);
    const rawDpr = window.devicePixelRatio || 1;
    const baseDpr = cap > 0 ? Math.min(rawDpr, cap) : rawDpr;
    const ss = Number(window.__superSample || 1);
    // 超采样：把绘制缓冲放大再交给浏览器缩小显示，画面更锐利（AIRI 同思路）
    const dpr = baseDpr * (ss > 1 ? ss : 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (w === 0 || h === 0) return false;
    const changed = (c.width !== w || c.height !== h);
    if (!changed && !force) return true;
    if (changed) {
      c.width = w;
      c.height = h;
    }
    const sub = this.delegate?._subdelegates?.at?.(0);
    sub?.onResize?.();
    return true;
  }

  /**
   * 按模型路径加载用户导入的 Live2D 形象。
   *
   * 内置模型是「ResourcesPath + ModelDir[index]」，用户导入的是一个绝对目录，
   * 所以需要绕开 ModelDir 表直接给 loadAssets 目录与文件名。
   * 路径无效时返回 false，调用方回落到内置模型，不能白屏。
   */
  loadByPath(model3Url) {
    try {
      const sub = this.delegate._subdelegates?.at?.(0);
      const mgr = sub?.getLive2DManager?.();
      if (!mgr || typeof mgr.loadByUrlPublic !== 'function') return false;
      return mgr.loadByUrlPublic(model3Url);
    } catch (e) { return false; }
  }

  /** 按索引数组加载多个模型（用于多角色验证） */
  loadByIndices(indices, opts = {}) {
    const sub = this.delegate._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    if (!mgr) throw new Error('Live2DManager 不可用');
    mgr.loadModelsByIndices(indices);

    // S2-18：恢复（recycle 后重建）不算用户切换 —— 不计入次数、不上报。
    // 否则回收后恢复会上报 switchCount=1，空闲巡检 30 秒后再次触发 → 无限重载。
    if (opts && opts.silent) {
      try { sessionStorage.setItem('soulweave.models', JSON.stringify(indices)); } catch (e) {}
      return;
    }

    // S2-16 安全阀 E：统计切换次数并上报；同时记住"当前角色"以便回收后恢复
    try {
      window.__switchCount = (window.__switchCount || 0) + 1;
      window.__switchStats = window.__switchStats || { count: 0, lastModels: null };
      window.__switchStats.count = window.__switchCount;
      window.__switchStats.lastModels = indices.slice();
      sessionStorage.setItem('soulweave.models', JSON.stringify(indices));
      swCall('notifyModelSwitch', window.__switchCount, indices.slice());
    } catch (e) { /* ignore */ }
  }

  /** SoulWeave S2-1：交互诊断（命中索引、拖拽锁定、各模型 NDC 偏移） */
  getInteractionStats() {
    const sub = this.delegate?._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    return mgr?.getInteractionStats?.() ?? null;
  }

  /** SoulWeave S2-1：按屏幕 NDC 模拟点按（含按下锁定 → 抬起判定 → 释放） */
  tapAt(ndcX, ndcY) {
    const sub = this.delegate?._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    if (!mgr) return null;
    mgr.onTouchBegin(ndcX, ndcY);
    mgr.onTap(ndcX, ndcY);
    const hit = mgr.getInteractionStats();
    mgr.onDrag(0, 0);
    return hit;
  }

  /** SoulWeave S2-1：按屏幕 NDC 模拟拖拽（须先 tapAt 或 beginDragAt 锁定目标） */
  beginDragAt(ndcX, ndcY) {
    const sub = this.delegate?._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    if (!mgr) return null;
    mgr.onTouchBegin(ndcX, ndcY);
    return mgr.getInteractionStats();
  }

  dragAt(ndcX, ndcY) {
    const sub = this.delegate?._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    if (!mgr) return null;
    mgr.onDrag(ndcX, ndcY);
    return mgr.getInteractionStats();
  }

  endDrag() {
    const sub = this.delegate?._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    if (!mgr) return null;
    mgr.onDrag(0, 0);
    return mgr.getInteractionStats();
  }

  /** SoulWeave S2-1：纯命中查询（不改状态） */
  hitTestAt(ndcX, ndcY) {
    const sub = this.delegate?._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    return mgr?.hitTestDetail?.(ndcX, ndcY) ?? null;
  }


  /** SoulWeave S2-9：每个模型可用的表情/动作（供面板渲染） */
  getModelCapabilities() {
    const sub = this.delegate?._subdelegates?.at?.(0);
    return sub?.getLive2DManager?.()?.getModelCapabilities?.() ?? [];
  }

  /** SoulWeave S2-9：播放指定模型的表情 */
  playExpressionAt(modelIndex, expression) {
    const sub = this.delegate?._subdelegates?.at?.(0);
    return sub?.getLive2DManager?.()?.playExpressionAt?.(modelIndex, expression) ?? false;
  }

  /** SoulWeave S2-9：播放指定模型的动作 */
  playMotionAt(modelIndex, group, index) {
    const sub = this.delegate?._subdelegates?.at?.(0);
    return sub?.getLive2DManager?.()?.playMotionAt?.(modelIndex, group, index) ?? false;
  }

  getRenderStats() {
    const sub = this.delegate._subdelegates?.at?.(0);
    const mgr = sub?.getLive2DManager?.();
    if (!mgr) return null;
    return {
      modelCount: mgr.getModelCount?.() ?? -1,
      drawCount: mgr.getDrawCount?.() ?? -1,
      perModel: mgr.getRenderStats?.() ?? [],
      lastFrameMs: mgr.getLastFrameMs?.() ?? -1,
    };
  }

  playMotion(group, index) {
    try {
      const sub = this.delegate._subdelegates?.at?.(0);
      const mgr = sub?.getLive2DManager?.();
      const model = mgr?._models?.at?.(0);
      model?.startRandomMotion?.(group, index);
    } catch { /* noop */ }
  }
}
