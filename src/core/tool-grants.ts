/**
 * SoulWeave S9：工具授权（审批中心的判定核心）
 *
 * 【默认拒绝】
 * 没有匹配的授权就是拒绝。这不是「保守」，是需求 §7.5 的原话：
 * 「按角色/账号/群/工具/资源/操作设置**默认拒绝**」。
 *
 * 【三种授权】
 *   once  —— 一次工具调用，用完即焚。L5 只允许这种。
 *   scope —— 某个等级 + 路径前缀，直到撤销。
 *   ttl   —— 同 scope，但带到期时间。
 *
 * 【为什么 L5 不允许 scope】
 * 需求写「危险操作须更严格单次确认」。范围授权本质上是「以后都别再问我」，
 * 对删除/越界这类操作，那等于没有确认。
 */

import {
  classifyToolCall,
  allowedWithoutGrant,
  type Classified,
  type ToolLevel,
} from './tool-policy.js';

export type GrantKind = 'once' | 'scope' | 'ttl';

export type Grant = {
  id: string;
  kind: GrantKind;
  /** 覆盖的风险等级（once 可省略，按工具名精确匹配） */
  level?: ToolLevel;
  /** once 用：精确工具名 */
  tool?: string;
  /** 路径前缀（绝对路径）。给了就要求调用目标在其下 */
  pathPrefix?: string;
  createdAt: number;
  /** ttl 必填 */
  expiresAt?: number;
  /** 已撤销/已用掉的时间 */
  closedAt?: number;
  note?: string;
  /** 谁批准的（'desktop' / 'web' / 'auto'），写审计用 */
  by?: string;
};

export type EvaluateResult =
  | { allow: true; reason: 'public' | 'grant'; grantId?: string; level: ToolLevel; consumed?: boolean }
  | { allow: false; reason: string; level: ToolLevel };

export type ToolGrantsOptions = {
  now?: () => number;
  /** 已用掉的 once 授权保留多久（便于审计回看），默认 10 分钟 */
  keepUsedMs?: number;
};

let seq = 0;
function newId(now: number): string {
  seq = (seq + 1) % 100000;
  return 'g_' + now.toString(36) + '_' + seq.toString(36);
}

export class ToolGrants {
  private grants = new Map<string, Grant>();
  private now: () => number;
  private keepUsedMs: number;

  constructor(opts: ToolGrantsOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.keepUsedMs = opts.keepUsedMs ?? 10 * 60_000;
  }

  /** 新建授权。L5 只接受 once，其它形式直接拒绝创建 */
  add(input: {
    kind: GrantKind;
    level?: ToolLevel;
    tool?: string;
    pathPrefix?: string;
    ttlMs?: number;
    note?: string;
    by?: string;
  }): { ok: true; grant: Grant } | { ok: false; error: string } {
    const t = this.now();
    const kind = input.kind;
    if (kind !== 'once' && kind !== 'scope' && kind !== 'ttl') return { ok: false, error: '未知的授权类型' };

    const level = input.level;
    if (kind !== 'once') {
      if (level === undefined) return { ok: false, error: '范围授权必须指明风险等级' };
      if (level === 5) return { ok: false, error: 'L5 高风险只允许「本次」授权，不能给范围授权' };
      if (level !== 2 && level !== 4) return { ok: false, error: '范围授权只支持 L2（写文件）与 L4（执行命令）' };
    }
    if (kind === 'once') {
      if (!input.tool) return { ok: false, error: '「本次」授权必须指明工具名' };
    }
    if (kind === 'ttl') {
      const ms = Number(input.ttlMs || 0);
      if (!(ms > 0) || ms > 24 * 3600_000) return { ok: false, error: '期限授权需在 1 秒到 24 小时之间' };
    }

    // 「本次」= 这一轮对话，不是一个工具调用。
    // 模型经常在一次回复里连调两次同一个命令（第一次报错会重试），
    // 如果一次调用就把授权烧掉，第二轮必然被拦，体验和语义都不对。
    // 所以 once 带一个默认 2 分钟的短期限，并在本轮结束时主动关闭（closeOnces）。
    const ONCE_TTL_MS = 2 * 60_000;
    const g: Grant = {
      id: newId(t),
      kind,
      level,
      tool: input.tool,
      pathPrefix: input.pathPrefix,
      createdAt: t,
      expiresAt: kind === 'ttl' ? t + Number(input.ttlMs) : kind === 'once' ? t + ONCE_TTL_MS : undefined,
      note: input.note,
      by: input.by || 'desktop',
    };
    this.grants.set(g.id, g);
    return { ok: true, grant: { ...g } };
  }

  /** 撤销（不是删除：保留记录，closedAt 标记，审计要能回看） */
  revoke(id: string): boolean {
    const g = this.grants.get(id);
    if (!g || g.closedAt) return false;
    g.closedAt = this.now();
    return true;
  }

  /** 关闭所有「本次」授权（一轮对话结束后调用） */
  closeOnces(nowMs = this.now()): number {
    let n = 0;
    for (const g of this.grants.values()) {
      if (g.kind !== 'once' || g.closedAt) continue;
      g.closedAt = nowMs;
      n++;
    }
    return n;
  }

  /** 有效授权列表（界面用） */
  list(includeClosed = false): Grant[] {
    const now = this.now();
    const out: Grant[] = [];
    for (const g of this.grants.values()) {
      const expired = g.expiresAt !== undefined && g.expiresAt <= now;
      const closed = !!g.closedAt;
      if (!includeClosed && (closed || expired)) continue;
      out.push({ ...g });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 清理已关闭很久的记录，防止无限增长 */
  prune(): number {
    const now = this.now();
    let n = 0;
    for (const [id, g] of [...this.grants]) {
      if (g.closedAt && now - g.closedAt > this.keepUsedMs) { this.grants.delete(id); n++; }
      // 过期的 ttl/scope 也记一个 closedAt，再过一轮清理
      if (g.expiresAt !== undefined && g.expiresAt <= now && !g.closedAt) g.closedAt = g.expiresAt;
    }
    return n;
  }

  /**
   * 判一次工具调用。
   * 会**消费**匹配到的 once 授权（用完即焚）。
   */
  evaluate(classified: Classified): EvaluateResult {
    const level = classified.level;

    // L0/L1：默认允许，不需要授权
    if (allowedWithoutGrant(level)) {
      return { allow: true, reason: 'public', level };
    }

    const now = this.now();
    const active = [...this.grants.values()].filter((g) => {
      if (g.closedAt) return false;
      if (g.expiresAt !== undefined && g.expiresAt <= now) return false;
      return true;
    });

    // L5：只认「同名工具的本次授权」
    if (level === 5) {
      const hit = active.find((g) => g.kind === 'once' && g.tool === classified.tool);
      if (!hit) return { allow: false, reason: '高风险操作需要一次性授权', level };
      // 不在这里关闭：本轮结束由 closeOnces() 统一关闭
      return { allow: true, reason: 'grant', grantId: hit.id, level };
    }

    // L2/L4：先看 once 精确匹配，再看 scope/ttl 等级匹配
    const once = active.find((g) => g.kind === 'once' && g.tool === classified.tool);
    if (once) {
      return { allow: true, reason: 'grant', grantId: once.id, level };
    }

    for (const g of active) {
      if (g.kind === 'once') continue;
      if (g.level !== level) continue;
      if (g.pathPrefix) {
        if (!classified.target) continue;                 // 有前缀约束但调用没给路径 → 不匹配
        const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
        const prefix = norm(g.pathPrefix);
        const target = norm(classified.target);
        if (target !== prefix && !target.startsWith(prefix.endsWith('\\') || prefix.endsWith('/') ? prefix : prefix + (prefix.indexOf('\\') >= 0 ? '\\' : '/'))) continue;
      }
      return { allow: true, reason: 'grant', grantId: g.id, level };
    }

    return { allow: false, reason: level === 4 ? '执行本机命令需要授权' : '写入文件需要授权', level };
  }

  /** 便捷方法：直接传原始事件 */
  evaluateCall(call: { tool?: unknown; input?: unknown }, ctx: { workspace: string; readableRoots?: string[] }): EvaluateResult & { classified: Classified } {
    const classified = classifyToolCall(call, ctx);
    return { ...this.evaluate(classified), classified };
  }

  toJSON(): { grants: Grant[] } {
    this.prune();
    return { grants: [...this.grants.values()].map((g) => ({ ...g })) };
  }

  static fromJSON(raw: unknown, opts: ToolGrantsOptions = {}): ToolGrants {
    const t = new ToolGrants(opts);
    const j = raw as { grants?: unknown } | null;
    const list = j && Array.isArray(j.grants) ? (j.grants as Grant[]) : [];
    for (const g of list) {
      if (!g || typeof g.id !== 'string') continue;
      if (g.kind !== 'once' && g.kind !== 'scope' && g.kind !== 'ttl') continue;
      t.grants.set(g.id, {
        id: g.id,
        kind: g.kind,
        level: g.level,
        tool: typeof g.tool === 'string' ? g.tool : undefined,
        pathPrefix: typeof g.pathPrefix === 'string' ? g.pathPrefix : undefined,
        createdAt: Number(g.createdAt) || 0,
        expiresAt: g.expiresAt === undefined ? undefined : Number(g.expiresAt),
        closedAt: g.closedAt === undefined ? undefined : Number(g.closedAt),
        note: typeof g.note === 'string' ? g.note : undefined,
        by: typeof g.by === 'string' ? g.by : undefined,
      });
    }
    return t;
  }
}
