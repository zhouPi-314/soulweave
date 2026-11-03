# ADR-1｜语言栈选择：TypeScript 主导

> **状态**：提议（待负责人批准）｜**日期**：2026-10-26｜**阶段**：S1

## 背景

S0 原报告曾建议「Python 复用 PAA + TypeScript 做 Desktop」。经负责人实际使用反馈与 T5 方向修正，该结论不再成立。需重新论证。

## 候选方案

| 方案 | 描述 |
|---|---|
| **A. TS 主导** | Core、Desktop、QQ Adapter 全部 TypeScript |
| **B. TS + Python** | Desktop 用 TS，Core 用 Python（FastAPI） |
| **C. Python 主导** | 沿用 PAA 架构 |

## 决策

**采用方案 A：TypeScript 主导。** Python 仅在「有实证收益」时作为**独立侧车进程**引入，不进入主运行时。

## 理由

### 1. 与 AIRI 技术栈一致【事实】

AIRI 是纯 TypeScript monorepo（v0.12.0，57 packages / 6 apps）。复用其 Live2D 组件（10,737 行）时，同语言可**直接阅读、按需复制、无需重写**。

### 2. 与 DSH 同栈【事实】

DSH Harness 是 Electron + Node。SoulWeave 的 Core 与 DSH SDK 客户端同为 Node，进程间通信无序列化损耗。

### 3. 本机工具链已就绪【事实】

| 工具 | 版本 | 状态 |
|---|---|---|
| Node | 24.16.0 | ✅ 已装 |
| pnpm | 11.28.5 | ✅ 已装 |
| TypeScript | 5.x | ✅ 随项目 |

Python 虽也有 3.13/3.14，但若采用方案 B，需维护两套依赖、两套打包、两套调试。

### 4. 单运行时打包更简单【推断】

Electron 打包时，Node 运行时已内置。若引入 Python，需额外内嵌解释器（约 100–400 MB）并处理路径、编码、子进程管理。

### 5. DSH 官方提供双语言 SDK【事实】

`dsh-sdk-protocol` README 明确：客户端有 TypeScript 版与 **Python 版**。因此**DSH 接入不构成语言选择的决定因素**——两者都能接。

## 后果

### 正面

- 单一语言，维护成本低
- 与 AIRI / DSH 复用成本最低
- 打包体积可控

### 负面与缓解

| 风险 | 缓解 |
|---|---|
| ML 生态弱于 Python | 在线 TTS/ASR 优先（T4）；本地模型做成独立可执行侧车（Rust/C++ 或打包好的 Python） |
| 某些 SDK 只有 Python 版 | 作为独立进程调用，通过 stdio/HTTP 通信 |

## 待验证

- [ ] 在线 TTS/ASR 的 Node SDK 覆盖率（S3 前）
- [ ] 若必须用 Python 侧车，进程管理开销实测（S3）

## 参考

- `02_SoulWeave_技术架构与资源优化设计.md` §3（Backend：TypeScript/Node 优先）
- 调整指令 T5
- S0 补充报告 §5