# ADR-3｜进程边界与角色隔离

> **状态**：已采纳｜**日期**：2026-11-03

## 背景

开发环境与角色运行时必须严格隔离；不同角色的记忆与运行配置相互隔离；后台服务独立于桌面渲染层。

## 现状事实

| 组件 | 形态 | 隔离能力 |
|---|---|---|
| DSH Harness | Electron 44.7 + Node | 支持独立 profile、独立工作目录、独立凭据 |
| NapCat | Electron 打包的 QQ | 独立进程，端口 6099 |
| PostgreSQL | Windows 服务 | 独立进程，端口 5432 |

## 决策

采用**三层进程模型**：

```text
┌─────────────────────────────────────────────┐
│  Desktop (Electron 渲染进程)                 │
│  Live2D / Voice UI / 12 模块界面             │
└──────────────────┬──────────────────────────┘
                   │ IPC (contextBridge)
┌──────────────────▼──────────────────────────┐
│  Core (Electron 主进程 / Node)               │
│  权限引擎 / 任务状态机 / 记忆 / 调度          │
└────┬──────────────┬──────────────┬──────────┘
     │              │              │
┌────▼─────┐  ┌─────▼──────┐  ┌───▼────────┐
│ 本地角色   │  │ 云端角色    │  │ QQ Adapter │
│ DSH SDK  │  │ HTTP API   │  │ OneBot WS  │
│ 子进程    │  │ 进程内      │  │ 独立进程    │
└──────────┘  └────────────┘  └────────────┘
     │
┌────▼──────────────────────────────────────┐
│  PostgreSQL (Windows 服务)                 │
└───────────────────────────────────────────┘
```

## 关键决策

### 1. 本地角色使用独立 DSH SDK profile

```yaml
# 本地角色运行时配置（独立于开发 DSH）
- name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: false
```

启动：`dsh --profile sdk`，通过 stdio JSON-RPC 通信。

**为什么不用 headless**：headless 一次性退出，不支持 `session/resume`。

**为什么不用 ACP**：ACP 面向「外部 agent 驱动」，功能更全但更重。SDK 足够。

### 2. 云端角色使用进程内 HTTP 客户端

云端 API 无状态，不需要独立进程。用 Node 的 fetch，连接池复用。

### 3. QQ Adapter 独立进程

NapCat 是独立 Electron 应用，通过 OneBot v11 WebSocket 连接。SoulWeave 侧写一个 **WS 客户端**，不做协议转换的中间层。

## 隔离要求

| 边界 | 要求 | 实现 |
|---|---|---|
| 开发 DSH ↔ 本地角色 Runtime | 不能读开发会话/凭据/源码 | 独立 `config dir` + 独立 `working dir` |
| 本地角色 ↔ 云端角色 | 私有记忆隔离 | 数据库 `owner_character` 字段 + 检索前置过滤 |
| Core ↔ Desktop | 渲染进程不能直接访问文件系统 | `contextIsolation: true` + `nodeIntegration: false` |
| QQ ↔ Core | QQ 凭据不对模型暴露 | 凭据只在 Adapter 进程内存 |

## DSH SDK 的两个硬约束【事实】

从 `dsh-sdk-protocol` README：

| 约束 | 影响 | 缓解 |
|---|---|---|
| **无取消方法** | 客户端放弃轮次只能关进程 | 本地角色的「打断」在 Core 层关闭子进程并重启 |
| **无版本协商** | `serverInfo.version` 固定 `0.0.1` | 锁定 DSH 版本，升级前回归测试 |

## 参考

- `dsh-sdk-protocol/README.zh.md`
- `dsh-acp/README.zh.md`
- `02` §2（建议逻辑组件）、§V1.1（多角色隔离架构）
