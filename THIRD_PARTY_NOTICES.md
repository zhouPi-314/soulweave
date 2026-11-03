# 第三方组件许可声明

> 最后更新：2026-10-26

本文档列出 SoulWeave 使用或依赖的第三方组件及其许可条款。

---

## Live2D Cubism SDK

### 组件构成

| 部分 | 许可 | 位置 |
|---|---|---|
| **Cubism Core** | Live2D Proprietary Software License | `live2dcubismcore.{js,min.js,d.ts}` |
| **Cubism Framework** | Live2D Open Software License | TypeScript 源码 |
| **样例模型** | Free Material License | 仅开发测试，不随产品分发 |

### 再分发权限

根据 SDK 内 `Core/RedistributableFiles.txt`，以下文件**明确允许再分发**：

```text
live2dcubismcore.d.ts
live2dcubismcore.js
live2dcubismcore.min.js
```

### 商业使用条款

> All **business** users must obtain a Cubism SDK Release License.
> "Business" means an entity with the annual gross revenue more than
> ten million (10,000,000) JPY for the most recent fiscal year.

**含义**：

| 情况 | 是否需要 Release License |
|---|---|
| 个人使用 / 非商业 | 否 |
| 年营收 < 1000 万日元（约 50 万人民币） | 否 |
| 年营收 ≥ 1000 万日元 | **是**（需向 Live2D 申请） |

官方链接：https://www.live2d.com/en/download/cubism-sdk/release-license/

### 限制

- ❌ 不得修改 Cubism Core 本身
- ❌ 不得使用官方样例模型（Hiyori/Haru 等）作为产品角色
  — 样例模型有「不得修改设计」等条款

---

## NapCat（不包含在本项目中）

**SoulWeave 不包含、不分发 NapCat。**

用户需自行从官方渠道获取：https://github.com/NapNeko/NapCatQQ

### 许可要点

| 条款 | 内容 |
|---|---|
| 再分发 | 允许，但须附完整许可全文 |
| 修改 | 修改版不得公开 |
| 商业使用 | **禁止** |

完整许可：https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE

---

## Electron

- 许可：MIT
- 版本：45.0.0
- 包含 Chromium（BSD 系）与 Node.js（MIT）

---

## 其他依赖

运行 `npm run licenses` 生成完整依赖清单（待实现）。

### 运行时原生依赖（S3 期间新增）

| 依赖 | 版本 | 用途 | 许可 | 分发方式 |
|---|---|---|---|---|
| `onnxruntime-node` | 见 package.json | Kokoro 语音模型推理 | **MIT** | npm 依赖，随应用分发 |
| `koffi` | 3.3.5 | FFI 调用 espeak-ng.dll 做中文音素化 | **MIT** | npm 依赖，随应用分发 |

> 说明：两者均为 MIT 许可，允许再分发。
> **不随应用分发**的组件见下节「外部组件」。

### 外部组件（不随应用分发）

以下组件由用户自行从官方渠道获取，应用只做「引导 + 路径配置」，不代下载、不代分发：

| 组件 | 许可 | 为什么不分发 |
|---|---|---|
| **espeak-ng**（数据与 DLL） | **GPL-3.0** | 强著佐权；以独立子进程调用（聚合），不构成衍生作品，但随包分发会触发全部义务 |
| **Piper**（引擎二进制） | MIT | 引擎可分发，但中文音色模型另有条款，当前不分发 |
| **Kokoro 模型**（.onnx / .bin） | Apache-2.0 | 体积大（约 340 MB），按需下载更合理 |
| **GPT-SoVITS / CosyVoice** | MIT / Apache-2.0 | 数 GB 运行时，通过本地 HTTP 服务对接 |

> 若将来决定随包分发 espeak-ng，**必须**先完成 GPL-3.0 义务评估并取得负责人批准。

---

## 待补充

- [ ] 角色模型的许可来源（自制 / 购买 / 授权）
- [ ] 音色资源的许可
- [ ] 字体许可
- [ ] 图标许可（V1.7 D59.08）