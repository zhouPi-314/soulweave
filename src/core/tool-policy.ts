/**
 * SoulWeave S9：工具调用的风险分级
 *
 * 【为什么需要这一层】
 * 需求 §7.5 写得很直白：**权限在后端强制执行，不能仅靠提示词**。
 * 以前我们只是把 DSH 的事件流转给界面，模型想用 write / pwsh 就用，
 * 唯一的约束来自 DSH 自己的审批策略 —— 那是别人的默认值，不是我们的保证。
 *
 * 现在每收到一个 tool_call，先在这里判一次：
 *   工具名 → 风险等级；参数里的路径 → 是否仍在隔离工作区内。
 * 判定结果交给 tool-grants 决定允不允许，拒绝就立刻掐断子进程。
 *
 * 本文件不碰 fs、不碰 Electron，纯函数，可单测。
 */

import path from 'node:path';

/** 风险等级，沿用需求 §7.5 的 L0–L5 编号 */
export type ToolLevel = 0 | 1 | 2 | 4 | 5;

/**
 * 已知工具 → 风险等级。
 *
 * 名字取自 DSH 各 tool 包的注册名（dsh-tool-fs / pwsh / bash / web / fs-search …）。
 * **不在表里的工具一律按 L5 处理** —— 宁可多拦一次，也不让新工具悄悄绕过。
 */
export const TOOL_LEVELS: Record<string, ToolLevel> = {
  // L0：只读，不改系统状态
  read: 0,
  read_image: 0,
  glob: 0,
  grep: 0,
  todo_write: 0,
  present: 0,
  list_subagent_models: 0,
  skill: 0,

  // L1：出站网络，但不落地
  web_search: 1,
  web_fetch: 1,

  // L2：写工作区文件
  write: 2,
  edit: 2,
  str_replace_editor: 2,

  // L4：本机执行
  pwsh: 4,
  bash: 4,
  run_code: 4,
  terminal: 4,
  // 子智能体等价于「再来一轮对话」，同样可能触碰工具
  subagent: 4,
  subagent_fork: 4,
  agent_team: 4,
};

/** 参数里可能表示路径的字段名（宁可多查几个） */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'target_file', 'cwd', 'dir', 'directory', 'source', 'destination', 'dest'];

export type ToolCallInput = Record<string, unknown> | null | undefined;

export type Classified = {
  tool: string;
  level: ToolLevel;
  /** 从参数里提取出的第一个路径（没有就是空串） */
  target: string;
  /** target 是否仍在 workspace 内。没有路径时视为 true（不适用） */
  insideWorkspace: boolean;
  /** 判定理由，写进审计与报错信息 */
  reason: string;
};

/**
 * 把相对/绝对路径解析成绝对路径，并判断是否在 workspace 内。
 * 解析失败、含空字节、逃逸出前缀，一律 false。
 */
export function isInsideWorkspace(workspace: string, p: string): boolean {
  if (!workspace || !p) return false;
  if (p.indexOf('\0') >= 0) return false;
  try {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, p);
    if (abs === root) return true;
    // Windows 下大小写不敏感
    const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    return norm(abs).startsWith(norm(root) + path.sep);
  } catch {
    return false;
  }
}

/** 从工具参数里找出第一个像路径的字符串 */
export function extractPath(input: ToolCallInput): string {
  if (!input || typeof input !== 'object') return '';
  for (const k of PATH_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 判一个 tool_call。
 *
 * @param call   事件里的 { tool, input }
 * @param ctx.workspace 隔离工作区绝对路径
 */
export function classifyToolCall(
  call: { tool?: unknown; input?: unknown },
  ctx: { workspace: string; readableRoots?: string[] }
): Classified {
  const tool = String((call && call.tool) || '').trim();
  const input = (call && call.input) as ToolCallInput;

  const known = Object.prototype.hasOwnProperty.call(TOOL_LEVELS, tool);
  let level: ToolLevel = known ? TOOL_LEVELS[tool] : 5;
  const target = extractPath(input);
  let insideWorkspace = true;
  let reason = known ? 'known tool' : 'unknown tool';

  if (!tool) {
    return { tool: '', level: 5, target, insideWorkspace: false, reason: '工具名为空' };
  }

  if (!known) {
    // 未知工具：按最高风险，且路径信息只用于展示
    return { tool, level: 5, target, insideWorkspace: target ? isInsideWorkspace(ctx.workspace, target) : false, reason: '未知工具，按最高风险处理' };
  }

  // 有路径就要检查范围。
  //
  // 【只读工具放宽一点】L0 的 read/glob/grep 需要读 DSH 自己的技能文件、
  // 临时目录里的中间产物；把这些也当越界会让正常对话频繁被打断（实测踩到）。
  // 所以只读工具允许「工作区 + 明确列出的可读根」，写与执行仍然只认工作区。
  if (target) {
    const inWs = isInsideWorkspace(ctx.workspace, target);
    if (level === 0) {
      const okRead = inWs || (ctx.readableRoots || []).some((r) => isInsideWorkspace(r, target));
      if (!okRead) {
        return { tool, level: 5, target, insideWorkspace: false, reason: '读取工作区外的位置' };
      }
      return { tool, level: 0, target, insideWorkspace: inWs, reason: 'known tool' };
    }
    if (!inWs) {
      return { tool, level: 5, target, insideWorkspace: false, reason: '路径越出隔离工作区' };
    }
    insideWorkspace = true;
  }

  return { tool, level, target, insideWorkspace, reason };
}

/** 给界面看的等级名字 */
export function levelName(level: ToolLevel): string {
  switch (level) {
    case 0: return 'L0 只读';
    case 1: return 'L1 网络';
    case 2: return 'L2 写文件';
    case 4: return 'L4 执行命令';
    default: return 'L5 高风险';
  }
}

/** 这个等级是否「默认就允许」，不需要任何授权 */
export function allowedWithoutGrant(level: ToolLevel): boolean {
  return level === 0 || level === 1;
}
