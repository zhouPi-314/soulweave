/**
 * SoulWeave S9：审计日志
 *
 * 【为什么先是文件而不是数据库】
 * 审计必须「即使数据库没配好也要能写」—— 数据库连不上时恰恰是最需要留证据的时候。
 * 所以主线是 append-only 的 JSONL 文件（按大小轮转），
 * 数据库接入作为可选 sink，由调用方注入，不阻塞主流程。
 *
 * 【脱敏是硬要求】
 * D60.17 写「审计日志脱敏」。这里做三件事：
 *   1. 去掉常见密钥形状（sk-…、api_key=…、token=…、bearer …）
 *   2. 去掉长十六进制/base64 串（多半是哈希或密钥）
 *   3. 单条截断，避免一条命令把日志写爆
 *
 * 路径保留原文：排障时没有路径就没法定位，而路径本身不是秘密。
 */

import fs from 'node:fs';
import path from 'node:path';

export type AuditKind =
  | 'tool.allow' | 'tool.deny' | 'tool.error'
  | 'grant.create' | 'grant.revoke' | 'grant.expire'
  | 'approval.request' | 'approval.approve' | 'approval.deny'
  | 'diag.run' | 'backup.create' | 'backup.restore' | 'config.export' | 'config.import'
  | 'cache.clear' | 'web.pair' | 'web.revoke';

export type AuditEntry = {
  at: number;
  kind: AuditKind | string;
  /** 哪个角色/谁触发的 */
  actor?: string;
  tool?: string;
  level?: number;
  /** 操作对象（路径、账号等） */
  target?: string;
  /** 结果：ok / denied / error … */
  result?: string;
  detail?: string;
};

const MAX_DETAIL = 500;

/** 密钥形状（顺序有讲究：先长后短，避免被短的先吃掉） */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-***'],
  [/(api[_-]?key|apikey|secret|token|password|passwd)\s*[=:]\s*["']?[^\s"',;]{6,}/gi, '$1=***'],
  [/bearer\s+[A-Za-z0-9._\-]{10,}/gi, 'bearer ***'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],          // 长十六进制（哈希/令牌）
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***'],  // 长 base64
];

/** 脱敏 + 截断。空值返回空串。 */
export function redact(text: unknown): string {
  let s = String(text ?? '');
  if (!s) return '';
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  s = s.replace(/[\r\n\t]+/g, ' ').trim();
  if (s.length > MAX_DETAIL) s = s.slice(0, MAX_DETAIL) + '…';
  return s;
}

export type AuditLogOptions = {
  dir: string;
  /** 单文件上限，超过就轮转 */
  maxBytes?: number;
  now?: () => number;
  /** 内存里保留最近多少条，供快速查询 */
  memoryLimit?: number;
};

export type QueryOptions = {
  limit?: number;
  kind?: string;
  sinceMs?: number;
  tool?: string;
};

export class AuditLog {
  private dir: string;
  private file: string;
  private maxBytes: number;
  private now: () => number;
  private memoryLimit: number;
  private recent: AuditEntry[] = [];
  private loaded = false;

  constructor(opts: AuditLogOptions) {
    this.dir = opts.dir;
    this.file = path.join(opts.dir, 'audit.log');
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.now = opts.now ?? (() => Date.now());
    this.memoryLimit = opts.memoryLimit ?? 500;
    // 【必须在构造时就载入】否则 append 先往内存写一条、query 再触发载入，
    // 同一批记录会被读两遍，统计和分页都会翻倍（实测踩过）。
    this.loadRecent();
  }

  private ensureDir(): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* 写失败也要继续跑对话 */ }
  }

  /** 读最近若干条进内存（进程重启后仍能查最近历史） */
  private loadRecent(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-this.memoryLimit);
      for (const line of lines) {
        try { this.recent.push(JSON.parse(line) as AuditEntry); } catch (e) { /* 跳过坏行 */ }
      }
    } catch (e) { /* 读不到就当空 */ }
  }

  /** 追加一条。永不抛错：审计写失败不能拖垮对话 */
  append(entry: Omit<AuditEntry, 'at'> & { at?: number }): AuditEntry {
    const e: AuditEntry = {
      at: entry.at ?? this.now(),
      kind: String(entry.kind || 'unknown'),
      actor: entry.actor ? redact(entry.actor) : undefined,
      tool: entry.tool ? redact(entry.tool) : undefined,
      level: entry.level,
      target: entry.target ? redact(entry.target) : undefined,
      result: entry.result ? redact(entry.result) : undefined,
      detail: entry.detail ? redact(entry.detail) : undefined,
    };
    this.recent.push(e);
    if (this.recent.length > this.memoryLimit) this.recent.splice(0, this.recent.length - this.memoryLimit);
    try {
      this.ensureDir();
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n', 'utf8');
    } catch (err) { /* 静默：文件权限/磁盘满都不该影响对话 */ }
    return e;
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const st = fs.statSync(this.file);
      if (st.size < this.maxBytes) return;
      const old = this.file + '.1';
      try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) { /* ignore */ }
      fs.renameSync(this.file, old);
    } catch (e) { /* ignore */ }
  }

  /** 查询：默认返回最近 limit 条，按时间正序 */
  query(opts: QueryOptions = {}): AuditEntry[] {
    this.loadRecent();
    const limit = Math.max(1, Math.min(2000, opts.limit ?? 100));
    let rows = this.recent.slice();
    if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind);
    if (opts.tool) rows = rows.filter((r) => r.tool === opts.tool);
    if (opts.sinceMs) rows = rows.filter((r) => r.at >= opts.sinceMs!);
    return rows.slice(-limit);
  }

  /** 统计（给面板做概览） */
  stats(sinceMs?: number): { total: number; denied: number; allowed: number; lastAt: number } {
    this.loadRecent();
    const rows = sinceMs ? this.recent.filter((r) => r.at >= sinceMs) : this.recent;
    return {
      total: rows.length,
      denied: rows.filter((r) => r.kind === 'tool.deny').length,
      allowed: rows.filter((r) => r.kind === 'tool.allow').length,
      lastAt: rows.length ? rows[rows.length - 1].at : 0,
    };
  }

  /** 清空（维护中心用，需二次确认） */
  clear(): number {
    const n = this.recent.length;
    this.recent = [];
    try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (e) { /* ignore */ }
    try { const old = this.file + '.1'; if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) { /* ignore */ }
    return n;
  }

  filePath(): string { return this.file; }
}
