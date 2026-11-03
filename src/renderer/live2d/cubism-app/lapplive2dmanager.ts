/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { ACubismMotion } from '@framework/motion/acubismmotion';
import { csmVector } from '@framework/type/csmvector';

import * as LAppDefine from './lappdefine';
import { LAppModel } from './lappmodel';
import { LAppPal } from './lapppal';
import { LAppSubdelegate } from './lappsubdelegate';

/**
 * サンプルアプリケーションにおいてCubismModelを管理するクラス
 * モデル生成と破棄、タップイベントの処理、モデル切り替えを行う。
 */
/**
 * SoulWeave S2-9：是否在卸载模型时删除其 WebGL 纹理。
 *
 * 置 false 的原因：实测删除纹理后，同一模型**重新加载**会渲染成纯黑剪影
 * （Hiyori 非暗像素 17.9% → 0%）。疑似 SDK 内部按 URL 缓存纹理句柄，
 * 删除后再次加载拿到的是失效句柄。
 * 保留开关便于后续用「只删真正不再使用的纹理」方案重新验证。
 */
const RELEASE_TEXTURES_ON_UNLOAD = true;

/**
 * SoulWeave S2-18（方案 B）：遮罩资源延迟删除的帧数。
 * 3 帧足以让 GL 命令流中引用它的批次执行完毕。
 */
const DISPOSAL_DELAY_FRAMES = 3;

export class LAppLive2DManager {
  /**
   * 現在のシーンで保持しているすべてのモデルを解放する
   */
  private releaseAllModel(): void {
    // 【S2-2 修复 2026-10-27】原实现只有 _models.clear()，**从不释放模型资源**。
    // 后果：每切换一次模型，CubismMoc / CubismModel 的 GPU 顶点与索引缓冲、
    // CubismRenderer_WebGL 的 WebGL 纹理与 VAO 全部泄漏；
    // 反复切换会耗尽显存，最终导致渲染进程崩溃（G2 复测中已真实复现）。
    //
    // 现在逐个显式释放：motions / expressions → release() → 清空引用。
    const count = this._models.getSize();
    for (let i = 0; i < count; i++) {
      const model = this._models.at(i);
      if (!model) continue;
      try {
        // 【S2-11 定案】按文件路径释放纹理 —— 同时删除 GL 纹理与该文件名的缓存项。
        //
        // 背景：lapptexturemanager.createTextureFromPngFile 会**按 fileName 缓存**
        // WebGLTexture；只调 gl.deleteTexture 不清缓存，重新加载同一模型会拿到
        // 失效句柄 → 渲染成纯黑（S2-8 实测 Hiyori 非暗像素 17.9%→0%）。
        // releaseTextureByFilePath 同时做「删纹理 + 移除缓存项」，因此重新加载会重新上传。
        if (RELEASE_TEXTURES_ON_UNLOAD) {
          try {
            const texMgr: any = (this._subdelegate as any)?.getTextureManager?.();
            if (texMgr && typeof texMgr.releaseTextureByFilePath === 'function') {
              for (const p of model.getTextureFilePaths()) {
                texMgr.releaseTextureByFilePath(p);
              }
            }
          } catch (e) {
            LAppPal.printMessage('[S2-11] texture release failed: ' + String(e));
          }
        }
        // 【S2-18 方案 B】收集遮罩资源并**延迟若干帧**再删除。
        // 立即删除会破坏渲染（见 report），延迟删除避开 GL 命令流仍在引用它的窗口。
        try {
          const w: any = globalThis as any;
          w.__maskReleaseStats = w.__maskReleaseStats || { calls: 0, tex: 0, fb: 0, noRenderer: 0, queued: 0, flushed: 0 };
          w.__maskReleaseStats.calls++;   // 先计数，避免后续异常吞掉诊断
          if (!model.getRenderer()) w.__maskReleaseStats.noRenderer++;

          const collected = model.collectMaskBuffers();
          const n = collected.textures.length;
          const m = collected.framebuffers.length;
          if (collected.gl && (n || m)) {
            this._disposalQueue.push({
              gl: collected.gl,
              textures: collected.textures,
              framebuffers: collected.framebuffers,
              framesLeft: DISPOSAL_DELAY_FRAMES,
            });
            w.__maskReleaseStats.queued++;
            w.__maskReleaseStats.queuedTex = (w.__maskReleaseStats.queuedTex || 0) + n;
            w.__maskReleaseStats.queuedFb = (w.__maskReleaseStats.queuedFb || 0) + m;
          } else {
            w.__maskReleaseStats.emptyCollect = (w.__maskReleaseStats.emptyCollect || 0) + 1;
          }
        } catch (e) {
          (globalThis as any).__maskReleaseStats.err = String(e);
        }
        model.releaseMotions();
        model.releaseExpressions();
        model.release();          // CubismUserModel.release()：moc / model / renderer / 特效
      } catch (e) {
        LAppPal.printMessage('[S2-2] model.release() 失败: ' + String(e));
      }
    }
    this._models.clear();
  }

  /**
   * 画面をドラッグした時の処理
   *
   * @param x 画面のX座標
   * @param y 画面のY座標
   */
  public onDrag(x: number, y: number): void {
    const count = this._models.getSize();
    if (count === 0) return;

    // (0,0) 是 lappview 在 touchesEnded 时用于「结束拖拽」的哨兵值。
    // 必须清除所有模型的拖拽状态并释放锁定，否则松手后角色会一直偏头。
    if (x === 0 && y === 0) {
      for (let i = 0; i < count; i++) {
        const m = this._models.at(i);
        if (m) m.setDragging(0, 0);
      }
      this._dragLockIndex = -1;
      return;
    }

    // 只驱动「按下时锁定的那个模型」，避免拖拽串到别的角色身上。
    const idx = this._dragLockIndex >= 0 ? this._dragLockIndex : this.hitTestTopmost(x, y);
    if (idx < 0) return;

    const local = this.toModelLocal(idx, x, y);
    const model = this._models.at(idx);
    if (local && model) model.setDragging(local.x, local.y);
  }

  /**
   * 画面をタップした時の処理
   *
   * @param x 画面のX座標
   * @param y 画面のY座標
   */
  public onTap(x: number, y: number): void {
    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(
        `[APP]tap point: {x: ${x.toFixed(2)} y: ${y.toFixed(2)}}`
      );
    }

    const hit = this.hitTestDetail(x, y);

    this._lastHit = hit;

    if (hit.index < 0) {
      return;
    }

    const model = this._models.at(hit.index);
    if (!model) return;

    if (hit.area === LAppDefine.HitAreaNameHead) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit #${hit.index} area: [${LAppDefine.HitAreaNameHead}]`);
      }
      model.setRandomExpression();
    } else if (hit.area === LAppDefine.HitAreaNameBody) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit #${hit.index} area: [${LAppDefine.HitAreaNameBody}]`);
      }
      model.startRandomMotion(
        LAppDefine.MotionGroupTapBody,
        LAppDefine.PriorityNormal,
        this.finishedMotion,
        this.beganMotion
      );
    }
  }

  /**
   * 触摸开始：锁定拖拽目标
   *
   * SoulWeave S2-1：多模型时，拖拽应只作用于「按下瞬间命中的那个角色」，
   * 而不是永远作用于第 0 个。这里在按下时决定锁定目标，
   * 之后 onDrag 只驱动它，直到松手（onDrag(0,0)）释放。
   */
  public onTouchBegin(x: number, y: number): void {
    this._dragLockIndex = this.hitTestTopmost(x, y);
    this._lastHit = { index: this._dragLockIndex, area: this._dragLockIndex >= 0 ? 'lock' : 'none' };
  }

  /**
   * 把屏幕 NDC 坐标转换到第 index 个模型的命中空间。
   *
   * 每个模型的投影矩阵不同（多模型时含水平 NDC 偏移），
   * 因此必须用「该模型自己的投影」做逆变换，不能共用一套。
   */
  private toModelLocal(index: number, ndcX: number, ndcY: number): { x: number; y: number } | null {
    const p = this._modelProjections[index];
    if (!p) return null;
    return { x: p.invertTransformX(ndcX), y: p.invertTransformY(ndcY) };
  }

  /**
   * 命中检测：返回最上层命中的模型索引（后绘制者在上），未命中返回 -1。
   */
  public hitTestTopmost(ndcX: number, ndcY: number): number {
    const r = this.hitTestDetail(ndcX, ndcY);
    return r.index;
  }

  /**
   * 命中检测（含命中区域名）。
   *
   * 顺序：从最后绘制的模型往前找，第一个命中的即为结果，
   * 保证「多模型重叠时只命中最上层」。
   */
  public hitTestDetail(ndcX: number, ndcY: number): { index: number; area: string } {
    const count = this._models.getSize();
    for (let i = count - 1; i >= 0; i--) {
      const model: LAppModel = this._models.at(i);
      if (!model) continue;
      const local = this.toModelLocal(i, ndcX, ndcY);
      if (!local) continue;
      if (model.hitTest(LAppDefine.HitAreaNameHead, local.x, local.y)) {
        return { index: i, area: LAppDefine.HitAreaNameHead };
      }
      if (model.hitTest(LAppDefine.HitAreaNameBody, local.x, local.y)) {
        return { index: i, area: LAppDefine.HitAreaNameBody };
      }
    }
    return { index: -1, area: 'none' };
  }

  /**
   * 画面を更新するときの処理
   * モデルの更新処理及び描画処理を行う
   */
  /**
   * 渲染所有已加载模型（SoulWeave 多角色支持）
   *
   * 相对官方 Demo 的改动：
   * 1. 遍历 _models 而非只取 at(0)
   * 2. 每个模型独立 projection（clone()，因为 draw() 会改写入参）
   * 3. 多模型时按水平方向均分并各自居中，避免重叠
   *
   * 可通过 getRenderStats() 读取每个模型的实际绘制次数，用于验证「真的画了两个」。
   */
  public onUpdate(): void {
    const __t0 = performance.now();
    const { width, height } = this._subdelegate.getCanvas();
    const count = this._models.getSize();
    if (count === 0) return;

    this._drawCount = 0;
    this._lastDrawStats = [];

    // S2-10：模型刚加载完，把所有角色的注视/拖拽归零（切换角色后自动回到中性姿态）
    if (this._pendingGazeReset) {
      this._pendingGazeReset = false;
      for (let i = 0; i < count; i++) {
        const m: LAppModel = this._models.at(i);
        if (m) m.setDragging(0, 0);
      }
    }

    for (let i = 0; i < count; i++) {
      const model: LAppModel = this._models.at(i);
      if (!model || !model.getModel()) {
        this._lastDrawStats.push({ index: i, drawn: false });
        continue;
      }

      // 每个模型一份独立投影矩阵
      const projection: CubismMatrix44 = new CubismMatrix44();

      if (model.getModel().getCanvasWidth() > 1.0 && width < height) {
        model.getModelMatrix().setWidth(2.0);
        projection.scale(1.0, width / height);
      } else {
        projection.scale(height / width, 1.0);
      }

      if (this._viewMatrix != null) {
        projection.multiplyByMatrix(this._viewMatrix);
      }

      // ── 多模型自适应布局（S2-7 修复）──
      //
      // 原实现只按水平均分，竖屏（桌宠窗口 420×560）下两个模型会互相覆盖。
      // 现在按画布宽高比选择网格：
      //   横屏（width >= height）→ 1 行 × N 列
      //   竖屏（width < height）  → N 行 × 1 列
      //
      // 注意 CubismMatrix44 的两个陷阱：
      //   scale(x,y)    是【覆盖】_tr[0]/_tr[5]，不是相乘
      //   translateX/Y  是【绝对赋值】_tr[12]/_tr[13]，不是累加
      // 因此偏移必须写成「当前值 + 增量」，不能直接赋 NDC 值。
      if (count > 1) {
        // S2-10：不再固定 1×N / N×1，而是选「格子宽高比最接近画面宽高比」的网格，
        // 这样 3 个及以上角色在任意窗口比例下都不会被压成细条。
        const canvasAspect = width / height;
        let best = { cols: count, rows: 1, score: Infinity };
        for (let c = 1; c <= count; c++) {
          const r = Math.ceil(count / c);
          const cellAspect = (width / c) / (height / r);
          const score = Math.abs(cellAspect - canvasAspect);
          if (score < best.score) best = { cols: c, rows: r, score };
        }
        const cols = best.cols;
        const rows = best.rows;

        // 【S2-13 修复】必须**等比例**缩放，否则模型会被拉伸变形。
        //
        // 原来写的是 scale(sx/cols, sy/rows)：当 cols≠rows 时 x/y 缩放比不同
        // → 角色被横向压扁（双模型时 cols=2, rows=1，x 缩一半、y 不变 → 明显变型）。
        // 参考 AIRI：其 PixiJS 的 scale 是单一标量，天然等比例。
        //
        // 正确做法：取一个统一的 zoom，让每个格子都能装下模型且不改变长宽比。
        const zoom = Math.min(1 / cols, 1 / rows);
        projection.scale(projection.getScaleX() * zoom, projection.getScaleY() * zoom);

        // 网格内位置：按列优先横向排列
        const col = i % cols;
        const row = Math.floor(i / cols);

        // 格心位置（NDC）：col=1 → 0；col=2 → ±0.5；col=3 → 0, ±2/3
        const offsetX = cols > 1 ? (-(cols - 1) / 2 + col) * (2 / cols) : 0;
        const offsetY = rows > 1 ? ((rows - 1) / 2 - row) * (2 / rows) : 0;

        projection.translateX(projection.getTranslateX() + offsetX);
        projection.translateY(projection.getTranslateY() + offsetY);
      }

      // SoulWeave S2-1：保存本帧该模型实际使用的投影矩阵。
      // 命中检测必须用「该模型自己的投影」做逆变换，不能共用一套。
      this._modelProjections[i] = projection.clone();

      model.update();

      // draw() 会改投影矩阵，因此用该模型自己的副本
      const drawProjection = projection.clone();
      model.draw(drawProjection);

      this._drawCount++;
      this._lastDrawStats.push({ index: i, drawn: true });
    }

    // S2-18：处理延迟删除队列（在**本帧绘制完成之后**）
    this.flushDisposalQueue();

    this._lastFrameMs = performance.now() - __t0;
  }

  /**
   * SoulWeave S2-18：帧边界延迟删除。
   *
   * 只在 onUpdate 末尾（本帧所有绘制已提交）执行，且每个资源要等
   * DISPOSAL_DELAY_FRAMES 帧。这样避开「删除时仍被 GL 命令流引用」的窗口。
   */
  private flushDisposalQueue(): void {
    if (this._disposalQueue.length === 0) return;
    const w: any = globalThis as any;
    for (let qi = this._disposalQueue.length - 1; qi >= 0; qi--) {
      const item = this._disposalQueue[qi];
      item.framesLeft--;
      if (item.framesLeft > 0) continue;
      try {
        for (const t of item.textures) {
          try { item.gl.deleteTexture(t); if (w.__maskReleaseStats) w.__maskReleaseStats.tex++; } catch (e) {}
        }
        for (const f of item.framebuffers) {
          try { item.gl.deleteFramebuffer(f); if (w.__maskReleaseStats) w.__maskReleaseStats.fb++; } catch (e) {}
        }
        if (w.__maskReleaseStats) w.__maskReleaseStats.flushed++;
      } catch (e) { /* ignore */ }
      this._disposalQueue.splice(qi, 1);
    }
  }

  /** SoulWeave: 上一帧 onUpdate 的 CPU 耗时 (ms) */
  public getLastFrameMs(): number {
    return this._lastFrameMs;
  }

  /** SoulWeave: 上一帧实际绘制的模型数 */
  public getDrawCount(): number {
    return this._drawCount;
  }

  /** SoulWeave: 上一帧逐模型绘制状态 */
  public getRenderStats(): Array<{ index: number; drawn: boolean }> {
    return this._lastDrawStats;
  }

  /**
   * SoulWeave S2-1：交互诊断信息（供自动化验收与日志取证）
   */
  public getInteractionStats(): {
    modelCount: number;
    dragLockIndex: number;
    lastHit: { index: number; area: string };
    modelOffsets: number[];
  } {
    const count = this._models.getSize();
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = this._modelProjections[i];
      offsets.push(p ? +p.getTranslateX().toFixed(4) : NaN);
    }
    return {
      modelCount: count,
      dragLockIndex: this._dragLockIndex,
      lastHit: { ...this._lastHit },
      modelOffsets: offsets,
    };
  }

  /**
   * SoulWeave S2-9：列出每个模型可用的表情与动作组，供 UI 面板渲染
   */
  public getModelCapabilities(): Array<{
    index: number;
    loaded: boolean;
    expressions: string[];
    expressionKind: string;
    motionGroups: Array<{ name: string; count: number }>;
  }> {
    const out: Array<any> = [];
    const n = this._models.getSize();
    for (let i = 0; i < n; i++) {
      const model: LAppModel = this._models.at(i);
      const loaded = !!(model && model.getModel());
      out.push({
        index: i,
        loaded,
        // S2-10：有 exp3 用 exp3；没有则给程序化表情（避免「该模型未提供」= 减配）
        expressions: loaded
          ? (model.getExpressionNames().length > 0
              ? model.getExpressionNames()
              : model.getProceduralExpressionNames())
          : [],
        expressionKind: loaded
          ? (model.getExpressionNames().length > 0 ? 'exp3' : 'procedural')
          : 'none',
        motionGroups: loaded ? model.getMotionGroups() : [],
      });
    }
    return out;
  }

  /** SoulWeave S2-9：在指定模型上播放表情 */
  public playExpressionAt(modelIndex: number, expression: string): boolean {
    const model: LAppModel = this._models.at(modelIndex);
    if (!model || !model.getModel()) return false;
    // 优先 exp3，其次程序化
    if (model.getExpressionNames().includes(expression)) {
      model.setExpression(expression);
      return true;
    }
    if (model.getProceduralExpressionNames().includes(expression)) {
      return model.startProceduralExpression(expression);
    }
    return false;
  }

  /** SoulWeave S2-9：在指定模型上播放动作 */
  public playMotionAt(modelIndex: number, group: string, index: number): boolean {
    const model: LAppModel = this._models.at(modelIndex);
    if (!model || !model.getModel()) return false;
    return model.playMotionAt(group, index);
  }

  /** SoulWeave: 已加载模型数 */
  public getModelCount(): number {
    return this._models.getSize();
  }

  /**
   * 次のシーンに切りかえる
   * サンプルアプリケーションではモデルセットの切り替えを行う。
   */
  public nextScene(): void {
    const no: number = (this._sceneIndex + 1) % LAppDefine.ModelDirSize;
    this.changeScene(no);
  }

  /**
   * シーンを切り替える
   * サンプルアプリケーションではモデルセットの切り替えを行う。
   * @param index
   */
  /**
   * SoulWeave：按完整 model3.json 的 URL 加载（用户导入的形象）。
   * 拆出目录与文件名后复用现有 loadAssets 流程，避免复制一套加载逻辑。
   */
  public loadByUrlPublic(model3Url: string): boolean {
    try {
      const u = String(model3Url || '');
      const cut = u.lastIndexOf('/');
      if (cut <= 0) return false;
      const dir = u.slice(0, cut + 1);
      const fileName = u.slice(cut + 1);
      if (!fileName.endsWith('.model3.json')) return false;
      this.releaseAllModel();
      const instance = new LAppModel();
      instance.setSubdelegate(this._subdelegate);
      instance.loadAssets(dir, fileName);
      this._models.pushBack(instance);
      return true;
    } catch (e) { return false; }
  }

  /** SoulWeave: 公开的场景切换入口 */
  public loadByIndexPublic(index: number): void {
    this.changeScene(index);
  }

  private changeScene(index: number): void {
    this._sceneIndex = index;

    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(`[APP]model index: ${this._sceneIndex}`);
    }

    // ModelDir[]に保持したディレクトリ名から
    // model3.jsonのパスを決定する。
    // ディレクトリ名とmodel3.jsonの名前を一致させておくこと。
    const model: string = LAppDefine.ModelDir[index];
    const modelPath: string = LAppDefine.ResourcesPath + model + '/';
    let modelJsonName: string = LAppDefine.ModelDir[index];
    modelJsonName += '.model3.json';

    this.releaseAllModel();
    const instance = new LAppModel();
    instance.setSubdelegate(this._subdelegate);
    instance.loadAssets(modelPath, modelJsonName);
    this._models.pushBack(instance);
  }

  /**
   * SoulWeave bench: load N models side by side (does not alter default behaviour).
   */
  public loadModelsForBench(names: string[]): void {
    this.releaseAllModel();
    for (const name of names) {
      const modelPath: string = LAppDefine.ResourcesPath + name + '/';
      const instance = new LAppModel();
      instance.setSubdelegate(this._subdelegate);
      instance.loadAssets(modelPath, name + '.model3.json');
      this._models.pushBack(instance);
    }
  }

  /** SoulWeave: 按 ModelDir 索引加载多个模型 */
  public loadModelsByIndices(indices: number[]): void {
    // SoulWeave S2-1：重载模型时清空投影缓存与拖拽锁定，避免用到过期矩阵
    this._modelProjections = [];
    this._dragLockIndex = -1;
    this._lastHit = { index: -1, area: 'none' };
    // S2-10：切换角色后把注视/拖拽状态归零，避免新角色一出现就斜着眼看
    this._pendingGazeReset = true;
    this.releaseAllModel();
    for (const idx of indices) {
      const name = LAppDefine.ModelDir[idx];
      if (!name) continue;
      const modelPath = LAppDefine.ResourcesPath + name + '/';
      const instance = new LAppModel();
      instance.setSubdelegate(this._subdelegate);
      instance.loadAssets(modelPath, name + '.model3.json');
      this._models.pushBack(instance);
    }
  }

  public setViewMatrix(m: CubismMatrix44) {
    for (let i = 0; i < 16; i++) {
      this._viewMatrix.getArray()[i] = m.getArray()[i];
    }
  }

  /**
   * モデルの追加
   */
  public addModel(sceneIndex: number = 0): void {
    this._sceneIndex = sceneIndex;
    this.changeScene(this._sceneIndex);
  }

  /**
   * コンストラクタ
   */
  public constructor() {
    this._subdelegate = null;
    this._viewMatrix = new CubismMatrix44();
    this._models = new csmVector<LAppModel>();
    this._sceneIndex = 0;
  }

  /**
   * 解放する。
   */
  public release(): void {}

  /**
   * 初期化する。
   * @param subdelegate
   */
  public initialize(subdelegate: LAppSubdelegate): void {
    this._subdelegate = subdelegate;
    this.changeScene(this._sceneIndex);
  }

  /**
   * 自身が所属するSubdelegate
   */
  private _subdelegate: LAppSubdelegate;

  _viewMatrix: CubismMatrix44; // モデル描画に用いるview行列
  _models: csmVector<LAppModel>; // モデルインスタンスのコンテナ

  /** SoulWeave: 上一帧实际绘制的模型数 */
  private _drawCount = 0;

  /** SoulWeave: 上一帧逐模型绘制状态 */
  private _lastDrawStats: Array<{ index: number; drawn: boolean }> = [];

  /** SoulWeave: 上一帧 onUpdate CPU 耗时 */
  private _lastFrameMs = 0;

  /** SoulWeave S2-1：每个模型在最近一帧使用的投影矩阵（用于命中逆变换） */
  private _modelProjections: CubismMatrix44[] = [];

  /** SoulWeave S2-1：按下时锁定的拖拽目标模型索引，-1 表示未锁定 */
  private _dragLockIndex = -1;

  /** SoulWeave S2-1：最近一次命中的诊断记录 */
  private _lastHit: { index: number; area: string } = { index: -1, area: 'none' };

  /** S2-10：下一帧是否需要把所有模型的注视/拖拽归零 */
  private _pendingGazeReset = false;

  /** S2-18：待删除的 GPU 资源队列（延迟 DISPOSAL_DELAY_FRAMES 帧） */
  private _disposalQueue: Array<{
    gl: WebGLRenderingContext;
    textures: WebGLTexture[];
    framebuffers: WebGLFramebuffer[];
    framesLeft: number;
  }> = [];
  private _sceneIndex: number; // 表示するシーンのインデックス値

  // モーション再生開始のコールバック関数
  beganMotion = (self: ACubismMotion): void => {
    LAppPal.printMessage('Motion Began:');
    console.log(self);
  };
  // モーション再生終了のコールバック関数
  finishedMotion = (self: ACubismMotion): void => {
    LAppPal.printMessage('Motion Finished:');
    console.log(self);
  };
}
