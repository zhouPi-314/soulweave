# ADR-5｜QQ 接入：NapCat 独立安装 + 连接引导

> **状态**：提议（待负责人批准）｜**日期**：2026-10-26｜**阶段**：S1

## 背景

V1.7 要求 QQ 作为重要社交入口。S0 曾把 NapCat 许可列为阻塞项。

## 许可事实（已核实原文）【事实】

`NapNeko/NapCatQQ/LICENSE` 原文要点：

| 条款 | 内容 |
|---|---|
| 使用与复制 | 未经作者明确许可，禁止使用、复制、修改、分发 |
| 再分发 | **允许**，但须附完整许可全文 + 标明来源与版权 |
| 修改 | 允许小幅修改用于再分发，但**修改版不得公开** |
| 商业使用 | **禁止** |
| 其他权利 | 须向作者申请 |

**GitHub API 标注**：`NOASSERTION` / `Other`。

## 决策

**NapCat 不打包进 SoulWeave 发行版，采用「独立安装 + 连接引导」。**

## 三种方案对比

| 方案 | 合规 | 用户体验 | 决策 |
|---|---|---|---|
| **A. 打包进安装器** | ❌ 禁止商用 + 须附全文，风险高 | 最好 | ❌ 否决 |
| **B. 独立安装 + 引导** | ✅ 用户自行获取 | 需用户操作 | ✅ **采用** |
| **C. 换适配器** | ⚠️ 见下 | 未知 | ❌ 暂无可用替代 |

### 为什么不用 Lagrange.Core

【事实】`LagrangeDev/Lagrange.Core` 仓库**没有任何 LICENSE 文件**。

【判断】无许可证 = 默认保留所有权利，**法律上比 NapCat 更严格**。原 S0 建议「或评估 Lagrange.Core 等替代」**应予撤销**。

## 实现方式

### 1. 首次配置向导

```text
Social Center → QQ 账号管理
  ├─ 检测本机是否已安装 NapCat
  │   ├─ 已安装 → 填入 WebSocket 地址 → 测试连接
  │   └─ 未安装 → 显示引导页
  │       ├─ 说明 NapCat 是什么
  │       ├─ 说明其许可限制（附全文链接）
  │       ├─ 提供官方下载地址（不镜像、不打包）
  │       └─ 用户自行下载安装后返回
  └─ 连接成功后 → 扫码登录（QQ 官方流程）
```

### 2. 连接检测

```ts
const candidates = [3000, 3001, 6099];
for (const port of candidates) {
  const ok = await probeOneBot('ws://127.0.0.1:' + port);
  if (ok) return { port, status: 'connected' };
}
return { status: 'not-found' };
```

### 3. 许可声明

在 SoulWeave 的 `THIRD_PARTY_NOTICES.md` 中：

```markdown
## NapCat

SoulWeave 不包含、不分发 NapCat。用户需自行从官方渠道获取。
NapCat 采用自定义「Limited Redistribution License」，
禁止商业使用，详见 https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE
```

## 对 SoulWeave 产品的影响

| 影响 | 缓解 |
|---|---|
| 用户多一步安装 | 引导页做到极简；提供图文步骤 |
| 无法保证版本一致 | 连接时检测版本，不兼容则提示 |
| QQ 风控风险 | 速率限制 + 失败退避（V1.7 已有要求） |

## 待验证

- [ ] 双 QQ 账号同时在线（S5，需登录）
- [ ] 语音消息发送（S5）
- [ ] 不同 NapCat 版本的 API 兼容性

## 参考

- S0 补充报告 §1、§3
- 06 D54（Windows 安装）、D56（组件管理）
- V1.7 Gate H（分发与供应链）