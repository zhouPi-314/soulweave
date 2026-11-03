/*
 * SoulWeave S7：资源下载中心（统一管理所有下载任务）
 *
 * 依据：
 *   01 需求 §7.10「按需加载、限流、非关键任务降级」
 *   04 D56.08「下载进度、取消、失败重试」
 *   D56.09「可行时断点续传」/ D56.10「SHA-256 校验」
 *
 * 【为什么单独一个模块，而不是各板块自己下载】
 * 用户的原话：「所有的资源下载任务和版本更新任务都归其管理，其他板块各司其职」。
 * 分散下载的后果很实在：
 *   · 同时下 3 个模型，谁也不知道总进度，网速被互相抢
 *   · 关掉某个面板，下载就断了，用户以为下完了
 *   · 每个板块都要自己写重试、断点、校验，写 5 遍就有 5 种 bug
 *
 * 所以这里做**唯一**的下载通道：队列、进度、暂停、续传、取消、校验都在这一处。
 * 其他板块只负责「我要一个文件」，然后去下载中心看进度。
 *
 * 【纯逻辑与 IO 分离】
 * 真正的传输通过注入的 transfer 函数完成，所以本模块的排队/限流/状态机
 * 可以在没有网络的情况下被完整测试。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ─── 类型 ───────────────────────────────────────────

export type TaskKind = 'model' | 'component' | 'update' | 'other';

export type TaskState =
  | 'queued'      // 排队中
  | 'running'     // 下载中
  | 'paused'      // 用户暂停（保留已下载部分，可续传）
  | 'completed'   // 完成且校验通过
  | 'failed'      // 失败（可重试）
  | 'cancelled';  // 用户取消（清理临时文件）

export interface DownloadTask {
  id: string;
  kind: TaskKind;
  /** 显示名，如「whisper small (q8_0)」 */
  label: string;
  /** 一句话说明用途 */
  note?: string;
  url: string;
  /** 最终落盘路径（绝对） */
  destPath: string;
  /** 下载中的临时文件路径（destPath + '.part'） */
  partPath: string;
  /** 期望大小（字节）；0 表示未知，以服务端 content-length 为准 */
  approxBytes: number;
  /** 已下载字节 */
  receivedBytes: number;
  /** 服务端声明的总大小（0 未知） */
  totalBytes: number;
  state: TaskState;
  error?: string;
  /** 期望的 SHA-256（可选；有就校验） */
  sha256?: string;
  /** 瞬时速度（字节/秒），由采样算出 */
  speedBps: number;
  /** 预计剩余秒数；无法估计时为 null */
  etaSeconds: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 重试次数 */
  attempts: number;
  /** 归属模块（voice/multimedia/...），用于过滤显示 */
  owner?: string;
}

export interface EnqueueSpec {
  kind: TaskKind;
  label: string;
  note?: string;
  url: string;
  destPath: string;
  approxBytes?: number;
  sha256?: string;
  owner?: string;
}

// ─── 纯函数：格式化与估算 ───────────────────────────

/** 字节 → 人类可读 */
export function formatBytes(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  const digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  return x.toFixed(digits) + ' ' + units[i];
}

/** 速度 → 人类可读 */
export function formatSpeed(bps: number): string {
  const v = Number(bps) || 0;
  if (v <= 0) return '—';
  return formatBytes(v) + '/s';
}

/** 秒 → 「1 分 20 秒」 */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 1) return '即将完成';
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? (m + ' 分 ' + r + ' 秒') : (m + ' 分钟');
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
}

/** 进度百分比 0–100（保留一位小数；总量未知时返回 null） */
export function progressPercent(received: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const p = (Number(received) || 0) / total * 100;
  return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
}

/**
 * 从采样点算瞬时速度。
 *
 * 用「最近若干秒的滑动窗口」而不是「总字节 / 总耗时」：
 * 后者在速度变化时（比如从 20 MB/s 掉到 200 KB/s）会给出严重乐观的估计，
 * 用户看着「还剩 3 秒」等了 3 分钟。
 */
export interface SpeedSample { at: number; bytes: number }

export function computeSpeed(samples: SpeedSample[], windowMs = 4000): number {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const cutoff = last.at - windowMs;
  // 找到窗口内最早的样本
  let first = samples[0];
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].at <= cutoff) { first = samples[i]; break; }
    first = samples[i];
  }
  const dt = (last.at - first.at) / 1000;
  const db = last.bytes - first.bytes;
  if (dt <= 0 || db <= 0) return 0;
  return db / dt;
}

/** 由速度与剩余字节算 ETA */
export function computeEta(remainingBytes: number, speedBps: number): number | null {
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return 0;
  if (!Number.isFinite(speedBps) || speedBps <= 0) return null;
  return remainingBytes / speedBps;
}

// ─── 纯函数：状态机 ─────────────────────────────────

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

/** 这个状态转换合法吗（防止 UI 乱调用把任务搞成僵尸） */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return (TRANSITIONS[from] || []).includes(to);
}

/** 是不是终态（不会再有变化） */
export function isTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'cancelled';
}

/** 是否可重试 */
export function canRetry(state: TaskState): boolean {
  return state === 'failed' || state === 'paused';
}

// ─── 传输层接口（可注入，便于测试） ─────────────────

export interface TransferContext {
  /** 起始字节（断点续传时 > 0） */
  startByte: number;
  /** 收到一块数据 */
  onChunk(bytes: number): void;
  /** 拿到总大小 */
  onTotal(total: number): void;
  /** 中止信号 */
  signal: { aborted: boolean };
}

export interface TransferResult {
  ok: boolean;
  error?: string;
  /** 传输结束时已写入的字节数 */
  receivedBytes?: number;
}

export type TransferFn = (task: DownloadTask, ctx: TransferContext) => Promise<TransferResult>;

// ─── 管理器 ─────────────────────────────────────────

export interface DownloadManagerOptions {
  /** 最多同时几个（默认 2：再多会互相抢带宽，反而不快） */
  concurrency?: number;
  /** 注入的传输实现 */
  transfer: TransferFn;
  /** 注入时钟 */
  now?: () => number;
  /** 状态变化回调 */
  onChange?: (tasks: DownloadTask[]) => void;
  /** 日志 */
  log?: (msg: string) => void;
  /** 持久化文件（给了就会存，重启后能看到历史） */
  statePath?: string;
}

interface Runtime {
  task: DownloadTask;
  signal: { aborted: boolean };
  samples: SpeedSample[];
}

export class DownloadManager {
  private opts: Required<Pick<DownloadManagerOptions, 'concurrency' | 'transfer' | 'now'>> & DownloadManagerOptions;
  private runtimes = new Map<string, Runtime>();
  private order: string[] = [];
  private running = 0;

  constructor(options: DownloadManagerOptions) {
    this.opts = {
      concurrency: 2,
      now: () => Date.now(),
      ...options,
    };
    if (options.statePath) this.load();
  }

  // ── 查询 ──

  list(): DownloadTask[] {
    return this.order.map((id) => this.runtimes.get(id)!.task).filter(Boolean);
  }

  get(id: string): DownloadTask | undefined {
    return this.runtimes.get(id)?.task;
  }

  /** 按归属模块过滤（各板块只显示自己的） */
  listByOwner(owner: string): DownloadTask[] {
    return this.list().filter((t) => t.owner === owner);
  }

  stats(): {
    total: number; running: number; queued: number; paused: number;
    completed: number; failed: number; receivedBytes: number; totalBytes: number;
  } {
    const all = this.list();
    const receivedBytes = all.reduce((s, t) => s + (t.receivedBytes || 0), 0);
    const totalBytes = all.reduce((s, t) => s + (t.totalBytes || t.approxBytes || 0), 0);
    return {
      total: all.length,
      running: all.filter((t) => t.state === 'running').length,
      queued: all.filter((t) => t.state === 'queued').length,
      paused: all.filter((t) => t.state === 'paused').length,
      completed: all.filter((t) => t.state === 'completed').length,
      failed: all.filter((t) => t.state === 'failed').length,
      receivedBytes,
      totalBytes,
    };
  }

  // ── 入队 ──

  enqueue(spec: EnqueueSpec): { ok: boolean; task?: DownloadTask; error?: string } {
    if (!spec || !spec.url) return { ok: false, error: '缺少下载地址' };
    if (!spec.destPath) return { ok: false, error: '缺少保存路径' };

    // 同一个目标路径已经在队列里 → 不重复下
    const dup = this.list().find((t) => t.destPath === spec.destPath
      && (t.state === 'queued' || t.state === 'running' || t.state === 'paused'));
    if (dup) return { ok: true, task: dup };

    const now = this.opts.now();
    const task: DownloadTask = {
      id: 'dl-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      kind: spec.kind || 'other',
      label: String(spec.label || '未命名下载'),
      note: spec.note ? String(spec.note) : undefined,
      url: String(spec.url),
      destPath: String(spec.destPath),
      partPath: String(spec.destPath) + '.part',
      approxBytes: Number(spec.approxBytes) || 0,
      receivedBytes: 0,
      totalBytes: 0,
      state: 'queued',
      sha256: spec.sha256 ? String(spec.sha256).toLowerCase() : undefined,
      speedBps: 0,
      etaSeconds: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      owner: spec.owner ? String(spec.owner) : undefined,
    };
    this.runtimes.set(task.id, { task, signal: { aborted: false }, samples: [] });
    this.order.push(task.id);
    this.emit();
    this.pump();
    return { ok: true, task };
  }

  // ── 控制 ──

  pause(id: string): { ok: boolean; error?: string } {
    const rt = this.runtimes.get(id);
    if (!rt) return { ok: false, error: '任务不存在' };
    if (!canTransition(rt.task.state, 'paused')) {
      return { ok: false, error: '当前状态（' + rt.task.state + '）不能暂停' };
    }
    rt.signal.aborted = true;
    rt.task.state = 'paused';
    rt.task.speedBps = 0;
    rt.task.etaSeconds = null;
    this.emit();
    this.pump();
    return { ok: true };
  }

  resume(id: string): { ok: boolean; error?: string } {
    const rt = this.runtimes.get(id);
    if (!rt) return { ok: false, error: '任务不存在' };
    if (rt.task.state !== 'paused' && rt.task.state !== 'failed') {
      return { ok: false, error: '当前状态不能继续' };
    }
    rt.task.state = 'queued';
    rt.task.error = undefined;
    rt.signal = { aborted: false };
    rt.samples = [];
    this.emit();
    this.pump();
    return { ok: true };
  }

  retry(id: string): { ok: boolean; error?: string } {
    return this.resume(id);
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const rt = this.runtimes.get(id);
    if (!rt) return { ok: false, error: '任务不存在' };
    if (isTerminal(rt.task.state)) return { ok: false, error: '任务已结束' };
    rt.signal.aborted = true;
    rt.task.state = 'cancelled';
    rt.task.finishedAt = this.opts.now();
    rt.task.speedBps = 0;
    rt.task.etaSeconds = null;
    this.cleanupPartial(rt.task);
    this.emit();
    this.pump();
    return { ok: true };
  }

  /** 清掉已结束的记录（保留正在进行的） */
  clearFinished(): number {
    let n = 0;
    for (const id of [...this.order]) {
      const rt = this.runtimes.get(id);
      if (!rt) continue;
      if (rt.task.state === 'completed' || rt.task.state === 'cancelled') {
        this.runtimes.delete(id);
        this.order = this.order.filter((x) => x !== id);
        n++;
      }
    }
    if (n) this.emit();
    return n;
  }

  remove(id: string): { ok: boolean; error?: string } {
    const rt = this.runtimes.get(id);
    if (!rt) return { ok: false, error: '任务不存在' };
    if (rt.task.state === 'running') return { ok: false, error: '正在下载，先暂停或取消' };
    this.runtimes.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit();
    return { ok: true };
  }

  // ── 调度 ──

  private pump(): void {
    if (this.running >= this.opts.concurrency) return;
    for (const id of this.order) {
      if (this.running >= this.opts.concurrency) break;
      const rt = this.runtimes.get(id);
      if (!rt || rt.task.state !== 'queued') continue;
      void this.run(rt);
    }
  }

  private async run(rt: Runtime): Promise<void> {
    const t = rt.task;
    t.state = 'running';
    t.startedAt = this.opts.now();
    t.attempts++;
    rt.samples = [{ at: this.opts.now(), bytes: t.receivedBytes }];
    this.running++;
    this.emit();

    try {
      const res = await this.opts.transfer(t, {
        startByte: t.receivedBytes,
        signal: rt.signal,
        onTotal: (total) => {
          if (total > 0) { t.totalBytes = total; this.emit(); }
        },
        onChunk: (bytes) => {
          t.receivedBytes += bytes;
          const at = this.opts.now();
          rt.samples.push({ at, bytes: t.receivedBytes });
          // 只留最近 30 个采样，避免长任务内存增长
          if (rt.samples.length > 30) rt.samples.shift();
          t.speedBps = computeSpeed(rt.samples);
          const total = t.totalBytes || t.approxBytes;
          t.etaSeconds = total > 0 ? computeEta(total - t.receivedBytes, t.speedBps) : null;
          this.emit();
        },
      });

      // 被暂停/取消：transfer 会因 abort 返回，这里不覆盖状态
      if (rt.signal.aborted) {
        this.running--;
        this.pump();
        return;
      }

      if (!res.ok) {
        t.state = 'failed';
        t.error = res.error || '下载失败';
        t.finishedAt = this.opts.now();
        t.speedBps = 0;
        t.etaSeconds = null;
        this.running--;
        this.emit();
        this.pump();
        return;
      }

      // 校验（有 hash 才校验）
      if (t.sha256) {
        const got = await this.hashFile(t.partPath);
        if (got && got.toLowerCase() !== t.sha256) {
          t.state = 'failed';
          t.error = '文件校验失败（SHA-256 不匹配），可能下载不完整';
          t.finishedAt = this.opts.now();
          this.cleanupPartial(t);
          this.running--;
          this.emit();
          this.pump();
          return;
        }
      }

      // 落盘：part → dest
      try {
        fs.mkdirSync(path.dirname(t.destPath), { recursive: true });
        fs.renameSync(t.partPath, t.destPath);
      } catch (e: any) {
        t.state = 'failed';
        t.error = '保存失败：' + String(e && e.message ? e.message : e).slice(0, 120);
        t.finishedAt = this.opts.now();
        this.running--;
        this.emit();
        this.pump();
        return;
      }

      t.state = 'completed';
      t.finishedAt = this.opts.now();
      t.receivedBytes = t.totalBytes || t.receivedBytes;
      t.speedBps = 0;
      t.etaSeconds = 0;
      this.opts.log?.('[download] done ' + t.label + ' → ' + t.destPath);
    } catch (e: any) {
      t.state = 'failed';
      t.error = String(e && e.message ? e.message : e).slice(0, 200);
      t.finishedAt = this.opts.now();
      t.speedBps = 0;
    } finally {
      this.running = Math.max(0, this.running - 1);
      this.emit();
      this.save();
      this.pump();
    }
  }

  private cleanupPartial(t: DownloadTask): void {
    try { if (fs.existsSync(t.partPath)) fs.unlinkSync(t.partPath); } catch (e) { /* ignore */ }
  }

  private async hashFile(p: string): Promise<string | null> {
    try {
      if (!fs.existsSync(p)) return null;
      const h = crypto.createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const s = fs.createReadStream(p);
        s.on('data', (c) => h.update(c as Buffer));
        s.on('end', () => resolve());
        s.on('error', reject);
      });
      return h.digest('hex');
    } catch (e) { return null; }
  }

  // ── 持久化（只存历史，不恢复进行中的任务） ──

  private save(): void {
    if (!this.opts.statePath) return;
    try {
      const data = this.list().map((t) => ({ ...t, state: t.state === 'running' ? 'failed' : t.state, speedBps: 0, etaSeconds: null }));
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      fs.writeFileSync(this.opts.statePath, JSON.stringify({ version: 1, tasks: data }, null, 1), 'utf8');
    } catch (e) { /* ignore */ }
  }

  private load(): void {
    try {
      if (!this.opts.statePath || !fs.existsSync(this.opts.statePath)) return;
      const j = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8'));
      for (const t of (j && j.tasks) || []) {
        if (!t || !t.id) continue;
        const task: DownloadTask = {
          ...t,
          // 上次没跑完的，重启后标记为失败（可手动重试），不要假装还在下
          state: t.state === 'running' ? 'failed' : t.state,
          error: t.state === 'running' ? '上次下载被中断' : t.error,
          speedBps: 0,
          etaSeconds: null,
        };
        this.runtimes.set(task.id, { task, signal: { aborted: false }, samples: [] });
        this.order.push(task.id);
      }
    } catch (e) { /* ignore */ }
  }

  private emit(): void {
    try { this.opts.onChange?.(this.list()); } catch (e) { /* ignore */ }
  }
}
