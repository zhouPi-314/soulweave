/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

/**
 * Cubism SDKのサンプルで使用するWebGLを管理するクラス
 */
export class LAppGlManager {
  public constructor() {
    this._gl = null;
  }

  public initialize(canvas: HTMLCanvasElement): boolean {
    // glコンテキストを初期化
    // S2-7：桌宠透明窗口要求 drawingBuffer 带 alpha，
    // 否则 CSS 背景再透明，canvas 仍然是不透明黑。
    // S2-9 修正：不要显式传上下文属性。
    // 实测显式指定 alpha/premultipliedAlpha 会让使用裁剪遮罩的模型
    // （Hiyori）渲染成纯黑剪影（非暗像素 17.9% → 0%）。
    // WebGL 默认 alpha 即为 true，透明只需靠 clearColor alpha=0 达成。
    this._gl = canvas.getContext('webgl2');

    if (!this._gl) {
      // gl初期化失敗
      alert('Cannot initialize WebGL. This browser does not support.');
      this._gl = null;
      // document.body.innerHTML =
      //   'This browser does not support the <code>&lt;canvas&gt;</code> element.';
      return false;
    }
    return true;
  }

  /**
   * 解放する。
   */
  public release(): void {}

  public getGl(): WebGLRenderingContext | WebGL2RenderingContext {
    return this._gl;
  }

  private _gl: WebGLRenderingContext | WebGL2RenderingContext = null;
}
