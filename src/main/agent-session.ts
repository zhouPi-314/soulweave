/**
 * SoulWeave：智能体会话执行（DSH headless 模式）
 *
 * 【为什么用 headless 而不是 SDK JSON-RPC】
 * 实测 SDK 模式的 session/* 方法名全部未知（运行时返回 -32603 unknown method），
 * 而 `dsh --profile headless --json` 有稳定、可观测的 NDJSON 事件流：
 *
 *   {"type":"session","sessionId":"session-...","cwd":"..."}
 *   {"type":"status","phase":"turn_start","turn":1}
 *   {"type":"status","phase":"step_start",...}
 *   {"type":"status","phase":"step_end",...}
 *   {"type":"status","phase":"turn_end","reason":{...}}
 *   {"type":"final","text":"..."}          ← 最终回答
 *
 * 失败时 stderr 会给一行 `dsh: <CODE>: <说明>`，例如
 *   dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
 *
 * 【已确认的阻塞】
 * 子进程无法获得 DSH 桌面应用的凭据：`DEEPSEEK_API_KEY` 既不在 .credentials.yaml，
 * 也不在继承的环境里。所以必须由用户显式提供 key，本模块负责安全转交。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface AgentTurnOptions {
  /** dsh.cmd 路径 */
  launcherPath: string;
  /** DeepSeek Harness.exe */
  electronExecutable: string;
  /** DSH_HOME */
  dshHome: string;
  /** 工作目录（隔离，不能让角色改项目文件） */
  cwd: string;
  /** 用户提问 */
  task: string;
  /** 续接已有会话 */
  sessionId?: string;
  /** 超时 */
  timeoutMs?: number;
  /** API key（可选；有就通过环境变量传给子进程） */
  apiKey?: string;
  /** 事件回调（可用来做流式） */
  onEvent?: (ev: any) => void;
  /**
   * 工具门禁（S9）。
   *
   * 每收到一个 tool_call 就问一次；返回 allow=false 时**立刻杀掉子进程**，
   * 本轮以 TOOL_DENIED 结束。这是「后端强制执行」而不是提示词约束：
   * 模型只能"想"用工具，真正能不能用由这里说了算。
   */
  gate?: (call: { tool: string; input: unknown }) =>
    | { allow: true }
    | { allow: false; reason?: string; level?: number };
}

/** 统一后的用量（DSH 与网关两种命名都归一到这个形状） */
export interface AgentUsage {
  /** 新增输入 token */
  input?: number;
  /** 输出 token */
  output?: number;
  /** 缓存读取 token（通常显著便宜） */
  cacheRead?: number;
  /** 缓存写入 token */
  cacheWrite?: number;
  /** 合计 */
  total?: number;
}

export interface AgentTurnResult {
  ok: boolean;
  /** 本轮用量（DSH 在 status/step_end 事件里给） */
  usage?: AgentUsage;
  text?: string;
  sessionId?: string;
  ms?: number;
  /** 结构化错误码，如 MISSING_CREDENTIAL */
  code?: string;
  error?: string;
  /** 被门禁拦下的工具（TOOL_DENIED 时给出） */
  deniedTool?: string;
}

/**
 * Windows 命令行转义（S9 修复）。
 *
 * 【为什么需要】
 * 原来直接 spawn(cmd.exe, [/c, launcherPath, ...args])。launcher 路径含空格时
 * Node 会给它加引号，而 cmd /c 对「第一个带引号的 token」有特殊处理，
 * 结果变成  '"D:\DeepSeek Harness\...\dsh.cmd"' 不是内部或外部命令。
 * 触发条件是**任务文本里出现空格** —— 也就是说大部分正常句子都会踩到。
 *
 * 正确写法是 cmd /d /s /c ""<launcher>" <args>"：
 *   /s 让 cmd 只剥掉最外层一对引号，内部引号原样保留。
 * 实测：带空格、& | < > 的参数都能原样到达 dsh。
 */
function quoteWinArg(s: string): string {
  const v = String(s ?? "");
  if (!v) return '""';
  if (!/[\s"&|<>^%]/.test(v)) return v;
  return '"' + v.replace(/"/g, '\\"') + '"';
}

/**
 * 中和 %VAR% 形状（S9 修复）。
 *
 * cmd 不只在批处理里展开 %VAR%，命令行里同样展开 —— 实测：
 *   echo "A %PROBE_SECRET% B"  →  A LEAKED B
 * 也就是说，如果任务文本里出现 %DEEPSEEK_API_KEY%，密钥会被展开进提示词，
 * 交给模型。双重百分号也挡不住（%%X%% 会变成 %展开值%）。
 *
 * 所以在交给 cmd 之前，把「像变量引用」的 % 换成全角 ％，其余 % 原样保留。
 * 代价是极少数含 %VAR% 的句子会被改一个字符，换来的是密钥不会被带出去。
 */
export function neutralizePercent(text: string): string {
  return String(text ?? "").replace(/%([A-Za-z_][A-Za-z0-9_]*)?%/g, (m) =>
    "％" + m.slice(1, -1) + "％"
  );
}

/** 把 stderr 的 `dsh: CODE: msg` 解析成结构化结果 */
function parseDshError(stderr: string): { code?: string; message?: string } {
  const line = String(stderr || '').split('\n').map((s) => s.trim()).filter(Boolean).find((s) => /^dsh:\s/.test(s));
  if (!line) return {};
  const m = line.match(/^dsh:\s*([A-Z_]+):\s*(.*)$/);
  if (!m) return { message: line };
  return { code: m[1], message: m[2] };
}

/**
 * 跑一轮对话。
 * 不修改任何文件；cwd 必须是隔离目录。
 */
export function runAgentTurn(o: AgentTurnOptions): Promise<AgentTurnResult> {
  const t0 = Date.now();
  const task = String(o.task || '').trim();
  if (!task) return Promise.resolve({ ok: false, error: '内容为空' });
  if (!fs.existsSync(o.launcherPath)) {
    return Promise.resolve({ ok: false, error: '找不到 dsh 启动器：' + o.launcherPath });
  }
  try { fs.mkdirSync(o.cwd, { recursive: true }); } catch (e) { /* ignore */ }
  try { fs.mkdirSync(o.dshHome, { recursive: true }); } catch (e) { /* ignore */ }

  const args = ['--profile', 'headless', '--json'];
  if (o.sessionId) args.push('--session-id', o.sessionId);
  args.push(task);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: o.dshHome,
    DSH_DESKTOP_NODE_EXECUTABLE: o.electronExecutable,
  };
  // key 只经环境变量传递，不写进命令行（进程列表看不到）
  if (o.apiKey) env.DEEPSEEK_API_KEY = o.apiKey;

  return new Promise<AgentTurnResult>((resolve) => {
    let settled = false;
    const finish = (r: AgentTurnResult) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, ms: r.ms ?? (Date.now() - t0) });
    };

    let child: any;
    try {
      if (process.platform === 'win32') {
        // 任务文本单独中和 %VAR%，其余参数也走同一套引号规则
        const safeArgs = args.map((a, i) => (i === args.length - 1 ? neutralizePercent(String(a)) : String(a)));
        const line = '"' + o.launcherPath + '" ' + safeArgs.map(quoteWinArg).join(' ');
        child = spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], {
          cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          windowsVerbatimArguments: true,
        });
      } else {
        child = spawn(o.launcherPath, args, {
          cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      finish({ ok: false, error: '启动失败：' + String(e).slice(0, 160) });
      return;
    }

    let outBuf = '';
    let errBuf = '';
    let finalText = '';
    let sid = o.sessionId;
    const acc: AgentUsage = {};
    /** 被门禁拦下的工具；一旦有值，close 不再覆盖结果 */
    let denied: { tool: string; reason?: string; level?: number } | null = null;

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      finish({ ok: false, sessionId: sid, error: '超时（' + Math.round((o.timeoutMs ?? 120000) / 1000) + ' 秒）' });
    }, o.timeoutMs ?? 120000);

    child.stdout.on('data', (d: Buffer) => {
      outBuf += d.toString('utf8');
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, i).trim();
        outBuf = outBuf.slice(i + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        // 门禁放在 onEvent 之前：调用方可能把 onEvent 用于界面渲染，
        // 被拒绝的调用不该先"看起来执行了"再报错。
        if (ev.type === 'tool_call' && typeof o.gate === 'function') {
          let decision: { allow: boolean; reason?: string; level?: number };
          try {
            decision = o.gate({ tool: String(ev.tool || ''), input: ev.input });
          } catch (e) {
            decision = { allow: false, reason: '门禁判定异常：' + String(e).slice(0, 80) };
          }
          if (!decision.allow) {
            denied = { tool: String(ev.tool || ''), reason: decision.reason, level: decision.level };
            try { child.kill(); } catch (e) { /* ignore */ }
            clearTimeout(timer);
            finish({
              ok: false,
              code: 'TOOL_DENIED',
              sessionId: sid,
              deniedTool: denied.tool,
              text: finalText || undefined,
              error: '需要授权：' + (denied.tool || '未知工具') +
                (denied.level !== undefined ? '（L' + denied.level + '）' : '') +
                (denied.reason ? ' · ' + denied.reason : '') +
                '。已中止本轮，未执行。',
            });
            return;
          }
        }
        o.onEvent?.(ev);
        if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId;
        if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
        // DSH 在 status 事件里带 usage（形如 { inputTokens, outputTokens, cacheReadTokens, ... }）
        const u = ev && ev.usage;
        if (u && typeof u === 'object') {
          acc.input = (acc.input || 0) + Number(u.inputTokens || 0);
          acc.output = (acc.output || 0) + Number(u.outputTokens || 0);
          acc.cacheRead = (acc.cacheRead || 0) + Number(u.cacheReadTokens || 0);
          acc.cacheWrite = (acc.cacheWrite || 0) + Number(u.cacheWriteTokens || 0);
          acc.total = (acc.total || 0) + Number(u.totalTokens || 0);
        }
      }
    });

    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (!s) return;
      if (/disk_cache|persistent_cache|gpu_disk_cache/.test(s)) return;
      errBuf += s;
    });

    child.on('error', (e: Error) => { clearTimeout(timer); finish({ ok: false, sessionId: sid, error: String(e).slice(0, 160) }); });

    child.on('close', () => {
      clearTimeout(timer);
      if (denied) return;   // 结果已经由门禁给出，别用「未获得回复」覆盖它
      const parsed = parseDshError(errBuf);
      const hasUsage = acc.total || acc.input || acc.output || acc.cacheRead;
      if (finalText) {
        finish({ ok: true, text: finalText, sessionId: sid, usage: hasUsage ? acc : undefined });
        return;
      }
      // 没拿到 final：优先报结构化错误
      if (parsed.code === 'MISSING_CREDENTIAL') {
        finish({
          ok: false, code: parsed.code, sessionId: sid,
          error: '未配置 API Key：DSH 无法调用模型。请在设置里填入 DeepSeek API Key。' +
                 (parsed.message ? '（' + parsed.message.slice(0, 120) + '）' : ''),
        });
        return;
      }
      if (parsed.code || parsed.message) {
        finish({ ok: false, code: parsed.code, sessionId: sid, error: (parsed.code ? parsed.code + ': ' : '') + (parsed.message || '').slice(0, 200) });
        return;
      }
      finish({ ok: false, sessionId: sid, error: '未获得回复（stderr 前 200 字：' + errBuf.slice(0, 200) + '）' });
    });
  });
}
