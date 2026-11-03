/**
 * SoulWeave S8：手机 Web / 远程访问的认证内核
 *
 * 【为什么单独成文件】
 * 认证是最不能出错的一块，也是最不该和 Electron 绑在一起的一块。
 * 这里只有纯逻辑 + node:crypto，不 import electron、不读文件、不碰网络，
 * 所以能被 scripts/test-web-auth.mjs 完整覆盖。持久化留给调用方。
 *
 * 【为什么不用「账号 + 密码」】
 * 单用户本机应用，密码只有一个。它会同时被弱口令、密码复用和撞库盯上，
 * 而收益又撑不起一套完整账号体系。改用**设备配对**：
 *
 *   桌面显示 6 位配对码 → 手机输码 → 换一张长期「设备令牌」
 *   → 每次打开用设备令牌换短命「会话令牌」
 *
 * 配对码一次性、5 分钟过期、错 5 次作废；
 * 设备令牌只在配对成功那一次返回明文，服务端只存 sha256 ——
 * 配置落盘泄漏也反推不出可用令牌。
 *
 * 【时序攻击】
 * 令牌比较一律走 crypto.timingSafeEqual，长度不同直接 false。
 * 不要用 === —— 字符串比较会提前返回，攻击者能靠响应时间逐字节猜。
 */

import crypto from 'node:crypto';

// ── 作用域 ─────────────────────────────────────────────

/** 全部作用域。新增作用域必须同时更新 DEFAULT_SCOPES 或 ADMIN_ONLY_SCOPES */
export const ALL_SCOPES = [
  'view',          // 看角色、状态、在线情况
  'chat',          // 发消息、收流式回复
  'memory:read',   // 读记忆（脱敏）
  'social:read',   // 读 QQ 连接状态与白名单（号码脱敏）
  'memory:write',  // 改记忆
  'admin',         // 改配置、开关服务、撤销设备
] as const;

export type WebScope = (typeof ALL_SCOPES)[number];

/** 配对成功后自动授予的最小集合 */
export const DEFAULT_SCOPES: WebScope[] = ['view', 'chat', 'memory:read', 'social:read'];

/** 必须回桌面点「批准」才能拿到的作用域 */
export const ADMIN_ONLY_SCOPES: WebScope[] = ['memory:write', 'admin'];

export function isScope(x: unknown): x is WebScope {
  return typeof x === 'string' && (ALL_SCOPES as readonly string[]).includes(x);
}

export function normalizeScopes(input: unknown): WebScope[] {
  const arr = Array.isArray(input) ? input : [];
  const out: WebScope[] = [];
  for (const s of arr) if (isScope(s) && !out.includes(s)) out.push(s);
  return out;
}

/** a 是否包含 b 的全部作用域 */
export function scopesCover(a: WebScope[], b: WebScope[]): boolean {
  return b.every((s) => a.includes(s));
}

// ── 基础工具 ───────────────────────────────────────────

/** 32 字节随机 → base64url（无填充），约 43 字符 */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 常量时间字符串比较。
 * 长度不同直接 false —— 长度本身不是秘密（我们生成的令牌长度固定）。
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 6 位数字配对码，去掉前导零歧义（仍保留 000000 之外的全部组合） */
export function generatePairingCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 恒定时间比较配对码（同样是长度先判） */
export function safeCompareCode(a: string, b: string): boolean {
  return timingSafeEqualStr(String(a).trim(), String(b).trim());
}

// ── 类型 ───────────────────────────────────────────────

export type DeviceRecord = {
  id: string;
  /** 人类可读标签，如「iPhone · Safari」 */
  label: string;
  /** 设备令牌的 sha256，不是令牌本身 */
  tokenHash: string;
  scopes: WebScope[];
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  revokedAt: number | null;
};

export type SessionRecord = {
  tokenHash: string;
  deviceId: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;   // 绝对过期
  ip: string;
};

export type AuditKind =
  | 'pair.ok' | 'pair.bad' | 'pair.expired' | 'pair.locked'
  | 'session.ok' | 'session.bad' | 'session.expired'
  | 'auth.deny' | 'auth.ok'
  | 'device.revoke' | 'scope.grant'
  | 'approval.request' | 'approval.approve' | 'approval.deny'
  | 'ratelimit.lock';

export type AuditEntry = {
  at: number;
  kind: AuditKind;
  ip: string;
  deviceId?: string;
  detail?: string;
};

export type AuthFailReason =
  | 'disabled'
  | 'rate_limited'
  | 'no_code'
  | 'code_expired'
  | 'code_locked'
  | 'code_wrong'
  | 'bad_token'
  | 'device_revoked'
  | 'session_expired'
  | 'no_session'
  | 'forbidden'
  | 'unknown_device';

export type Ok<T> = { ok: true } & T;
export type Err = { ok: false; reason: AuthFailReason; retryAfterMs?: number };

export type WebAuthOptions = {
  /** 可注入时钟，测试用 */
  now?: () => number;
  /** 配对码有效期，默认 5 分钟 */
  pairTtlMs?: number;
  /** 配对码最多输错次数，默认 5 */
  pairMaxAttempts?: number;
  /** 会话闲置过期，默认 30 分钟 */
  sessionIdleMs?: number;
  /** 会话绝对过期，默认 12 小时 */
  sessionAbsoluteMs?: number;
  /** 连续失败多少次锁定，默认 10 */
  lockAfter?: number;
  /** 锁定时长，默认 15 分钟 */
  lockMs?: number;
  /** 退避上限，默认 60 秒 */
  maxBackoffMs?: number;
  /** 审计环形缓冲上限，默认 500 */
  auditLimit?: number;
};

type PairState = {
  code: string;
  expiresAt: number;
  attempts: number;
  locked: boolean;
};

type RateState = {
  fails: number;
  lockedUntil: number;
  lastFailAt: number;
};

// ── 主体 ───────────────────────────────────────────────

export class WebAuth {
  private now: () => number;
  private pairTtlMs: number;
  private pairMaxAttempts: number;
  private sessionIdleMs: number;
  private sessionAbsoluteMs: number;
  private lockAfter: number;
  private lockMs: number;
  private maxBackoffMs: number;
  private auditLimit: number;

  private pairing: PairState | null = null;
  private devices = new Map<string, DeviceRecord>();
  private sessions = new Map<string, SessionRecord>();   // key = tokenHash
  private rates = new Map<string, RateState>();
  private audit: AuditEntry[] = [];
  private approvals = new Map<string, { id: string; deviceId: string; scopes: WebScope[]; at: number; ip: string }>();

  constructor(opts: WebAuthOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.pairTtlMs = opts.pairTtlMs ?? 5 * 60_000;
    this.pairMaxAttempts = opts.pairMaxAttempts ?? 5;
    this.sessionIdleMs = opts.sessionIdleMs ?? 30 * 60_000;
    this.sessionAbsoluteMs = opts.sessionAbsoluteMs ?? 12 * 60 * 60_000;
    this.lockAfter = opts.lockAfter ?? 10;
    this.lockMs = opts.lockMs ?? 15 * 60_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.auditLimit = opts.auditLimit ?? 500;
  }

  // ── 审计 ──

  private log(kind: AuditKind, ip: string, deviceId?: string, detail?: string): void {
    this.audit.push({ at: this.now(), kind, ip: ip || '', deviceId, detail });
    if (this.audit.length > this.auditLimit) this.audit.splice(0, this.audit.length - this.auditLimit);
  }

  auditLog(limit = 100): AuditEntry[] {
    return this.audit.slice(-Math.max(1, limit));
  }

  // ── 限速 ──

  /**
   * 指数退避：第 n 次失败后需要等 min(2^(n-1) * 1s, 60s)。
   * 连续失败到 lockAfter 次直接锁 15 分钟，期间连试都不许试。
   */
  checkRate(key: string, ip: string): { ok: true } | Err {
    const st = this.rates.get(key);
    if (!st) return { ok: true };
    const t = this.now();
    if (st.lockedUntil > t) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: st.lockedUntil - t };
    }
    const backoff = Math.min(Math.pow(2, Math.max(0, st.fails - 1)) * 1000, this.maxBackoffMs);
    if (st.fails > 0 && t - st.lastFailAt < backoff) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: backoff - (t - st.lastFailAt) };
    }
    void ip;
    return { ok: true };
  }

  noteFailure(key: string, ip: string): void {
    const t = this.now();
    const st = this.rates.get(key) ?? { fails: 0, lockedUntil: 0, lastFailAt: 0 };
    st.fails += 1;
    st.lastFailAt = t;
    if (st.fails >= this.lockAfter) {
      st.lockedUntil = t + this.lockMs;
      this.log('ratelimit.lock', ip, undefined, key.startsWith('ip:') ? key : 'token');
    }
    this.rates.set(key, st);
  }

  noteSuccess(key: string): void {
    this.rates.delete(key);
  }

  // ── 配对码 ──

  /** 生成新的配对码；旧的立即作废（同时只允许一个待配对） */
  issuePairingCode(): { code: string; expiresAt: number } {
    const code = generatePairingCode();
    this.pairing = { code, expiresAt: this.now() + this.pairTtlMs, attempts: 0, locked: false };
    return { code, expiresAt: this.pairing.expiresAt };
  }

  /** 当前配对码状态（给桌面界面显示倒计时），没有就 null */
  pairingState(): { active: boolean; expiresAt: number; attemptsLeft: number; code?: string } {
    if (!this.pairing || this.pairing.locked) return { active: false, expiresAt: 0, attemptsLeft: 0 };
    const left = this.pairing.expiresAt - this.now();
    if (left <= 0) return { active: false, expiresAt: 0, attemptsLeft: 0 };
    return {
      active: true,
      expiresAt: this.pairing.expiresAt,
      attemptsLeft: Math.max(0, this.pairMaxAttempts - this.pairing.attempts),
      // 码本身要给本机桌面界面显示（否则重绘后用户看不到自己刚生成的码）。
      // 它 5 分钟过期、一次性、最多试 5 次，泄漏窗口极小。
      code: this.pairing.code,
    };
  }

  /** 主动作废配对码（关闭 Web 访问时调用） */
  cancelPairing(): void {
    this.pairing = null;
  }

  /**
   * 用配对码换设备令牌。
   * 成功返回**明文令牌**（只此一次），之后服务端只保留 sha256。
   */
  pair(
    code: string,
    ctx: { ip: string; label?: string; userAgent?: string }
  ): Ok<{ token: string; deviceId: string; scopes: WebScope[] }> | Err {
    const ip = ctx.ip || '';
    const limited = this.checkRate('pair:' + ip, ip);
    if (!limited.ok) return limited;

    if (!this.pairing) {
      this.noteFailure('pair:' + ip, ip);
      this.log('pair.bad', ip, undefined, 'no_code');
      return { ok: false, reason: 'no_code' };
    }
    if (this.pairing.locked) {
      this.log('pair.locked', ip);
      return { ok: false, reason: 'code_locked' };
    }
    if (this.pairing.expiresAt <= this.now()) {
      this.log('pair.expired', ip);
      this.pairing = null;
      return { ok: false, reason: 'code_expired' };
    }

    if (!safeCompareCode(code, this.pairing.code)) {
      this.pairing.attempts += 1;
      this.noteFailure('pair:' + ip, ip);
      const left = this.pairMaxAttempts - this.pairing.attempts;
      if (left <= 0) {
        this.pairing.locked = true;
        this.log('pair.locked', ip, undefined, 'too_many_attempts');
        return { ok: false, reason: 'code_locked' };
      }
      this.log('pair.bad', ip, undefined, 'wrong_code');
      return { ok: false, reason: 'code_wrong' };
    }

    // 成功：配对码一次性使用
    this.pairing = null;
    this.noteSuccess('pair:' + ip);

    const token = randomToken(32);
    const id = 'dev_' + randomToken(9);
    const label = sanitizeLabel(ctx.label || ctx.userAgent || '') || '未命名设备';
    const rec: DeviceRecord = {
      id,
      label,
      tokenHash: sha256Hex(token),
      scopes: [...DEFAULT_SCOPES],
      createdAt: this.now(),
      lastSeenAt: this.now(),
      lastIp: ip,
      revokedAt: null,
    };
    this.devices.set(id, rec);
    this.log('pair.ok', ip, id, label);
    return { ok: true, token, deviceId: id, scopes: [...rec.scopes] };
  }

  // ── 设备 ──

  listDevices(): Array<Omit<DeviceRecord, 'tokenHash'>> {
    return [...this.devices.values()].map((d) => {
      const { tokenHash, ...rest } = d;
      void tokenHash;
      return rest;
    });
  }

  getDevice(id: string): DeviceRecord | null {
    return this.devices.get(id) ?? null;
  }

  private findDeviceByToken(token: string): DeviceRecord | null {
    if (!token) return null;
    const h = sha256Hex(token);
    for (const d of this.devices.values()) {
      // 先比长度，再常量时间比较，避免遍历时泄漏信息
      if (timingSafeEqualStr(d.tokenHash, h)) return d;
    }
    return null;
  }

  revokeDevice(id: string, ip = ''): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    d.revokedAt = this.now();
    // 同时踢掉该设备的所有会话
    for (const [k, s] of [...this.sessions]) if (s.deviceId === id) this.sessions.delete(k);
    this.log('device.revoke', ip, id);
    return true;
  }

  /** 桌面批准后授予额外作用域 */
  grantScopes(deviceId: string, scopes: unknown, ip = ''): WebScope[] | null {
    const d = this.devices.get(deviceId);
    if (!d || d.revokedAt) return null;
    const add = normalizeScopes(scopes);
    const merged = [...d.scopes];
    for (const s of add) if (!merged.includes(s)) merged.push(s);
    d.scopes = merged;
    this.log('scope.grant', ip, deviceId, add.join(','));
    return [...merged];
  }

  // ── 会话 ──

  /** 设备令牌 → 会话令牌 */
  createSession(
    deviceToken: string,
    ctx: { ip: string }
  ): Ok<{ token: string; deviceId: string; scopes: WebScope[]; expiresAt: number }> | Err {
    const ip = ctx.ip || '';
    const limited = this.checkRate('tok:' + sha256Hex(deviceToken || '').slice(0, 16), ip);
    if (!limited.ok) return limited;

    const d = this.findDeviceByToken(deviceToken);
    if (!d) {
      this.noteFailure('tok:' + sha256Hex(deviceToken || '').slice(0, 16), ip);
      this.log('session.bad', ip, undefined, 'bad_token');
      return { ok: false, reason: 'bad_token' };
    }
    if (d.revokedAt) {
      this.log('session.bad', ip, d.id, 'revoked');
      return { ok: false, reason: 'device_revoked' };
    }

    const token = randomToken(32);
    const t = this.now();
    const expiresAt = t + this.sessionAbsoluteMs;
    this.sessions.set(sha256Hex(token), {
      tokenHash: sha256Hex(token),
      deviceId: d.id,
      createdAt: t,
      lastUsedAt: t,
      expiresAt,
      ip,
    });
    d.lastSeenAt = t;
    d.lastIp = ip;
    this.log('session.ok', ip, d.id);
    return { ok: true, token, deviceId: d.id, scopes: [...d.scopes], expiresAt };
  }

  destroySession(sessionToken: string): void {
    if (!sessionToken) return;
    this.sessions.delete(sha256Hex(sessionToken));
  }

  /**
   * 这个会话令牌是不是我们发出去的？（只查表，不校验过期）
   *
   * 用途：限速闸门只该拦「猜令牌」的请求。
   * 已经在我们表里的令牌不可能是猜出来的，没必要让它等退避 ——
   * 否则用户刚打错一次，接下来 1 秒内连自己的正常请求都会被 429。
   */
  hasSession(sessionToken: string): boolean {
    if (!sessionToken) return false;
    return this.sessions.has(sha256Hex(sessionToken));
  }

  /** 清掉所有会话（关闭 Web 访问时调用） */
  destroyAllSessions(): void {
    this.sessions.clear();
  }

  /**
   * 校验会话是否允许某个作用域。
   * 每次调用都会刷新 lastUsedAt，并顺带做过期清理。
   */
  authorize(
    sessionToken: string,
    scope: WebScope,
    ip = ''
  ): Ok<{ deviceId: string; scopes: WebScope[]; expiresAt: number }> | Err {
    const h = sha256Hex(sessionToken || '');
    const s = this.sessions.get(h);
    if (!s) {
      this.log('auth.deny', ip, undefined, 'no_session');
      return { ok: false, reason: 'no_session' };
    }
    const t = this.now();
    if (t >= s.expiresAt || t - s.lastUsedAt > this.sessionIdleMs) {
      this.sessions.delete(h);
      this.log('session.expired', ip, s.deviceId);
      return { ok: false, reason: 'session_expired' };
    }
    const d = this.devices.get(s.deviceId);
    if (!d || d.revokedAt) {
      this.sessions.delete(h);
      this.log('auth.deny', ip, s.deviceId, 'device_revoked');
      return { ok: false, reason: 'device_revoked' };
    }
    if (!d.scopes.includes(scope)) {
      this.log('auth.deny', ip, d.id, 'scope:' + scope);
      return { ok: false, reason: 'forbidden' };
    }
    s.lastUsedAt = t;
    d.lastSeenAt = t;
    this.log('auth.ok', ip, d.id, scope);
    return { ok: true, deviceId: d.id, scopes: [...d.scopes], expiresAt: s.expiresAt };
  }

  /** 会话数（给状态面板） */
  sessionCount(): number {
    const t = this.now();
    let n = 0;
    for (const [k, s] of [...this.sessions]) {
      if (t >= s.expiresAt || t - s.lastUsedAt > this.sessionIdleMs) this.sessions.delete(k);
      else n++;
    }
    return n;
  }

  // ── 高风险作用域的桌面批准 ──

  /** Web 端申请额外作用域 → 桌面待批准列表 */
  requestApproval(
    sessionToken: string,
    scopes: unknown,
    ip = ''
  ): Ok<{ approvalId: string }> | Err {
    const h = sha256Hex(sessionToken || '');
    const s = this.sessions.get(h);
    if (!s) return { ok: false, reason: 'no_session' };
    const d = this.devices.get(s.deviceId);
    if (!d || d.revokedAt) return { ok: false, reason: 'device_revoked' };

    const want = normalizeScopes(scopes).filter((x) => ADMIN_ONLY_SCOPES.includes(x));
    if (!want.length) return { ok: false, reason: 'forbidden' };

    const id = 'apr_' + randomToken(9);
    this.approvals.set(id, { id, deviceId: d.id, scopes: want, at: this.now(), ip: ip || '' });
    this.log('approval.request', ip, d.id, want.join(','));
    return { ok: true, approvalId: id };
  }

  pendingApprovals(): Array<{ id: string; deviceId: string; label: string; scopes: WebScope[]; at: number }> {
    return [...this.approvals.values()].map((a) => ({
      id: a.id,
      deviceId: a.deviceId,
      label: this.devices.get(a.deviceId)?.label || a.deviceId,
      scopes: [...a.scopes],
      at: a.at,
    }));
  }

  /** 桌面点「批准」 */
  approve(approvalId: string, ip = ''): { ok: boolean; deviceId?: string; scopes?: WebScope[] } {
    const a = this.approvals.get(approvalId);
    if (!a) return { ok: false };
    this.approvals.delete(approvalId);
    const merged = this.grantScopes(a.deviceId, a.scopes, ip || a.ip);
    if (!merged) return { ok: false };
    this.log('approval.approve', ip, a.deviceId, a.scopes.join(','));
    return { ok: true, deviceId: a.deviceId, scopes: merged };
  }

  /** 桌面点「拒绝」 */
  deny(approvalId: string, ip = ''): boolean {
    const a = this.approvals.get(approvalId);
    if (!a) return false;
    this.approvals.delete(approvalId);
    this.log('approval.deny', ip, a.deviceId);
    return true;
  }

  // ── 持久化（只存摘要，永不存明文） ──

  /**
   * 落盘前清理历史设备。
   *
   * 【为什么需要】每配一次对就留一条记录。验收脚本跑十几轮之后，
   * 文件里堆了一堆早就撤销的测试设备 —— 只存哈希不占多少空间，
   * 但会让「设备列表」和排障变得难读。
   *
   * 规则：已撤销且超过 30 天的丢掉；总数超过 100 时保留最新的。
   * 未撤销的设备**永远保留**，绝不因为"旧"就悄悄踢掉。
   */
  pruneDevices(nowMs = this.now()): number {
    const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [id, d] of [...this.devices]) {
      if (d.revokedAt != null && nowMs - d.revokedAt > RETAIN_MS) {
        this.devices.delete(id);
        removed++;
      }
    }
    // 已撤销的只留最近 20 台做「历史」，未撤销的永远不裁
    const MAX_REVOKED = 20;
    const revoked = [...this.devices.values()].filter((d) => d.revokedAt != null)
      .sort((a, b) => (b.revokedAt || 0) - (a.revokedAt || 0));
    for (const d of revoked.slice(MAX_REVOKED)) {
      this.devices.delete(d.id);
      removed++;
    }
    return removed;
  }

  toJSON(): { devices: DeviceRecord[] } {
    this.pruneDevices();
    return { devices: [...this.devices.values()].map((d) => ({ ...d, scopes: [...d.scopes] })) };
  }

  static fromJSON(raw: unknown, opts: WebAuthOptions = {}): WebAuth {
    const a = new WebAuth(opts);
    const j = raw as { devices?: unknown } | null;
    const list = j && Array.isArray(j.devices) ? j.devices : [];
    for (const d of list as DeviceRecord[]) {
      if (!d || typeof d.id !== 'string' || typeof d.tokenHash !== 'string') continue;
      // 只接受 64 位十六进制摘要，防止有人手改配置塞进明文令牌
      if (!/^[0-9a-f]{64}$/i.test(d.tokenHash)) continue;
      a.devices.set(d.id, {
        id: d.id,
        label: sanitizeLabel(String(d.label || '')) || '未命名设备',
        tokenHash: d.tokenHash.toLowerCase(),
        scopes: normalizeScopes(d.scopes),
        createdAt: Number(d.createdAt) || 0,
        lastSeenAt: Number(d.lastSeenAt) || 0,
        lastIp: String(d.lastIp || ''),
        revokedAt: d.revokedAt == null ? null : Number(d.revokedAt),
      });
    }
    return a;
  }
}

/** 标签只保留可见字符，限长，去掉换行与控制符（会写进界面和审计） */
export function sanitizeLabel(s: string): string {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}
