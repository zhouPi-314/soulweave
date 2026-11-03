/**
 * SoulWeave：角色 ↔ 智能体绑定
 *
 * 【规则（负责人已确认）】
 * 1. 一个角色**只能绑定一个**智能体。
 * 2. **绑定后不可更换** —— 想换只能新建一个角色（为将来多本地角色预留）。
 * 3. 只有 capability='sdk' 的智能体能真正绑定；其余在界面上明确标为不支持。
 * 4. 绑定关系与预算存在独立文件里，不塞进 config-schema（避免影响既有 69 项测试）。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AgentBinding {
  agentId: string;
  /** ISO 时间 */
  boundAt: string;
  agentPath?: string;
  agentVersion?: string;
}

export interface AgentBudget {
  /** 上限（人民币元） */
  limitCny: number;
  /** 已用（人民币元） */
  usedCny: number;
  /** 累计 token（上游提供 usage 时才计入） */
  tokensUsed: number;
  /** 累计费用（人民币，按定价表估算） */
  costCny: number;
  /** USD→CNY 汇率（用户可改，默认 7.2） */
  usdToCny: number;
  /** 最近一次用量明细 */
  lastUsage?: { prompt?: number; completion?: number; cacheRead?: number; total?: number };
  /** 预警比例（0–1），达到 limitCny × 该比例即预警 */
  warnRatio: number;
  /** 最后更新时间 */
  updatedAt: string;
}

interface Store {
  version: number;
  bindings: Record<string, AgentBinding>;
  budget: AgentBudget;
}

const DEFAULT_BUDGET: AgentBudget = {
  limitCny: 30,
  usedCny: 0,
  tokensUsed: 0,
  costCny: 0,
  usdToCny: 7.2,
  warnRatio: 0.8,
  updatedAt: new Date(0).toISOString(),
};

export class AgentBindingStore {
  private file: string;
  private data: Store;

  constructor(dir: string) {
    this.file = path.join(dir, 'agent-bindings.json');
    this.data = this.load();
    this.normalizeBudget();
  }

  private load(): Store {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        // 合并默认值：旧版本文件缺新字段（tokensUsed / tokenWarnAt）时补上，
        // 否则它们会是 undefined，序列化后变 null，界面显示「已用 token: null」
        return {
          version: j.version || 1,
          bindings: j.bindings || {},
          budget: Object.assign({}, DEFAULT_BUDGET, j.budget || {}),
        };
      }
    } catch (e) { /* 损坏时回到默认，不让应用起不来 */ }
    return { version: 1, bindings: {}, budget: { ...DEFAULT_BUDGET } };
  }

  /** 把可能的 null / 缺字段修正成合法数字 */
  private normalizeBudget(): void {
    const b2: any = this.data.budget;
    if (typeof b2.limitCny !== 'number' || !isFinite(b2.limitCny)) b2.limitCny = DEFAULT_BUDGET.limitCny;
    if (typeof b2.usedCny !== 'number' || !isFinite(b2.usedCny)) b2.usedCny = 0;
    if (typeof b2.tokensUsed !== 'number' || !isFinite(b2.tokensUsed)) b2.tokensUsed = 0;
    if (typeof b2.costCny !== 'number' || !isFinite(b2.costCny)) b2.costCny = 0;
    if (typeof b2.usdToCny !== 'number' || !isFinite(b2.usdToCny) || b2.usdToCny <= 0) b2.usdToCny = DEFAULT_BUDGET.usdToCny;
    if (typeof b2.warnRatio !== 'number' || !isFinite(b2.warnRatio) || b2.warnRatio <= 0 || b2.warnRatio > 1) b2.warnRatio = DEFAULT_BUDGET.warnRatio;
    if (!b2.updatedAt) b2.updatedAt = new Date(0).toISOString();
  }

  private save(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (e) { return false; }
  }

  /** 读某角色的绑定 */
  get(characterId: string): AgentBinding | null {
    return this.data.bindings[characterId] || null;
  }

  /** 全部绑定 */
  all(): Record<string, AgentBinding> { return { ...this.data.bindings }; }

  /**
   * 绑定。**一旦已绑定，拒绝再次绑定** —— 这是负责人确认的硬规则。
   */
  bind(characterId: string, agentId: string, meta?: { path?: string; version?: string }):
    { ok: true; binding: AgentBinding } | { ok: false; error: string; existing?: AgentBinding } {
    const existing = this.data.bindings[characterId];
    if (existing) {
      return {
        ok: false,
        error: '该角色已绑定智能体（' + existing.agentId + '），绑定后不可更换。' +
               '如需使用其他智能体，请新建一个角色。',
        existing,
      };
    }
    const binding: AgentBinding = {
      agentId,
      boundAt: new Date().toISOString(),
      agentPath: meta?.path,
      agentVersion: meta?.version,
    };
    this.data.bindings[characterId] = binding;
    if (!this.save()) return { ok: false, error: '绑定信息写入失败' };
    return { ok: true, binding };
  }

  /** 预算 */
  budget(): AgentBudget { return { ...this.data.budget }; }

  setBudgetLimit(limitCny: number): { ok: boolean; budget?: AgentBudget; error?: string } {
    const v = Number(limitCny);
    if (!isFinite(v) || v < 0) return { ok: false, error: '预算必须是非负数' };
    this.data.budget.limitCny = v;
    this.data.budget.updatedAt = new Date().toISOString();
    if (!this.save()) return { ok: false, error: '预算写入失败' };
    return { ok: true, budget: this.budget() };
  }

  /** 记一次消费；超预算返回 blocked */
  spend(cny: number): { ok: boolean; blocked: boolean; budget: AgentBudget; error?: string } {
    const cost = Number(cny);
    if (!isFinite(cost) || cost < 0) return { ok: false, blocked: false, budget: this.budget(), error: '金额无效' };
    const b = this.data.budget;
    if (b.limitCny > 0 && b.usedCny + cost > b.limitCny) {
      return { ok: false, blocked: true, budget: this.budget(), error: '已超出预算上限 ' + b.limitCny + ' 元' };
    }
    b.usedCny = Math.round((b.usedCny + cost) * 10000) / 10000;
    b.updatedAt = new Date().toISOString();
    this.save();
    return { ok: true, blocked: false, budget: this.budget() };
  }

  /**
   * 记一次用量：token 数 + 费用（费用按定价表估算）。
   * @param tokens 归一后的 token 合计
   * @param costCny 本次费用（人民币）
   * @param last 明细
   */
  recordUsage(
    tokens: number,
    costCny: number,
    last?: { prompt?: number; completion?: number; cacheRead?: number; total?: number }
  ): { ok: boolean; budget: AgentBudget; warned: boolean; blocked: boolean; error?: string } {
    const b2 = this.data.budget;
    const t = Number(tokens);
    const c = Number(costCny);
    if (!isFinite(t) || t <= 0) return { ok: false, budget: this.budget(), warned: false, blocked: false, error: 'usage 无效' };
    if (!isFinite(c) || c < 0) return { ok: false, budget: this.budget(), warned: false, blocked: false, error: '费用无效' };
    b2.tokensUsed += t;
    b2.costCny = Math.round((b2.costCny + c) * 100000) / 100000;  // 保留 5 位小数，避免累计误差
    b2.usedCny = b2.costCny;
    if (last) b2.lastUsage = last;
    b2.updatedAt = new Date().toISOString();
    this.save();
    const limit = Number(b2.limitCny) || 0;
    const blocked = limit > 0 && b2.costCny >= limit;
    const warned = limit > 0 && b2.costCny >= limit * (b2.warnRatio || 0.8);
    return { ok: true, budget: this.budget(), warned, blocked };
  }

  /** 设置汇率 */
  setUsdToCny(v: number): { ok: boolean; budget?: AgentBudget; error?: string } {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return { ok: false, error: '汇率必须大于 0' };
    this.data.budget.usdToCny = n;
    this.data.budget.updatedAt = new Date().toISOString();
    if (!this.save()) return { ok: false, error: '写入失败' };
    return { ok: true, budget: this.budget() };
  }

  /** 设置预警比例（0–1） */
  setWarnRatio(v: number): { ok: boolean; budget?: AgentBudget; error?: string } {
    const n = Number(v);
    if (!isFinite(n) || n <= 0 || n > 1) return { ok: false, error: '预警比例需在 (0, 1] 之间' };
    this.data.budget.warnRatio = n;
    this.data.budget.updatedAt = new Date().toISOString();
    if (!this.save()) return { ok: false, error: '写入失败' };
    return { ok: true, budget: this.budget() };
  }


  /** 剩余额度 */
  remaining(): number {
    const b = this.data.budget;
    return b.limitCny <= 0 ? Infinity : Math.max(0, b.limitCny - b.usedCny);
  }
}
