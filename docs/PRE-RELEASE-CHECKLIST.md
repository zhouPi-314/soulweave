# PRE-RELEASE-CHECKLIST（Release Blocker）

> 生成时间：2026-10-29
> 状态：以下各项**当前全部是开发期配置**，打包发布前必须逐项处理。

---

## 1. 语音组件路径（开发期绝对路径）

| 项 | 当前值 | 必须改成 |
|---|---|---|
| piper | `<workspace>\04_test-assets\ab-test\piper` | `<安装目录>\vendor-voice\piper` 或 `<userData>\components\piper` |
| espeak | `<workspace>\04_test-assets\ab-test\piper` | 同上（espeak-ng-data 在 piper 目录内） |
| kokoro | `<workspace>\04_test-assets\ab-test\kokoro` | `<安装目录>\vendor-voice\kokoro` |

**存放位置**：`<userData>\voice-components.json`

**代码已支持的位置**：`voice-components.ts` 的 `candidatePaths()` 已包含
`vendor-voice\<id>`、`resources\<id>`、`components\<id>`，只需把文件搬过去。

**检查方式**：设置中心 → 语音 → 组件状态应显示「已就绪」。

---

## 2. 向量模型路径（开发期绝对路径）

| 项 | 当前值 | 必须改成 |
|---|---|---|
| bge-small-zh | `<workspace>\04_test-assets\models\bge-small-zh` | `<安装目录>\resources\embedding\bge-small-zh` 或首启下载到 `<userData>\models\` |

**存放位置**：`<userData>\embedding-config.json`

**代码标记**：`src/main/index.ts` 里的 `DEV_EMBEDDING_DIR`。

**运行时会自检**：`embedding:status` 返回 `releaseBlocked: true` 表示
「打包版仍在用开发期绝对路径」—— 这是错误状态，必须修。

---

## 3. 开发测试后端（免费网关）

**已用 `!app.isPackaged` 硬门禁。** 打包后：
- 「对话后端」区块不渲染
- `agent:gateway:*` 调用被拒绝

**无需额外处理**，但发布前应确认门禁生效（可用 `app.isPackaged` 为 true 的构建验证一次）。

---

## 4. 数据库凭证

| 项 | 说明 |
|---|---|
| 存储 | safeStorage 加密（`<userData>\db-connection.json`） |
| 发布要求 | **不能预置任何默认密码**；必须是用户在引导页填写 |
| 现状 | ✅ 已符合（无默认密码） |

---

## 5. 首次启动引导

| 项 | 状态 |
|---|---|
| 语音组件缺失提示 | 已有（组件状态 UI） |
| 向量模型缺失提示 | 待做（`embedding:status` 已返回 missing 列表） |
| 数据库未配置提示 | 已有 |

---

## 检查脚本

发布打包后跑一次：

```text
1. 打开设置中心 → 语音 → 三个组件应为「已就绪」
2. 设置中心 → 角色 → 不应出现「对话后端」区块
3. 设置中心 → 记忆 → 记忆中心应能读取（数据库已配）
4. 控制台不应出现 releaseBlocked 相关报错
```
