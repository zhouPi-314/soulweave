import fsNode from 'node:fs';
import pathNode from 'node:path';
/**
 * SoulWeave：智能体接入抽象（AgentAdapter）
 *
 * 【为什么需要抽象】
 * 产品不绑定 DSH 一家：用户可以从已安装的智能体里选一个接给角色。
 * 但不同智能体的接入方式差别极大，必须先诚实分类：
 *
 *   sdk        有可编程接口（stdio/JSON-RPC 或 HTTP），能真正双向对话
 *   cli-only   只有交互式命令行界面，无法稳定地程序化收发
 *   none       只有图形界面，没有可调用接口
 *
 * **只有 sdk 类能真正接入。** cli-only 和 none 会在界面上标注「暂不支持」，
 * 不会假装可用 —— 假装可用比明说做不到更糟。
 */

export type AgentCapability = 'sdk' | 'cli-only' | 'none';

export interface AgentDetection {
  /** 稳定 id */
  id: string;
  /** 显示名 */
  label: string;
  /** 厂商 */
  vendor: string;
  /** 接入能力 */
  capability: AgentCapability;
  /** 本机是否检测到 */
  installed: boolean;
  /** 可执行文件路径（检测到时） */
  path?: string;
  /** 版本（能拿到时） */
  version?: string;
  /** 补安装/查看更多说明 */
  note?: string;
}

export interface AgentSessionOptions {
  /** 隔离的 HOME / 配置目录 */
  homeDir: string;
  /** 隔离的工作目录 */
  cwd: string;
  /** 模型 */
  model?: string;
  /** 请求超时 */
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
  onStderr?: (line: string) => void;
}

export interface AgentAdapter {
  id: string;
  label: string;
  vendor: string;
  capability: AgentCapability;
  /** 探测本机 */
  detect(): Promise<AgentDetection>;
  /** 启动隔离会话 */
  start(opts: AgentSessionOptions): Promise<void>;
  /** 发消息 */
  prompt(sessionId: string, text: string): Promise<{ messageId: string }>;
  /** 关闭 */
  stop(): Promise<void>;
}

/**
 * 内置候选清单。
 *
 * capability 的判定依据是「厂商是否公开提供本地可编程接口」，不是「有没有这个产品」。
 * 未实现适配器的条目 installed 可为 true，但界面上会显示「暂不支持接入」。
 */
export interface AgentCandidate {
  id: string;
  label: string;
  vendor: string;
  capability: AgentCapability;
  /** 用于探测的可执行文件名 */
  commands: string[];
  /** 常见安装路径（用户级，精确路径） */
  hintPaths?: string[];
  /**
   * 带通配符的安装路径。
   * 有些桌面版把可执行文件放在带哈希的子目录里（例如 Codex：
   * %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe），
   * 写死路径必然失效，只能按通配展开。
   */
  hintGlobs?: string[];
  /** 配置目录：存在即说明"装过/登录过"，但可能没有可执行文件在 PATH 里 */
  configDirs?: string[];
  note?: string;
}

export const AGENT_CANDIDATES: AgentCandidate[] = [
  {
    id: 'dsh',
    label: 'DeepSeek Harness（DSH）',
    vendor: 'DeepSeek',
    capability: 'sdk',
    commands: ['dsh', 'dsh.cmd'],
    hintPaths: ['D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'],
    hintGlobs: ['%LOCALAPPDATA%\\Programs\\*DeepSeek*\\resources\\runtime\\cli\\bin\\dsh.cmd',
                'C:\\Program Files\\*DeepSeek*\\resources\\runtime\\cli\\bin\\dsh.cmd'],
    configDirs: ['%USERPROFILE%\\.dsh'],
    note: '通过官方 dsh.cmd + stdio JSON-RPC 接入，已实现。',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    capability: 'cli-only',
    commands: ['claude', 'claude.cmd'],
    hintGlobs: ['%LOCALAPPDATA%\\Programs\\claude*\\claude.exe', '%APPDATA%\\npm\\claude.cmd'],
    configDirs: ['%USERPROFILE%\\.claude', '%USERPROFILE%\\.claude.json'],
    note: '目前以交互式 CLI 为主，缺少稳定的程序化双向接口；接入需评估其 SDK/Agent API。',
  },
  {
    id: 'codex',
    label: 'Codex（ChatGPT）',
    vendor: 'OpenAI',
    capability: 'cli-only',
    commands: ['codex', 'codex.cmd'],
    // 桌面版把 exe 放在带哈希的子目录里，必须按通配展开
    hintGlobs: [
      '%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe',
      '%LOCALAPPDATA%\\Programs\\Codex\\codex.exe',
    ],
    configDirs: ['%USERPROFILE%\\.codex'],
    note: '同上：CLI 交互为主，需评估可编程接口后再接。',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    vendor: 'Google',
    capability: 'cli-only',
    commands: ['gemini', 'gemini.cmd'],
    note: 'CLI 交互为主，需评估可编程接口后再接。',
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    vendor: 'xAI',
    capability: 'cli-only',
    commands: ['grok', 'grok.cmd'],
    note: 'CLI 交互为主，需评估可编程接口后再接。',
  },
  {
    id: 'qwen',
    label: '通义灵码 / Qwen Code',
    vendor: '阿里云',
    capability: 'cli-only',
    commands: ['qwen', 'qwen.cmd'],
    note: '国内主流；接入方式待评估。',
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    vendor: 'WorkBuddy',
    capability: 'cli-only',
    commands: ['workbuddy', 'workbuddy.cmd', 'wb'],
    hintGlobs: ['%LOCALAPPDATA%\\Programs\\*WorkBuddy*\\*.exe',
                '%LOCALAPPDATA%\\Programs\\workbuddy*\\*.exe',
                '%APPDATA%\\npm\\workbuddy.cmd'],
    configDirs: ['%USERPROFILE%\\.workbuddy', '%APPDATA%\\WorkBuddy'],
    note: '桌面型工作助手；目前只做检测与占位，接入需先确认其可编程接口。',
  },
  {
    id: 'iflycode',
    label: '讯飞星火 / iFlyCode',
    vendor: '科大讯飞',
    capability: 'none',
    commands: [],
    note: '以 IDE 插件/网页为主，暂无本地可编程接口。',
  },
];

/**
 * 探测一个候选是否安装。
 * 只做「文件是否存在」这类事实判断，不执行任何智能体本体。
 */
export async function detectCandidate(
  c: AgentCandidate,
  deps: {
    /** 在 PATH 中查找命令，返回绝对路径或 null */
    which: (cmd: string) => string | null;
    /** 文件是否存在 */
    exists: (p: string) => boolean;
    /** 运行命令拿版本（可选，失败返回 null） */
    versionOf?: (exe: string) => Promise<string | null>;
    /** 展开通配路径，返回命中的绝对路径（可选） */
    expandGlob?: (pattern: string) => string[];
  }
): Promise<AgentDetection> {
  let found: string | null = null;
  for (const cmd of c.commands) {
    const hit = deps.which(cmd);
    if (hit) { found = hit; break; }
  }
  if (!found && c.hintPaths) {
    for (const hp of c.hintPaths) {
      if (deps.exists(hp)) { found = hp; break; }
    }
  }
  if (!found && c.hintGlobs && deps.expandGlob) {
    for (const g of c.hintGlobs) {
      const hits = deps.expandGlob(g);
      if (hits.length) { found = hits[0]; break; }
    }
  }
  // 只有配置目录、没有可执行文件：说明装过，但没在 PATH 里
  let configOnly: string | null = null;
  if (!found && c.configDirs) {
    for (const cd of c.configDirs) {
      if (!deps.exists(cd)) continue;
      // 展示展开后的真实路径，不要给用户看 %USERPROFILE% 这种占位
      configOnly = (deps.expandGlob ? (deps.expandGlob(cd)[0] || cd) : cd);
      break;
    }
  }

  let version: string | undefined;
  if (found && deps.versionOf) {
    try {
      const v = await deps.versionOf(found);
      if (v) version = v.trim().slice(0, 80);
    } catch (e) { /* 拿不到版本不影响「已安装」判定 */ }
  }

  return {
    id: c.id,
    label: c.label,
    vendor: c.vendor,
    capability: c.capability,
    installed: !!(found || configOnly),
    path: found || configOnly || undefined,
    version,
    note: configOnly && !found
      ? '找到配置目录（说明装过），但可执行文件不在 PATH 里；如需接入请手动指定路径。'
      : c.note,
  };
}

/**
 * 该 agent 是否可以被真正接入。
 * 只有 sdk 类才行 —— 其余一律返回 false，避免界面给出虚假承诺。
 */
export function canBind(d: AgentDetection): { ok: boolean; reason?: string } {
  if (!d.installed) return { ok: false, reason: '本机未检测到该智能体' };
  if (d.capability === 'sdk') return { ok: true };
  if (d.capability === 'cli-only') {
    return { ok: false, reason: '该智能体目前只有交互式命令行界面，缺少稳定的程序化接口，暂不支持接入' };
  }
  return { ok: false, reason: '该智能体没有本地可编程接口，无法接入' };
}

// ─── DSH 运行时路径解析 ────────────────────────────────

export interface DshRuntime {
  /** dsh.cmd 的绝对路径 */
  launcherPath: string;
  /** DSH 主程序 exe（用于 spawn 的 shell 环境） */
  electronExecutable: string;
  /** 解析来源，便于诊断 */
  source: 'explicit' | 'which' | 'portable' | 'installed' | 'none';
}

/**
 * 自动解析 DSH 运行时路径，**不依赖开发机硬编码**。
 *
 * 【为什么需要】
 * 早期代码里写死了 'D:\DeepSeek Harness\...'。
 * 用户装到 C 盘、或装的是便携版，就完全跑不起来。
 *
 * 探测顺序（越靠前优先级越高）：
 *   1. 用户在设置里显式指定的路径
 *   2. PATH 里的 dsh / dsh.cmd
 *   3. 常见安装根目录 × 已知子路径
 *   4. 便携版（与本应用同级）
 *
 * 全部失败返回 source: 'none'，调用方应提示用户手动指定。
 */
export function resolveDshRuntime(opts: {
  /** 用户显式配置 */
  explicitLauncher?: string;
  explicitExe?: string;
  exists?: (p: string) => boolean;
  which?: (cmd: string) => string | null;
  /** 本应用所在目录（找便携版用） */
  appDir?: string;
}): DshRuntime {
  const exists = opts.exists || ((p: string) => { try { return fsNode.existsSync(p); } catch (e) { return false; } });
  const which = opts.which || (() => null);

  const launcherSub = ['resources', 'runtime', 'cli', 'bin', 'dsh.cmd'];
  const exeNames = ['DeepSeek Harness.exe', 'DeepSeekHarness.exe'];

  const done = (launcherPath: string, electronExecutable: string, source: DshRuntime['source']): DshRuntime =>
    ({ launcherPath, electronExecutable, source });

  // 1. 显式配置
  if (opts.explicitLauncher && exists(opts.explicitLauncher)) {
    let exe = opts.explicitExe && exists(opts.explicitExe) ? opts.explicitExe : '';
    if (!exe) {
      // 从 launcher 往上找 resources 的父目录
      let d = opts.explicitLauncher;
      for (let i = 0; i < 6; i++) {
        d = pathNode.dirname(d);
        for (const n of exeNames) {
          const cand = pathNode.join(d, n);
          if (exists(cand)) { exe = cand; break; }
        }
        if (exe) break;
      }
    }
    return done(opts.explicitLauncher, exe, 'explicit');
  }

  // 2. PATH
  for (const cmd of ['dsh', 'dsh.cmd']) {
    const hit = which(cmd);
    if (hit) {
      // dsh.cmd 可能在 bin 目录，往上找 exe
      let exe = '';
      let d = hit;
      for (let i = 0; i < 7; i++) {
        d = pathNode.dirname(d);
        for (const n of exeNames) {
          const cand = pathNode.join(d, n);
          if (exists(cand)) { exe = cand; break; }
        }
        if (exe) break;
      }
      return done(hit, exe, 'which');
    }
  }

  const path = pathNode;

  // 3. 常见安装根目录
  const roots: string[] = [];
  const drives = ['C:', 'D:', 'E:', 'F:'];
  for (const d of drives) {
    roots.push(d + '\\DeepSeek Harness');
    roots.push(d + '\\Program Files\\DeepSeek Harness');
    roots.push(d + '\\Program Files (x86)\\DeepSeek Harness');
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) roots.push(path.join(localAppData, 'Programs', 'DeepSeek Harness'));
  if (localAppData) roots.push(path.join(localAppData, 'DeepSeek Harness'));
  const pf = process.env.ProgramFiles;
  if (pf) roots.push(path.join(pf, 'DeepSeek Harness'));
  const pf86 = process.env['ProgramFiles(x86)'];
  if (pf86) roots.push(path.join(pf86, 'DeepSeek Harness'));

  for (const root of roots) {
    const launcher = path.join(root, ...launcherSub);
    if (!exists(launcher)) continue;
    let exe = '';
    for (const n of exeNames) {
      const cand = path.join(root, n);
      if (exists(cand)) { exe = cand; break; }
    }
    return done(launcher, exe, 'installed');
  }

  // 4. 便携版（与本应用同级）
  if (opts.appDir) {
    for (const rel of ['DeepSeek Harness', 'dsh', '..\\DeepSeek Harness']) {
      const root = path.resolve(opts.appDir, rel);
      const launcher = path.join(root, ...launcherSub);
      if (!exists(launcher)) continue;
      let exe = '';
      for (const n of exeNames) {
        const cand = path.join(root, n);
        if (exists(cand)) { exe = cand; break; }
      }
      return done(launcher, exe, 'portable');
    }
  }

  return { launcherPath: '', electronExecutable: '', source: 'none' };
}
