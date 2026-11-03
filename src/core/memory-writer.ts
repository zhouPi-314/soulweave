/**
 * SoulWeave S4：记忆写入链路
 *
 * 一轮对话结束后：
 *   1. 把两条消息落库（messages 表）
 *   2. 规则提取候选记忆（**零成本**，不调模型）
 *   3. 异步入队 → 向量化 → 写 memories（带去重）
 *
 * 【为什么先用规则提取而不是让模型提取】
 * 让模型提取要点会调用 LLM，每条消息都要钱。
 * 当前预算只有 ¥30，先把「不需要花钱也能记住的部分」做扎实：
 * 用户明确表达的偏好、身份事实、要求记住的事、第一次。
 * LLM 摘要作为可选项留到后面（见 docs 里的遗留项）。
 *
 * 【为什么异步】
 * 写库 + 向量化约 30–80ms，绝不能让用户等回复。
 * 队列串行处理，失败只记日志，不影响对话。
 */

import type { MemoryRepository } from './memory-repository.js';
import type { embed as EmbedFn } from './embedding.js';

export interface WriterDeps {
  repo: MemoryRepository;
  embed: typeof EmbedFn;
  modelDir: string;
}

export interface TurnInput {
  characterId: string;
  scene?: 'desktop' | 'qq_private' | 'qq_group' | 'web' | 'character_dm';
  userText: string;
  assistantText: string;
}

export interface Candidate {
  content: string;
  importance: number;
  sensitivity: number;
  /** 命中的规则名，便于排查与解释 */
  rule: string;
}

// ── 规则表（中文）──────────────────────────────────────

interface Rule {
  name: string;
  re: RegExp;
  importance: number;
  /** 提取时是否要保留整句 */
  whole?: boolean;
}

const RULES: Rule[] = [
  // 明确要求记住 —— 权重最高
  { name: 'explicit_remember', re: /(记住|别忘了|不要忘记|你要记得|帮我记住)/, importance: 1.0 },
  // 第一次 / 初次 —— 里程碑
  { name: 'first_time', re: /(第一次|初次|头一次)/, importance: 0.95 },
  // 身份与事实
  { name: 'identity', re: /(我叫|我的名字|我是|我住在|我家在|我的生日|我生于|我在.{0,8}(工作|上班|上学|读书))/, importance: 0.9 },
  // 偏好
  { name: 'preference_like', re: /(我最?喜欢|我最?爱|我特别?喜欢)/, importance: 0.75 },
  { name: 'preference_dislike', re: /(我(最)?讨厌|我不喜欢|我受不了|我害怕|我怕)/, importance: 0.75 },
  // 约定与计划
  { name: 'appointment', re: /(约好|说好|答应|定在|下(次|周|个月)|明天|后天)/, importance: 0.7 },
]

/**
 * **凭据类**：命中则**整句不自动存**。
 *
 * 理由：密码 / 验证码 / 密钥这类东西一旦进了记忆库，就会被向量检索、
 * 被摘要、被共享流程碰到 —— 这是不该发生的。
 * 想要留就由用户自己显式添加，不要让自动提取去碰。
 */
const SECRET_RE = /(密码|口令|验证码|密钥|私钥|api[\s_-]?key|access[\s_-]?token)/i;

/**
 * **个人资料类**：命中则敏感度提到 2。
 * **绝不自动设 3** —— 3 意味着禁止跨角色共享，那是用户主动做的决定。
 */
const SENSITIVE_RE = /(身份证|银行卡|社保|家庭住址|住址|工资|薪水|病历|诊断|手机号)/;

/**
 * 从一段文本里提取候选记忆。
 * 按句子切分，命中规则的句子整句保留。
 */
export function extractCandidates(text: string): Candidate[] {
  const src = String(text || '').trim();
  if (!src) return [];
  // 切句：中文句号/问号/感叹号/分号/换行
  const sentences = src.split(/[。！？!?\n；;]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    // 凭据类整句跳过：自动提取不碰密码/验证码/密钥
    if (SECRET_RE.test(s)) continue;
    for (const r of RULES) {
      if (!r.re.test(s)) continue;
      // 整句太长就截断，避免把一大段话都当记忆
      const content = s.length > 120 ? s.slice(0, 120) + '…' : s;
      const key = content.replace(/\s+/g, '');
      if (seen.has(key)) break;
      seen.add(key);
      const sensitive = SENSITIVE_RE.test(s) ? 2 : 0;
      out.push({
        content,
        importance: Math.min(1, r.importance + (sensitive > 0 ? 0.05 : 0)),
        sensitivity: sensitive,
        rule: r.name,
      });
      break; // 一句只归一条规则，取最先命中的（规则已按优先级排序）
    }
  }
  return out.slice(0, 5);
}

export interface WriterStats {
  turnsRecorded: number;
  messagesWritten: number;
  memoriesWritten: number;
  duplicatesSkipped: number;
  errors: number;
  /** 排队中的数量 */
  queueLength: number;
  /**
   * 是否正在处理。
   * 【必须有这个字段】队列项在开始处理时就已从数组里 splice 出去，
   * 此时 queueLength 会变成 0 —— 但工作还没做完。
   * 只看 queueLength 会「以为排空了」。
   */
  busy: boolean;
  lastError?: string;
  lastRunAt?: string;
}

export class MemoryWriter {
  private deps: WriterDeps;
  private convCache = new Map<string, string>();
  private queue: TurnInput[] = [];
  private working = false;
  private enabled = true;
  private stats: WriterStats = {
    turnsRecorded: 0, messagesWritten: 0, memoriesWritten: 0,
    duplicatesSkipped: 0, errors: 0, queueLength: 0, busy: false,
  };

  constructor(deps: WriterDeps) {
    this.deps = deps;
  }

  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  getStats(): WriterStats {
    return { ...this.stats, queueLength: this.queue.length, busy: this.working };
  }

  /** 等到队列真正排空（含正在处理的那批） */
  async idle(timeoutMs = 20000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!this.working && this.queue.length === 0) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  /** 取（或建）该角色的对话容器 */
  private async ensureConversation(characterId: string, scene: string): Promise<string | null> {
    const key = characterId + '|' + scene;
    const hit = this.convCache.get(key);
    if (hit) return hit;
    const r = await this.deps.repo.exec(
      "INSERT INTO conversations (character_id, scene) VALUES (:'c'::uuid, :'scene') RETURNING id",
      { c: characterId, scene });
    if (!r.ok) { this.stats.errors++; this.stats.lastError = r.error; return null; }
    const id = ((r.rows || [])[0] || {}).id;
    if (id) this.convCache.set(key, id);
    return id || null;
  }

  /** 记录一轮对话（落库两条消息），然后异步入队提取记忆 */
  async recordTurn(t: TurnInput): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
    if (!this.enabled) return { ok: false, error: '写入已关闭' };
    const cid = String(t.characterId || '').trim();
    if (!cid) return { ok: false, error: '缺少角色标识' };

    const scene = t.scene || 'desktop';
    const conv = await this.ensureConversation(cid, scene);
    if (!conv) return { ok: false, error: '无法创建对话容器' };

    const userText = String(t.userText || '').trim();
    const aiText = String(t.assistantText || '').trim();
    const ins = await this.deps.repo.exec(
      "INSERT INTO messages (conversation_id, character_id, role, content, origin_type) " +
      "VALUES (:'conv'::uuid, :'c'::uuid, :'role', :'content', 'user_direct') RETURNING id",
      { conv, c: cid, role: 'user', content: userText });
    if (!ins.ok) { this.stats.errors++; this.stats.lastError = ins.error; }
    else this.stats.messagesWritten++;

    if (aiText) {
      const ins2 = await this.deps.repo.exec(
        "INSERT INTO messages (conversation_id, character_id, role, content, origin_type) " +
        "VALUES (:'conv'::uuid, :'c'::uuid, 'assistant', :'content', 'user_direct') RETURNING id",
        { conv, c: cid, content: aiText });
      if (!ins2.ok) { this.stats.errors++; this.stats.lastError = ins2.error; }
      else this.stats.messagesWritten++;
    }

    this.stats.turnsRecorded++;
    this.enqueue(t);
    return { ok: true, conversationId: conv };
  }

  /** 入队并触发处理（不等待） */
  private enqueue(t: TurnInput): void {
    this.queue.push(t);
    void this.drain();
  }

  /** 串行处理队列（策略里的 asyncBatch=20，这里按批消费） */
  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 20);
        for (const turn of batch) {
          try { await this.processTurn(turn); }
          catch (e) { this.stats.errors++; this.stats.lastError = String(e).slice(0, 200); }
        }
      }
    } finally {
      this.working = false;
      this.stats.lastRunAt = new Date().toISOString();
    }
  }

  /** 处理一轮：提取 + 向量化 + 写入（自带去重） */
  private async processTurn(t: TurnInput): Promise<void> {
    const cands = extractCandidates(t.userText);
    if (!cands.length) return;
    for (const c of cands) {
      const e = await this.deps.embed(c.content, { modelDir: this.deps.modelDir });
      const r = await this.deps.repo.create({
        ownerCharacter: t.characterId,
        content: c.content,
        scope: 'private',
        sensitivity: c.sensitivity,
        importance: c.importance,
        source: 'ai_extract',
        embedding: e.ok ? e.vector : null,
      });
      if (!r.ok) { this.stats.errors++; this.stats.lastError = r.error; continue; }
      if (r.duplicate) this.stats.duplicatesSkipped++;
      else this.stats.memoriesWritten++;
    }
  }
}
