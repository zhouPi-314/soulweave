/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismDefaultParameterId } from '@framework/cubismdefaultparameterid';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import {
  BreathParameterData,
  CubismBreath
} from '@framework/effect/cubismbreath';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { ICubismModelSetting } from '@framework/icubismmodelsetting';
import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import {
  ACubismMotion,
  BeganMotionCallback,
  FinishedMotionCallback
} from '@framework/motion/acubismmotion';
import { CubismMotion } from '@framework/motion/cubismmotion';
import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue
} from '@framework/motion/cubismmotionqueuemanager';
import { csmMap } from '@framework/type/csmmap';
import { csmRect } from '@framework/type/csmrectf';
import { csmString } from '@framework/type/csmstring';
import { csmVector } from '@framework/type/csmvector';
import {
  CSM_ASSERT,
  CubismLogError,
  CubismLogInfo
} from '@framework/utils/cubismdebug';

import * as LAppDefine from './lappdefine';
import { LAppPal } from './lapppal';
import { TextureInfo } from './lapptexturemanager';
import { LAppWavFileHandler } from './lappwavfilehandler';
import { CubismMoc } from '@framework/model/cubismmoc';
import { LAppDelegate } from './lappdelegate';
import { LAppSubdelegate } from './lappsubdelegate';

enum LoadStep {
  LoadAssets,
  LoadModel,
  WaitLoadModel,
  LoadExpression,
  WaitLoadExpression,
  LoadPhysics,
  WaitLoadPhysics,
  LoadPose,
  WaitLoadPose,
  SetupEyeBlink,
  SetupBreath,
  LoadUserData,
  WaitLoadUserData,
  SetupEyeBlinkIds,
  SetupLipSyncIds,
  SetupLayout,
  LoadMotion,
  WaitLoadMotion,
  CompleteInitialize,
  CompleteSetupModel,
  LoadTexture,
  WaitLoadTexture,
  CompleteSetup
}

/**
 * ユーザーが実際に使用するモデルの実装クラス<br>
 * モデル生成、機能コンポーネント生成、更新処理とレンダリングの呼び出しを行う。
 */

/**
 * SoulWeave S2-10：程序化表情表
 *
 * 【为什么需要】Hiyori / Mark 的 model3.json 里**没有 Expressions 字段**
 * （Live2D 官方样例原状），若只依赖 exp3 就会「该模型未提供表情」，
 * 等同于对这两个角色减配。
 *
 * 这里用 Cubism 标准参数做一层程序化表情：
 *   - 不修改模型资源、不需要 exp3 文件
 *   - 任何含标准参数的模型都可用
 *   - 与 exp3 互不冲突：有 exp3 优先用 exp3，没有则用本表
 *
 * 参数名取自 Cubism 标准参数 ID，缺失的参数会被自动跳过（不报错）。
 */
const PROC_EXPRESSIONS: Record<string, Array<[string, number]>> = {
  '微笑': [
    ['ParamMouthForm', 1.0],
    ['ParamEyeLOpen', 0.72],
    ['ParamEyeROpen', 0.72],
    ['ParamBrowLY', 0.35],
    ['ParamBrowRY', 0.35],
    ['ParamCheek', 1.0],
  ],
  '惊讶': [
    ['ParamMouthOpenY', 1.0],
    ['ParamEyeLOpen', 1.0],
    ['ParamEyeROpen', 1.0],
    ['ParamBrowLY', 1.0],
    ['ParamBrowRY', 1.0],
    ['ParamBrowLForm', -0.6],
    ['ParamBrowRForm', -0.6],
  ],
  '害羞': [
    ['ParamMouthForm', 0.6],
    ['ParamEyeLOpen', 0.45],
    ['ParamEyeROpen', 0.45],
    ['ParamCheek', 1.0],
    ['ParamAngleZ', 6.0],
    ['ParamBrowLY', -0.4],
    ['ParamBrowRY', -0.4],
  ],
  '难过': [
    ['ParamMouthForm', -1.0],
    ['ParamEyeLOpen', 0.55],
    ['ParamEyeROpen', 0.55],
    ['ParamBrowLY', -0.8],
    ['ParamBrowRY', -0.8],
    ['ParamBrowLForm', 0.8],
    ['ParamBrowRForm', 0.8],
    ['ParamAngleY', -6.0],
  ],
  '眨眼': [
    ['ParamEyeLOpen', 0.0],
    ['ParamEyeROpen', 0.0],
  ],
  '侧头': [
    ['ParamAngleX', 20.0],
    ['ParamAngleZ', -8.0],
    ['ParamBodyAngleX', 8.0],
  ],
};

/**
 * SoulWeave S2-15：是否在卸载模型时删除裁剪遮罩的纹理/帧缓冲。
 *
 * 置 false 的原因见 releaseMaskBuffers() 内注释：
 * 删除能把泄漏从 24 降到 3，但会破坏渲染。**正确性优先。**
 */
const RELEASE_MASK_BUFFERS_ON_UNLOAD = false;

export class LAppModel extends CubismUserModel {
  /**
   * model3.jsonが置かれたディレクトリとファイルパスからモデルを生成する
   * @param dir
   * @param fileName
   */
  public loadAssets(dir: string, fileName: string): void {
    this._modelHomeDir = dir;

    fetch(`${this._modelHomeDir}${fileName}`)
      .then(response => response.arrayBuffer())
      .then(arrayBuffer => {
        const setting: ICubismModelSetting = new CubismModelSettingJson(
          arrayBuffer,
          arrayBuffer.byteLength
        );

        // ステートを更新
        this._state = LoadStep.LoadModel;

        // 結果を保存
        this.setupModel(setting);
      })
      .catch(error => {
        // model3.json読み込みでエラーが発生した時点で描画は不可能なので、setupせずエラーをcatchして何もしない
        CubismLogError(`Failed to load file ${this._modelHomeDir}${fileName}`);
      });
  }

  /**
   * model3.jsonからモデルを生成する。
   * model3.jsonの記述に従ってモデル生成、モーション、物理演算などのコンポーネント生成を行う。
   *
   * @param setting ICubismModelSettingのインスタンス
   */
  private setupModel(setting: ICubismModelSetting): void {
    this._updating = true;
    this._initialized = false;

    this._modelSetting = setting;

    // CubismModel
    if (this._modelSetting.getModelFileName() != '') {
      const modelFileName = this._modelSetting.getModelFileName();

      fetch(`${this._modelHomeDir}${modelFileName}`)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${modelFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then(arrayBuffer => {
          this.loadModel(arrayBuffer, this._mocConsistency);
          this._state = LoadStep.LoadExpression;

          // callback
          loadCubismExpression();
        });

      this._state = LoadStep.WaitLoadModel;
    } else {
      LAppPal.printMessage('Model data does not exist.');
    }

    // Expression
    const loadCubismExpression = (): void => {
      if (this._modelSetting.getExpressionCount() > 0) {
        const count: number = this._modelSetting.getExpressionCount();

        for (let i = 0; i < count; i++) {
          const expressionName = this._modelSetting.getExpressionName(i);
          const expressionFileName =
            this._modelSetting.getExpressionFileName(i);

          fetch(`${this._modelHomeDir}${expressionFileName}`)
            .then(response => {
              if (response.ok) {
                return response.arrayBuffer();
              } else if (response.status >= 400) {
                CubismLogError(
                  `Failed to load file ${this._modelHomeDir}${expressionFileName}`
                );
                // ファイルが存在しなくてもresponseはnullを返却しないため、空のArrayBufferで対応する
                return new ArrayBuffer(0);
              }
            })
            .then(arrayBuffer => {
              const motion: ACubismMotion = this.loadExpression(
                arrayBuffer,
                arrayBuffer.byteLength,
                expressionName
              );

              if (this._expressions.getValue(expressionName) != null) {
                ACubismMotion.delete(
                  this._expressions.getValue(expressionName)
                );
                this._expressions.setValue(expressionName, null);
              }

              this._expressions.setValue(expressionName, motion);

              this._expressionCount++;

              if (this._expressionCount >= count) {
                this._state = LoadStep.LoadPhysics;

                // callback
                loadCubismPhysics();
              }
            });
        }
        this._state = LoadStep.WaitLoadExpression;
      } else {
        this._state = LoadStep.LoadPhysics;

        // callback
        loadCubismPhysics();
      }
    };

    // Physics
    const loadCubismPhysics = (): void => {
      if (this._modelSetting.getPhysicsFileName() != '') {
        const physicsFileName = this._modelSetting.getPhysicsFileName();

        fetch(`${this._modelHomeDir}${physicsFileName}`)
          .then(response => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${physicsFileName}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then(arrayBuffer => {
            this.loadPhysics(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.LoadPose;

            // callback
            loadCubismPose();
          });
        this._state = LoadStep.WaitLoadPhysics;
      } else {
        this._state = LoadStep.LoadPose;

        // callback
        loadCubismPose();
      }
    };

    // Pose
    const loadCubismPose = (): void => {
      if (this._modelSetting.getPoseFileName() != '') {
        const poseFileName = this._modelSetting.getPoseFileName();

        fetch(`${this._modelHomeDir}${poseFileName}`)
          .then(response => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${poseFileName}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then(arrayBuffer => {
            this.loadPose(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlink;

            // callback
            setupEyeBlink();
          });
        this._state = LoadStep.WaitLoadPose;
      } else {
        this._state = LoadStep.SetupEyeBlink;

        // callback
        setupEyeBlink();
      }
    };

    // EyeBlink
    const setupEyeBlink = (): void => {
      if (this._modelSetting.getEyeBlinkParameterCount() > 0) {
        this._eyeBlink = CubismEyeBlink.create(this._modelSetting);
        this._state = LoadStep.SetupBreath;
      }

      // callback
      setupBreath();
    };

    // Breath
    const setupBreath = (): void => {
      this._breath = CubismBreath.create();

      const breathParameters: csmVector<BreathParameterData> = new csmVector();
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleX, 0.0, 15.0, 6.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleY, 0.0, 8.0, 3.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleZ, 0.0, 10.0, 5.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamBodyAngleX, 0.0, 4.0, 15.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(
          CubismFramework.getIdManager().getId(
            CubismDefaultParameterId.ParamBreath
          ),
          0.5,
          0.5,
          3.2345,
          1
        )
      );

      this._breath.setParameters(breathParameters);
      this._state = LoadStep.LoadUserData;

      // callback
      loadUserData();
    };

    // UserData
    const loadUserData = (): void => {
      if (this._modelSetting.getUserDataFile() != '') {
        const userDataFile = this._modelSetting.getUserDataFile();

        fetch(`${this._modelHomeDir}${userDataFile}`)
          .then(response => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${userDataFile}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then(arrayBuffer => {
            this.loadUserData(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlinkIds;

            // callback
            setupEyeBlinkIds();
          });

        this._state = LoadStep.WaitLoadUserData;
      } else {
        this._state = LoadStep.SetupEyeBlinkIds;

        // callback
        setupEyeBlinkIds();
      }
    };

    // EyeBlinkIds
    const setupEyeBlinkIds = (): void => {
      const eyeBlinkIdCount: number =
        this._modelSetting.getEyeBlinkParameterCount();

      for (let i = 0; i < eyeBlinkIdCount; ++i) {
        this._eyeBlinkIds.pushBack(
          this._modelSetting.getEyeBlinkParameterId(i)
        );
      }

      this._state = LoadStep.SetupLipSyncIds;

      // callback
      setupLipSyncIds();
    };

    // LipSyncIds
    const setupLipSyncIds = (): void => {
      const lipSyncIdCount = this._modelSetting.getLipSyncParameterCount();

      for (let i = 0; i < lipSyncIdCount; ++i) {
        this._lipSyncIds.pushBack(this._modelSetting.getLipSyncParameterId(i));
      }
      this._state = LoadStep.SetupLayout;

      // callback
      setupLayout();
    };

    // Layout
    const setupLayout = (): void => {
      const layout: csmMap<string, number> = new csmMap<string, number>();

      if (this._modelSetting == null || this._modelMatrix == null) {
        CubismLogError('Failed to setupLayout().');
        return;
      }

      this._modelSetting.getLayoutMap(layout);
      this._modelMatrix.setupFromLayout(layout);
      this._state = LoadStep.LoadMotion;

      // callback
      loadCubismMotion();
    };

    // Motion
    const loadCubismMotion = (): void => {
      this._state = LoadStep.WaitLoadMotion;
      this._model.saveParameters();
      this._allMotionCount = 0;
      this._motionCount = 0;
      const group: string[] = [];

      const motionGroupCount: number = this._modelSetting.getMotionGroupCount();

      // モーションの総数を求める
      for (let i = 0; i < motionGroupCount; i++) {
        group[i] = this._modelSetting.getMotionGroupName(i);
        this._allMotionCount += this._modelSetting.getMotionCount(group[i]);
      }

      // モーションの読み込み
      for (let i = 0; i < motionGroupCount; i++) {
        this.preLoadMotionGroup(group[i]);
      }

      // モーションがない場合
      if (motionGroupCount == 0) {
        this._state = LoadStep.LoadTexture;

        // 全てのモーションを停止する
        this._motionManager?.stopAllMotions?.();

        this._updating = false;
        this._initialized = true;

        this.createRenderer();
        this.setupTextures();
        this.getRenderer().startUp(this._subdelegate.getGlManager().getGl());
      }
    };
  }

  /**
   * テクスチャユニットにテクスチャをロードする
   */
  private setupTextures(): void {
    // iPhoneでのアルファ品質向上のためTypescriptではpremultipliedAlphaを採用
    const usePremultiply = true;

    if (this._state == LoadStep.LoadTexture) {
      // テクスチャ読み込み用
      const textureCount: number = this._modelSetting.getTextureCount();

      for (
        let modelTextureNumber = 0;
        modelTextureNumber < textureCount;
        modelTextureNumber++
      ) {
        // テクスチャ名が空文字だった場合はロード・バインド処理をスキップ
        if (this._modelSetting.getTextureFileName(modelTextureNumber) == '') {
          console.log('getTextureFileName null');
          continue;
        }

        // WebGLのテクスチャユニットにテクスチャをロードする
        let texturePath =
          this._modelSetting.getTextureFileName(modelTextureNumber);
        texturePath = this._modelHomeDir + texturePath;

        // ロード完了時に呼び出すコールバック関数
        const onLoad = (textureInfo: TextureInfo): void => {
          this.getRenderer().bindTexture(modelTextureNumber, textureInfo.id);

          this._textureCount++;

          if (this._textureCount >= textureCount) {
            // ロード完了
            this._state = LoadStep.CompleteSetup;
          }
        };

        // 読み込み
        this._subdelegate
          .getTextureManager()
          .createTextureFromPngFile(texturePath, usePremultiply, onLoad);
        this.getRenderer().setIsPremultipliedAlpha(usePremultiply);
      }

      this._state = LoadStep.WaitLoadTexture;
    }
  }

  /**
   * レンダラを再構築する
   */
  public reloadRenderer(): void {
    this.deleteRenderer();
    this.createRenderer();
    this.setupTextures();
  }

  /**
   * 更新
   */
  public update(): void {
    if (this._state != LoadStep.CompleteSetup) return;

    const deltaTimeSeconds: number = LAppPal.getDeltaTime();
    this._userTimeSeconds += deltaTimeSeconds;

    this._dragManager.update(deltaTimeSeconds);
    this._dragX = this._dragManager.getX();
    this._dragY = this._dragManager.getY();

    // モーションによるパラメータ更新の有無
    let motionUpdated = false;

    //--------------------------------------------------------------------------
    this._model.loadParameters(); // 前回セーブされた状態をロード
    if (this._motionManager.isFinished()) {
      // モーションの再生がない場合、待機モーションの中からランダムで再生する
      this.startRandomMotion(
        LAppDefine.MotionGroupIdle,
        LAppDefine.PriorityIdle
      );
    } else {
      motionUpdated = this._motionManager.updateMotion(
        this._model,
        deltaTimeSeconds
      ); // モーションを更新
    }
    this._model.saveParameters(); // 状態を保存

    // SoulWeave S2-10：叠加程序化表情（在参数保存之后，确保不被覆盖）
    this.applyProceduralExpression(deltaTimeSeconds);
    //--------------------------------------------------------------------------

    // まばたき
    if (!motionUpdated) {
      if (this._eyeBlink != null) {
        // メインモーションの更新がないとき
        this._eyeBlink.updateParameters(this._model, deltaTimeSeconds); // 目パチ
      }
    }

    if (this._expressionManager != null) {
      this._expressionManager.updateMotion(this._model, deltaTimeSeconds); // 表情でパラメータ更新（相対変化）
    }

    // ドラッグによる変化
    // ドラッグによる顔の向きの調整
    this._model.addParameterValueById(this._idParamAngleX, this._dragX * 30); // -30から30の値を加える
    this._model.addParameterValueById(this._idParamAngleY, this._dragY * 30);
    this._model.addParameterValueById(
      this._idParamAngleZ,
      this._dragX * this._dragY * -30
    );

    // ドラッグによる体の向きの調整
    this._model.addParameterValueById(
      this._idParamBodyAngleX,
      this._dragX * 10
    ); // -10から10の値を加える

    // ドラッグによる目の向きの調整
    this._model.addParameterValueById(this._idParamEyeBallX, this._dragX); // -1から1の値を加える
    this._model.addParameterValueById(this._idParamEyeBallY, this._dragY);

    // 呼吸など
    if (this._breath != null) {
      this._breath.updateParameters(this._model, deltaTimeSeconds);
    }

    // 物理演算の設定
    if (this._physics != null) {
      this._physics.evaluate(this._model, deltaTimeSeconds);
    }

    // リップシンクの設定
    if (this._lipsync) {
      let value = 0.0; // リアルタイムでリップシンクを行う場合、システムから音量を取得して、0~1の範囲で値を入力します。

      this._wavFileHandler.update(deltaTimeSeconds);
      value = this._wavFileHandler.getRms();

      for (let i = 0; i < this._lipSyncIds.getSize(); ++i) {
        this._model.addParameterValueById(this._lipSyncIds.at(i), value, 0.8);
      }
    }

    // ポーズの設定
    if (this._pose != null) {
      this._pose.updateParameters(this._model, deltaTimeSeconds);
    }

    this._model.update();
  }

  /**
   * 引数で指定したモーションの再生を開始する
   * @param group モーショングループ名
   * @param no グループ内の番号
   * @param priority 優先度
   * @param onFinishedMotionHandler モーション再生終了時に呼び出されるコールバック関数
   * @return 開始したモーションの識別番号を返す。個別のモーションが終了したか否かを判定するisFinished()の引数で使用する。開始できない時は[-1]
   */
  public startMotion(
    group: string,
    no: number,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback,
    onBeganMotionHandler?: BeganMotionCallback
  ): CubismMotionQueueEntryHandle {
    if (priority == LAppDefine.PriorityForce) {
      this._motionManager.setReservePriority(priority);
    } else if (!this._motionManager.reserveMotion(priority)) {
      if (this._debugMode) {
        LAppPal.printMessage("[APP]can't start motion.");
      }
      return InvalidMotionQueueEntryHandleValue;
    }

    const motionFileName = this._modelSetting.getMotionFileName(group, no);

    // ex) idle_0
    const name = `${group}_${no}`;
    let motion: CubismMotion = this._motions.getValue(name) as CubismMotion;
    let autoDelete = false;

    if (motion == null) {
      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${motionFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then(arrayBuffer => {
          motion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            null,
            onFinishedMotionHandler,
            onBeganMotionHandler,
            this._modelSetting,
            group,
            no
          );

          if (motion == null) {
            return;
          }

          motion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);
          autoDelete = true; // 終了時にメモリから削除
        });
    } else {
      motion.setBeganMotionHandler(onBeganMotionHandler);
      motion.setFinishedMotionHandler(onFinishedMotionHandler);
    }

    //voice
    const voice = this._modelSetting.getMotionSoundFileName(group, no);
    if (voice.localeCompare('') != 0) {
      let path = voice;
      path = this._modelHomeDir + path;
      this._wavFileHandler.start(path);
    }

    if (this._debugMode) {
      LAppPal.printMessage(`[APP]start motion: [${group}_${no}`);
    }
    return this._motionManager.startMotionPriority(
      motion,
      autoDelete,
      priority
    );
  }

  /**
   * ランダムに選ばれたモーションの再生を開始する。
   * @param group モーショングループ名
   * @param priority 優先度
   * @param onFinishedMotionHandler モーション再生終了時に呼び出されるコールバック関数
   * @return 開始したモーションの識別番号を返す。個別のモーションが終了したか否かを判定するisFinished()の引数で使用する。開始できない時は[-1]
   */
  public startRandomMotion(
    group: string,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback,
    onBeganMotionHandler?: BeganMotionCallback
  ): CubismMotionQueueEntryHandle {
    if (this._modelSetting.getMotionCount(group) == 0) {
      return InvalidMotionQueueEntryHandleValue;
    }

    const no: number = Math.floor(
      Math.random() * this._modelSetting.getMotionCount(group)
    );

    return this.startMotion(
      group,
      no,
      priority,
      onFinishedMotionHandler,
      onBeganMotionHandler
    );
  }

  /**
   * 引数で指定した表情モーションをセットする
   *
   * @param expressionId 表情モーションのID
   */
  public setExpression(expressionId: string): void {
    const motion: ACubismMotion = this._expressions.getValue(expressionId);

    if (this._debugMode) {
      LAppPal.printMessage(`[APP]expression: [${expressionId}]`);
    }

    if (motion != null) {
      this._expressionManager.startMotion(motion, false);
    } else {
      if (this._debugMode) {
        LAppPal.printMessage(`[APP]expression[${expressionId}] is null`);
      }
    }
  }

  /**
   * SoulWeave S2-9：列出该模型可用的表情名
   */
  /**
   * SoulWeave S2-11：列出该模型引用的纹理文件全路径。
   *
   * 关键点：纹理管理器**按 fileName 缓存** WebGLTexture。
   * 若只 deleteTexture 而不清缓存，重新加载同一模型会命中缓存拿到失效句柄
   * —— 这就是 S2-8 里 Hiyori 渲染成纯黑剪影的根因。
   * 因此释放时必须走 textureManager.releaseTextureByFilePath(path)（同时删纹理与缓存项）。
   */
  public getTextureFilePaths(): string[] {
    const out: string[] = [];
    if (!this._modelSetting) return out;
    const n = this._modelSetting.getTextureCount();
    for (let i = 0; i < n; i++) {
      const rel = this._modelSetting.getTextureFileName(i);
      if (!rel) continue;
      out.push(this._modelHomeDir + rel);
    }
    return out;
  }

  /**
   * SoulWeave S2-12：释放裁剪遮罩用的 GPU 资源。
   *
   * 【为什么需要】CubismRenderer_WebGL.release() 只删 3 个 buffer 并把 _textures 置 null，
   * **从不删除 _maskColorBuffers（WebGLTexture）与 _maskRenderTextures（WebGLFramebuffer）**。
   * 这两个是每个 renderer 实例在 initialize() 里创建的公开字段，
   * 模型切换时整实例丢弃 → 每轮泄漏 2~3 个纹理 + 2~3 个帧缓冲。
   *
   * 必须在 model.release() 之前调用（release 会清空 _clippingManager）。
   */
  /**
   * SoulWeave S2-18（方案 B）：**只收集不删除**遮罩资源。
   *
   * 之前直接在卸载时 deleteTexture/deleteFramebuffer 会破坏渲染
   * （角色变暗/黑，mean 48→38、非暗 14.9%→0%）——很可能是删除时
   * 该 FBO 仍在本帧/上一帧的 GL 命令流中被引用。
   *
   * 现在改为：把资源交给调用方排队，等若干帧之后再删。
   */
  public collectMaskBuffers(): { textures: WebGLTexture[]; framebuffers: WebGLFramebuffer[]; gl: WebGLRenderingContext | null } {
    const textures: WebGLTexture[] = [];
    const framebuffers: WebGLFramebuffer[] = [];
    let gl: WebGLRenderingContext | null = null;
    try {
      const renderer: any = this.getRenderer();
      if (!renderer) return { textures, framebuffers, gl };
      gl = (this._subdelegate as any)?.getGlManager?.()?.getGl?.() ?? renderer.gl ?? null;

      const owners: any[] = [];
      owners.push(renderer);
      if (renderer._clippingManager) owners.push(renderer._clippingManager);

      for (const owner of owners) {
        if (owner._maskTexture !== undefined) owner._maskTexture = null;
        if (owner._currentMaskRenderTexture !== undefined) owner._currentMaskRenderTexture = null;

        const mb = owner._maskColorBuffers;
        if (mb && typeof mb.getSize === 'function') {
          for (let i = 0; i < mb.getSize(); i++) {
            const t = mb.at(i);
            if (t) textures.push(t);
          }
          if (typeof mb.clear === 'function') mb.clear();
        }
        const mf = owner._maskRenderTextures;
        if (mf && typeof mf.getSize === 'function') {
          for (let i = 0; i < mf.getSize(); i++) {
            const f = mf.at(i);
            if (f) framebuffers.push(f);
          }
          if (typeof mf.clear === 'function') mf.clear();
        }
      }
    } catch (e) { /* 尽力而为 */ }
    return { textures, framebuffers, gl };
  }

  public releaseMaskBuffers(): { textures: number; framebuffers: number } {
    let textures = 0;
    let framebuffers = 0;

    // 【S2-15 决策】默认关闭。
    // 归因已成功（栈证明创建方是 CubismClippingManager_WebGL.getMaskRenderTexture），
    // 直接删除确实把泄漏从 24 降到 3（净增量等于当前模型存活资源），
    // **但会导致渲染异常**（删除后角色画面变暗/黑，mean 48→38、非暗 14.9%→0%）。
    // 即使加了 _maskTexture 复位与 bindFramebuffer(null) 解绑仍未恢复。
    // 结论：遮罩 FBO 的生命周期比"模型卸载"更复杂，
    // 需要在渲染管线层面（而非卸载时）安全回收，属独立任务。
    // 为避免以渲染正确性换取内存指标，此处默认关闭。
    if (!RELEASE_MASK_BUFFERS_ON_UNLOAD) return { textures, framebuffers };
    try {
      const renderer: any = this.getRenderer();
      if (!renderer) return { textures, framebuffers };
      // gl 优先从 subdelegate 的 GL 管理器取（一定有效），再退回 renderer.gl
      let gl: WebGLRenderingContext | undefined =
        (this._subdelegate as any)?.getGlManager?.()?.getGl?.() ?? renderer.gl;
      if (!gl) return { textures, framebuffers };

      // 【S2-15 归因结论】帧缓冲与遮罩纹理实际由 CubismClippingManager_WebGL 创建，
      // 挂在 **clippingManager._maskRenderTextures / _maskColorBuffers** 上
      // （renderer 上也有同名字段，但那是另一套，之前读错对象所以一直是 0）。
      // 归因栈：createFramebuffer ← CubismClippingManager_WebGL.getMaskRenderTexture
      //          ← setupClippingContext
      // 基类 release() 只把数组置空，不 delete 对象 → 每模型泄漏 1 个 fb。
      const owners: any[] = [];
      if (renderer) owners.push(renderer);
      if (renderer && renderer._clippingManager) owners.push(renderer._clippingManager);

      for (const owner of owners) {
        // 复位引用：否则 getMaskRenderTexture() 会早退并复用已被删除的句柄 → 渲染变黑
        if (owner._maskTexture !== undefined) owner._maskTexture = null;
        if (owner._currentMaskRenderTexture !== undefined) owner._currentMaskRenderTexture = null;

        const mb = owner._maskColorBuffers;
        if (mb && typeof mb.getSize === 'function') {
          for (let i = 0; i < mb.getSize(); i++) {
            const t = mb.at(i);
            if (t) { try { gl.deleteTexture(t); textures++; } catch (e) { /* ignore */ } }
          }
          if (typeof mb.clear === 'function') mb.clear();
        }
        const mf = owner._maskRenderTextures;
        if (mf && typeof mf.getSize === 'function') {
          for (let i = 0; i < mf.getSize(); i++) {
            const f = mf.at(i);
            if (f) { try { gl.deleteFramebuffer(f); framebuffers++; } catch (e) { /* ignore */ } }
          }
          if (typeof mf.clear === 'function') mf.clear();
        }
      }

      // 关键：删除后把绑定恢复到默认，否则本帧后续绘制会写入已删除的 FBO → 黑屏
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
      } catch (e) { /* ignore */ }
    } catch (e) { /* 尽力而为，不阻断卸载 */ }
    return { textures, framebuffers };
  }

  /** SoulWeave S2-10：程序化表情名称列表 */
  public getProceduralExpressionNames(): string[] {
    return Object.keys(PROC_EXPRESSIONS);
  }

  /** SoulWeave S2-10：启动程序化表情（dur 秒内淡入并保持） */
  public startProceduralExpression(name: string, dur = 0.28): boolean {
    const params = PROC_EXPRESSIONS[name];
    if (!params) return false;
    this._procExpr = { name, params, t: 0, dur };
    return true;
  }

  /** SoulWeave S2-10：清除程序化表情（回到中性） */
  public clearProceduralExpression(): void {
    this._procExpr = null;
  }

  /**
   * SoulWeave S2-10：把程序化表情叠加到模型参数上。
   * 在 update() 里、模型参数保存之后调用，权重按淡入包络衰减。
   * 缺失参数自动跳过（不同模型参数集不同）。
   */
  private applyProceduralExpression(deltaTimeSeconds: number): void {
    if (!this._procExpr || !this._model) return;
    const e = this._procExpr;
    e.t += deltaTimeSeconds;
    const w = e.dur > 0 ? Math.min(1, e.t / e.dur) : 1;
    const idManager = typeof CubismFramework !== 'undefined' ? CubismFramework.getIdManager() : null;
    if (!idManager) return;
    for (const [pid, value] of e.params) {
      try {
        const id = idManager.getId(pid);
        const idx = this._model.getParameterIndex(id);
        if (idx >= 0) this._model.addParameterValueById(id, value, w);
      } catch (err) { /* 参数不存在则跳过 */ }
    }
  }

  public getExpressionNames(): string[] {
    const out: string[] = [];
    if (!this._expressions) return out;
    for (let i = 0; i < this._expressions.getSize(); i++) {
      out.push(this._expressions._keyValues[i].first);
    }
    return out;
  }

  /**
   * SoulWeave S2-9：列出该模型的动作组与每组动作数
   */
  public getMotionGroups(): Array<{ name: string; count: number }> {
    const out: Array<{ name: string; count: number }> = [];
    if (!this._modelSetting) return out;
    const n = this._modelSetting.getMotionGroupCount();
    for (let i = 0; i < n; i++) {
      // getMotionGroupName 返回 string（不是 csmString）
      const name: string = this._modelSetting.getMotionGroupName(i);
      out.push({ name, count: this._modelSetting.getMotionCount(name) });
    }
    return out;
  }

  /**
   * SoulWeave S2-9：播放指定组的第 index 个动作（越界返回 false）
   */
  public playMotionAt(group: string, index: number): boolean {
    if (!this._modelSetting) return false;
    const total = this._modelSetting.getMotionCount(group);
    if (total <= 0 || index < 0 || index >= total) return false;
    const key = group + '_' + index;
    const motion = this._motions.getValue(key);
    if (motion == null) return false;
    // CubismMotionQueueManager.startMotion(motion, autoDelete)
    // 队列管理器会自动把已有动作设为淡出，因此这里直接启动即可。
    this._motionManager.startMotion(motion, false);
    return true;
  }

  /**
   * ランダムに選ばれた表情モーションをセットする
   */
  public setRandomExpression(): void {
    if (this._expressions.getSize() == 0) {
      return;
    }

    const no: number = Math.floor(Math.random() * this._expressions.getSize());

    for (let i = 0; i < this._expressions.getSize(); i++) {
      if (i == no) {
        const name: string = this._expressions._keyValues[i].first;
        this.setExpression(name);
        return;
      }
    }
  }

  /**
   * イベントの発火を受け取る
   */
  public motionEventFired(eventValue: csmString): void {
    CubismLogInfo('{0} is fired on LAppModel!!', eventValue.s);
  }

  /**
   * 当たり判定テスト
   * 指定ＩＤの頂点リストから矩形を計算し、座標をが矩形範囲内か判定する。
   *
   * @param hitArenaName  当たり判定をテストする対象のID
   * @param x             判定を行うX座標
   * @param y             判定を行うY座標
   */
  public hitTest(hitArenaName: string, x: number, y: number): boolean {
    // 透明時は当たり判定無し。
    if (this._opacity < 1) {
      return false;
    }

    const count: number = this._modelSetting.getHitAreasCount();

    for (let i = 0; i < count; i++) {
      if (this._modelSetting.getHitAreaName(i) == hitArenaName) {
        const drawId: CubismIdHandle = this._modelSetting.getHitAreaId(i);
        return this.isHit(drawId, x, y);
      }
    }

    return false;
  }

  /**
   * モーションデータをグループ名から一括でロードする。
   * モーションデータの名前は内部でModelSettingから取得する。
   *
   * @param group モーションデータのグループ名
   */
  public preLoadMotionGroup(group: string): void {
    for (let i = 0; i < this._modelSetting.getMotionCount(group); i++) {
      const motionFileName = this._modelSetting.getMotionFileName(group, i);

      // ex) idle_0
      const name = `${group}_${i}`;
      if (this._debugMode) {
        LAppPal.printMessage(
          `[APP]load motion: ${motionFileName} => [${name}]`
        );
      }

      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${motionFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then(arrayBuffer => {
          const tmpMotion: CubismMotion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            name,
            null,
            null,
            this._modelSetting,
            group,
            i
          );

          if (tmpMotion != null) {
            tmpMotion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);

            if (this._motions.getValue(name) != null) {
              ACubismMotion.delete(this._motions.getValue(name));
            }

            this._motions.setValue(name, tmpMotion);

            this._motionCount++;
            if (this._motionCount >= this._allMotionCount) {
              this._state = LoadStep.LoadTexture;

              // 全てのモーションを停止する
              this._motionManager?.stopAllMotions?.();

              this._updating = false;
              this._initialized = true;

              this.createRenderer();
              this.setupTextures();
              this.getRenderer().startUp(
                this._subdelegate.getGlManager().getGl()
              );
            }
          } else {
            // loadMotionできなかった場合はモーションの総数がずれるので1つ減らす
            this._allMotionCount--;
          }
        });
    }
  }

  /**
   * SoulWeave S2-2：释放该模型绑定的 WebGL 纹理。
   *
   * 【为什么需要】CubismRenderer_WebGL.release() 只做了
   *   gl.deleteBuffer(vertex/uv/index) + this._textures = null
   * —— **从不调用 gl.deleteTexture**。
   * 实测：12 轮模型切换后 23 个纹理创建、0 个删除。
   * 这里用公开的 getBindedTextures() 取出纹理并显式释放，不改 vendor 代码。
   *
   * @returns 实际释放的纹理数量
   */
  public releaseTextures(): number {
    const renderer: any = this.getRenderer();
    if (!renderer) return 0;
    const gl: WebGLRenderingContext | undefined = renderer.gl || renderer._gl;
    if (!gl) return 0;
    const texs = renderer.getBindedTextures ? renderer.getBindedTextures() : null;
    if (!texs || !texs._keyValues) return 0;

    let n = 0;
    const pairs = texs._keyValues;
    for (let i = 0; i < pairs.length; i++) {
      const tex = pairs[i] && pairs[i].second;
      if (tex) {
        try { gl.deleteTexture(tex); n++; } catch (e) { /* 已失效的纹理忽略 */ }
      }
    }
    if (typeof texs.clear === 'function') texs.clear();
    return n;
  }

  /**
   * すべてのモーションデータを解放する。
   */
  public releaseMotions(): void {
    this._motions.clear();
  }

  /**
   * 全ての表情データを解放する。
   */
  public releaseExpressions(): void {
    this._expressions.clear();
  }

  /**
   * モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
   */
  public doDraw(): void {
    if (this._model == null) return;

    // キャンバスサイズを渡す
    const canvas = this._subdelegate.getCanvas();
    const viewport: number[] = [0, 0, canvas.width, canvas.height];

    this.getRenderer().setRenderState(
      this._subdelegate.getFrameBuffer(),
      viewport
    );
    this.getRenderer().drawModel();
  }

  /**
   * モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
   */
  public draw(matrix: CubismMatrix44): void {
    if (this._model == null) {
      return;
    }

    // 各読み込み終了後
    if (this._state == LoadStep.CompleteSetup) {
      matrix.multiplyByMatrix(this._modelMatrix);

      this.getRenderer().setMvpMatrix(matrix);

      this.doDraw();
    }
  }

  public async hasMocConsistencyFromFile() {
    CSM_ASSERT(this._modelSetting.getModelFileName().localeCompare(``));

    // CubismModel
    if (this._modelSetting.getModelFileName() != '') {
      const modelFileName = this._modelSetting.getModelFileName();

      const response = await fetch(`${this._modelHomeDir}${modelFileName}`);
      const arrayBuffer = await response.arrayBuffer();

      this._consistency = CubismMoc.hasMocConsistency(arrayBuffer);

      if (!this._consistency) {
        CubismLogInfo('Inconsistent MOC3.');
      } else {
        CubismLogInfo('Consistent MOC3.');
      }

      return this._consistency;
    } else {
      LAppPal.printMessage('Model data does not exist.');
    }
  }

  public setSubdelegate(subdelegate: LAppSubdelegate): void {
    this._subdelegate = subdelegate;
  }

  /**
   * コンストラクタ
   */
  public constructor() {
    super();

    this._modelSetting = null;
    this._modelHomeDir = null;
    this._userTimeSeconds = 0.0;

    this._eyeBlinkIds = new csmVector<CubismIdHandle>();
    this._lipSyncIds = new csmVector<CubismIdHandle>();

    this._motions = new csmMap<string, ACubismMotion>();
    this._expressions = new csmMap<string, ACubismMotion>();

    this._hitArea = new csmVector<csmRect>();
    this._userArea = new csmVector<csmRect>();

    this._idParamAngleX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamAngleX
    );
    this._idParamAngleY = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamAngleY
    );
    this._idParamAngleZ = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamAngleZ
    );
    this._idParamEyeBallX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamEyeBallX
    );
    this._idParamEyeBallY = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamEyeBallY
    );
    this._idParamBodyAngleX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamBodyAngleX
    );

    if (LAppDefine.MOCConsistencyValidationEnable) {
      this._mocConsistency = true;
    }

    this._state = LoadStep.LoadAssets;
    this._expressionCount = 0;
    this._textureCount = 0;
    this._motionCount = 0;
    this._allMotionCount = 0;
    this._wavFileHandler = new LAppWavFileHandler();
    this._consistency = false;
  }

  private _subdelegate: LAppSubdelegate;

  _modelSetting: ICubismModelSetting; // モデルセッティング情報
  _modelHomeDir: string; // モデルセッティングが置かれたディレクトリ
  _userTimeSeconds: number; // デルタ時間の積算値[秒]

  _eyeBlinkIds: csmVector<CubismIdHandle>; // モデルに設定された瞬き機能用パラメータID
  _lipSyncIds: csmVector<CubismIdHandle>; // モデルに設定されたリップシンク機能用パラメータID

  _motions: csmMap<string, ACubismMotion>; // 読み込まれているモーションのリスト
  _expressions: csmMap<string, ACubismMotion>; // 読み込まれている表情のリスト

  _hitArea: csmVector<csmRect>;
  _userArea: csmVector<csmRect>;

  _idParamAngleX: CubismIdHandle; // パラメータID: ParamAngleX
  _idParamAngleY: CubismIdHandle; // パラメータID: ParamAngleY
  _idParamAngleZ: CubismIdHandle; // パラメータID: ParamAngleZ
  _idParamEyeBallX: CubismIdHandle; // パラメータID: ParamEyeBallX
  _idParamEyeBallY: CubismIdHandle; // パラメータID: ParamEyeBAllY
  _idParamBodyAngleX: CubismIdHandle; // パラメータID: ParamBodyAngleX

  _state: LoadStep; // 現在のステータス管理用
  _expressionCount: number; // 表情データカウント
  _textureCount: number; // テクスチャカウント
  _motionCount: number; // モーションデータカウント
  _allMotionCount: number; // モーション総数
  _wavFileHandler: LAppWavFileHandler; //wavファイルハンドラ
  _consistency: boolean; // MOC3一貫性チェック管理用
}
