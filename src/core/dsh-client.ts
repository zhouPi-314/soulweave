/**
 * DSH SDK 客户端
 *
 * 通过 stdio JSON-RPC 与 DSH Harness 通信。
 * 协议：@deepseek-ai/dsh-sdk-protocol
 *
 * ── 重要实现约束（S1 实测发现）────────────────────
 *
 * 1. 必须用 DSH 官方启动器 `runtime/cli/bin/dsh.cmd`
 *    直接用 node 跑 bin.js 会因 app.asar 虚拟路径失败。
 *
 * 2. 必须设置 DSH_DESKTOP_NODE_EXECUTABLE 指向 DeepSeek Harness.exe
 *    dsh.cmd 内部用它 + --expose-internals 启动。
 *
 * 3. initialize 必须带 cwd / provider / model 三个参数：
 *    - 缺 cwd      → "paths[0] must be of type string"
 *    - 缺 provider → "no adapter registered for provider undefined"
 *
 * 4. 握手返回 { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
 *    版本号固定，无协商（协议已知限制）。
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface DshClientOptions {
  /** dsh.cmd 路径 */
  launcherPath: string;
  /** DeepSeek Harness.exe 路径（dsh.cmd 内部使用） */
  electronExecutable: string;
  /** 独立 DSH_HOME（与开发 DSH 隔离） */
  dshHome: string;
  /** 工作目录（initialize 必需） */
  cwd: string;
  /** profile，默认 sdk */
  profile?: string;
  /** provider，默认 deepseek-official */
  provider?: string;
  /** model，默认 deepseek-flash */
  model?: string;
  /** 请求超时（毫秒） */
  requestTimeoutMs?: number;
  /** 通知回调 */
  onNotification?: (method: string, params: unknown) => void;
  /** 诊断输出 */
  onStderr?: (line: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DshClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private ready = false;

  constructor(private opts: DshClientOptions) {}

  /** 启动 DSH 并完成 initialize 握手 */
  async start(): Promise<void> {
    if (this.proc) throw new Error('DSH 已在运行');

    const profile = this.opts.profile ?? 'sdk';

    this.proc = spawn(
      process.env.COMSPEC ?? 'cmd.exe',
      ['/c', this.opts.launcherPath, '--profile', profile],
      {
        cwd: this.opts.cwd,
        env: {
          ...process.env,
          DSH_HOME: this.opts.dshHome,
          DSH_DESKTOP_NODE_EXECUTABLE: this.opts.electronExecutable,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.proc.stderr!.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      // Chromium 的缓存噪声不算诊断
      if (!s) return;
      if (s.includes('persistent_cache') || s.includes('disk_cache') || s.includes('gpu_disk_cache')) return;
      this.opts.onStderr?.(s);
    });
    this.proc.on('exit', (code) => this.onExit(code));
    this.proc.on('error', (e) => this.onExit(-1, e));

    // 等插件树加载（实测约 2-3 秒）
    await new Promise(r => setTimeout(r, 3000));

    await this.request('initialize', {
      clientInfo: { name: 'soulweave', version: '0.1.0' },
      cwd: this.opts.cwd,
      provider: this.opts.provider ?? 'deepseek-official',
      model: this.opts.model ?? 'deepseek-flash',
    });

    this.ready = true;
  }

  /** 提交提示词 */
  async prompt(sessionId: string, text: string): Promise<{ messageId: string }> {
    this.assertReady();
    return this.request('session/prompt', {
      sessionId,
      content: [{ type: 'text', text }],
    }) as Promise<{ messageId: string }>;
  }

  async resume(sessionId: string): Promise<void> {
    this.assertReady();
    await this.request('session/resume', { sessionId });
  }

  /** 等待 agent 空闲 */
  async wait(sessionId: string): Promise<void> {
    this.assertReady();
    await this.request('session/wait', { sessionId });
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    try { await this.request('shutdown', {}, 5000); } catch { /* 忽略 */ }
    this.proc.kill();
    this.proc = null;
    this.ready = false;
  }

  isReady(): boolean { return this.ready; }

  // ── JSON-RPC ──────────────────────────────────

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('DSH 请求超时: ' + method));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      );
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try { this.dispatch(JSON.parse(line)); } catch { /* 格式错误的行忽略 */ }
    }
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.opts.onNotification?.(msg.method, msg.params);
  }

  private onExit(code: number | null, err?: Error): void {
    this.ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err ?? new Error('DSH 进程退出: ' + code));
    }
    this.pending.clear();
  }

  private assertReady(): void {
    if (!this.ready) throw new Error('DSH 未就绪，请先 start()');
  }
}
