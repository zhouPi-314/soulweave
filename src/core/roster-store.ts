/*
 * SoulWeave：角色名册（持久化 + 绑定关系）
 *
 * 【为什么单独一个模块】
 * 之前的角色创建逻辑只在内存里（CharacterRegistry），
 * 而且没有任何界面能新建角色，也没有「这个角色绑哪个渠道」的概念。
 * 用户需要：多个角色、各自决定绑 QQ 私聊 / QQ 群 / Live2D，或者都不绑。
 *
 * 【规则（沿用 D58）】
 *   · local_dsh 当前只允许 1 个（冰糖），fixed_protected 不可删
 *   · 小橘子是 default_protected（首期无永久删除入口）
 *   · cloud_api 可以建多个，protection=normal
 *
 * 【绑定语义】
 *   qqPrivate  这个角色在 QQ 私聊里应声
 *   qqGroup    这个角色在 QQ 群里应声
 *   live2d     这个角色出现在 Live2D 桌宠上
 *   三个都为 false = 不绑定任何渠道（只是存在于名册里）
 */

import fs from 'node:fs';
import path from 'node:path';

export type RosterKind = 'local_dsh' | 'cloud_api';
export type RosterProtection = 'fixed_protected' | 'default_protected' | 'normal';
export type RosterState = 'active' | 'sleeping' | 'trashed';

export interface RosterBindings {
  /** QQ 私聊应声 */
  qqPrivate: boolean;
  /** QQ 群应声 */
  qqGroup: boolean;
  /** Live2D 桌宠显示 */
  live2d: boolean;
}

/**
 * 「这个角色通过哪个 QQ 账号、发给谁」。
 *
 * 【为什么需要它】
 * 光有 qqPrivate/qqGroup 两个布尔值，只回答了「要不要在 QQ 上应声」，
 * 没回答用户真正问的问题：
 *   · 用哪个 QQ 号发？（一个 NapCat 登录 = 一个 QQ 号）
 *   · 发给谁？（好友 / 群）
 * 结果就是用户找不到「把小橘子绑到我的 QQ」这个入口 —— 因为数据层没有这个位置。
 *
 * 【互斥规则】
 * 一个 QQ 账号同时只能服务一个角色。否则两个角色抢同一个号，
 * 谁回谁不回说不清，用户也调不出预期行为。
 */
export interface RosterQQBinding {
  /** OneBot 账号标识（qq-service 里的 label，如「冰糖号」） */
  accountLabel: string;
  /**
   * 发到私聊还是群、发给谁 —— **不再由角色管理设置**。
   *
   * 用户的决定：发给谁统一由「社交 → 白名单」负责，
   * 角色这边只管「这个角色用哪个 QQ 号」。
   * 这两个字段只留给老配置兼容，新绑定不再写。
   */
  targetKind?: 'private' | 'group';
  targetId?: string;
  targetName?: string;
}

/** 云端角色自己的密钥与模型（角色之间不共享） */
export interface RosterCloudConfig {
  providerId: string;
  baseUrl?: string;
  model?: string;
  /** 密钥密文（safeStorage 加密后 base64），绝不落明文 */
  apiKeyEnc?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface RosterEntry {
  id: string;
  name: string;
  kind: RosterKind;
  protection: RosterProtection;
  state: RosterState;
  createdAt: string;
  /** 云端角色用：服务商 id（对应 cloud-agent 的 CLOUD_PROVIDERS） */
  cloudProviderId?: string;
  /** 备注 */
  note?: string;
  bindings: RosterBindings;
  /** QQ 账号 + 推送对象；null / 缺省 = 没绑 QQ */
  qq?: RosterQQBinding | null;
  /** 云端角色的独立密钥配置 */
  cloud?: RosterCloudConfig | null;
  /**
   * 人格卡：角色「是什么样的人」。
   * 与智能体（谁来推理）解耦 —— 同一个智能体可以演不同人格。
   */
  persona?: RosterPersona;
  /**
   * 绑定的 Live2D 形象 id（形象在 live2d.json 里单独管理，可命名）；
   * null/缺省 = 不显示形象（纯文字/语音陪伴）。
   */
  live2dModelId?: string | null;
}

/** 人格卡：给角色写一段"人设"，注入对话时作为系统提示的一部分 */
export interface RosterPersona {
  /** 一句话自我介绍，例如「住在你电脑里的糖分供应站」 */
  tagline?: string;
  /** 性格关键词，3–6 个 */
  traits?: string[];
  /** 说话风格，例如「短句、爱用感叹号、偶尔撒娇」 */
  tone?: string;
  /** 补充设定（口癖、喜好、忌讳） */
  notes?: string;
}

export interface RosterFile {
  version: number;
  characters: RosterEntry[];
}

export const EMPTY_BINDINGS: RosterBindings = { qqPrivate: false, qqGroup: false, live2d: false };

const FILE_VERSION = 1;

export function defaultRoster(): RosterFile {
  const now = new Date().toISOString();
  return {
    version: FILE_VERSION,
    characters: [
      {
        id: 'char-bingtang', name: '冰糖', kind: 'local_dsh',
        protection: 'fixed_protected', state: 'active', createdAt: now,
        note: '本地 DSH 角色，当前版本固定一个',
        bindings: { qqPrivate: true, qqGroup: false, live2d: true },
      },
      {
        id: 'char-xiaojuzi', name: '小橘子', kind: 'cloud_api',
        protection: 'default_protected', state: 'active', createdAt: now,
        cloudProviderId: 'deepseek',
        note: '云端 API 角色',
        bindings: { qqPrivate: false, qqGroup: false, live2d: true },
      },
    ],
  };
}

// ─── 校验 ───────────────────────────────────────────

export interface RosterError { ok: false; code: string; error: string; }
export type RosterResult<T> = ({ ok: true } & T) | RosterError;

const NAME_MAX = 24;

export function validateName(name: string, existing: RosterEntry[], selfId?: string): string | null {
  const n = String(name || '').trim();
  if (!n) return '名字不能为空';
  if (n.length > NAME_MAX) return '名字最多 ' + NAME_MAX + ' 个字';
  const dup = existing.find((c) => c.name === n && c.id !== selfId && c.state !== 'trashed');
  if (dup) return '已经有同名角色了';
  return null;
}

/** 本地角色是否已达上限（D58-1） */
export function localLimitReached(existing: RosterEntry[]): boolean {
  return existing.some((c) => c.kind === 'local_dsh' && c.state !== 'trashed');
}

// ─── 存储 ───────────────────────────────────────────

export class RosterStore {
  private file: string;
  private data: RosterFile;

  constructor(dir: string) {
    this.file = path.join(dir, 'roster.json');
    this.data = this.load();
  }

  private load(): RosterFile {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (j && Array.isArray(j.characters)) {
          // 补齐缺失字段（老版本文件）
          j.characters = j.characters.map((c: any) => ({
            ...c,
            state: c.state || 'active',
            bindings: { ...EMPTY_BINDINGS, ...(c.bindings || {}) },
            // 只绑账号（没有 targetId）也是合法绑定，不能在这里被清掉 ——
            // 之前的条件要求 targetId，导致重启后账号绑定凭空消失。
            qq: c.qq && c.qq.accountLabel ? c.qq : null,
            cloud: c.cloud || null,
            persona: c.persona && typeof c.persona === 'object' ? c.persona : undefined,
            live2dModelId: typeof c.live2dModelId === 'string' ? c.live2dModelId : null,
          }));
          return { version: FILE_VERSION, characters: j.characters };
        }
      }
    } catch (e) { /* 坏文件回落到默认 */ }
    const d = defaultRoster();
    this.save(d);
    return d;
  }

  private save(d: RosterFile = this.data): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(d, null, 2), 'utf8');
    } catch (e) { /* 写失败不抛，避免界面崩 */ }
  }

  list(includeTrashed = false): RosterEntry[] {
    const all = this.data.characters;
    return includeTrashed ? all.slice() : all.filter((c) => c.state !== 'trashed');
  }

  get(id: string): RosterEntry | undefined {
    return this.data.characters.find((c) => c.id === id);
  }

  create(input: {
    kind: RosterKind; name: string; note?: string; cloudProviderId?: string;
    bindings?: Partial<RosterBindings>;
  }): RosterResult<{ character: RosterEntry }> {
    const name = String(input.name || '').trim();
    const bad = validateName(name, this.data.characters);
    if (bad) return { ok: false, code: 'BAD_NAME', error: bad };

    if (input.kind === 'local_dsh' && localLimitReached(this.data.characters)) {
      return {
        ok: false, code: 'LOCAL_LIMIT',
        error: '当前版本只支持一个本地 DSH 角色，云端角色可以建多个。',
      };
    }

    const c: RosterEntry = {
      id: 'char-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name,
      kind: input.kind,
      protection: input.kind === 'local_dsh' ? 'fixed_protected' : 'normal',
      state: 'active',
      createdAt: new Date().toISOString(),
      note: input.note || '',
      bindings: { ...EMPTY_BINDINGS, ...(input.bindings || {}) },
    };
    if (input.kind === 'cloud_api') {
      c.cloudProviderId = input.cloudProviderId || 'deepseek';
      c.cloud = { providerId: c.cloudProviderId };
    }
    c.qq = null;

    this.data.characters.push(c);
    this.save();
    return { ok: true, character: c };
  }

  update(id: string, patch: {
    name?: string; note?: string; cloudProviderId?: string;
    persona?: RosterPersona | null;
    live2dModelId?: string | null;
  }): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.state === 'trashed') return { ok: false, code: 'ALREADY_TRASHED', error: '角色已在回收站' };

    if (patch.name !== undefined) {
      const bad = validateName(patch.name, this.data.characters, id);
      if (bad) return { ok: false, code: 'BAD_NAME', error: bad };
      c.name = String(patch.name).trim();
    }
    if (patch.note !== undefined) c.note = String(patch.note).slice(0, 200);
    if (patch.cloudProviderId !== undefined && c.kind === 'cloud_api') {
      c.cloudProviderId = String(patch.cloudProviderId);
    }
    if (patch.persona !== undefined) {
      if (patch.persona === null) { delete c.persona; }
      else {
        const p = patch.persona || {};
        c.persona = {
          tagline: String(p.tagline || '').slice(0, 80),
          traits: Array.isArray(p.traits) ? p.traits.map((x: any) => String(x).slice(0, 12)).slice(0, 8) : [],
          tone: String(p.tone || '').slice(0, 200),
          notes: String(p.notes || '').slice(0, 400),
        };
      }
    }
    if (patch.live2dModelId !== undefined) {
      c.live2dModelId = patch.live2dModelId ? String(patch.live2dModelId) : null;
    }
    this.save();
    return { ok: true, character: c };
  }

  /** 设置绑定 */
  bind(id: string, patch: Partial<RosterBindings>): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    c.bindings = { ...c.bindings, ...(patch || {}) };
    this.save();
    return { ok: true, character: c };
  }

  /** 一键「不绑定任何渠道」 */
  unbindAll(id: string): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    c.bindings = { ...EMPTY_BINDINGS };
    c.qq = null;
    this.save();
    return { ok: true, character: c };
  }

  // ─── QQ 账号 ↔ 角色（第 13 个功能的核心）───────────────

  /**
   * 把一个 QQ 账号 + 推送对象绑到角色上。
   *
   * 会先把这个账号从其他角色身上摘掉（互斥），
   * 否则同一账号被多个角色持有，行为无法预测。
   */
  bindChannel(
    id: string,
    input: { accountLabel: string; targetKind?: 'private' | 'group'; targetId?: string; targetName?: string },
  ): RosterResult<{ character: RosterEntry; released: string[] }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.state === 'trashed') return { ok: false, code: 'ALREADY_TRASHED', error: '角色已在回收站' };

    const accountLabel = String(input.accountLabel || '').trim();
    const targetId = String(input.targetId || '').trim();
    const targetKind = input.targetKind === 'group' ? 'group' : 'private';
    if (!accountLabel) return { ok: false, code: 'BAD_ACCOUNT', error: '请选择 QQ 账号' };

    const released: string[] = [];
    for (const other of this.data.characters) {
      if (other.id === id) continue;
      if (other.qq && other.qq.accountLabel === accountLabel) {
        other.qq = null;
        other.bindings = { ...other.bindings, qqPrivate: false, qqGroup: false };
        released.push(other.name);
      }
    }

    if (targetId) {
      c.qq = { accountLabel, targetKind, targetId, targetName: input.targetName || '' };
      c.bindings = { ...c.bindings, qqPrivate: targetKind === 'private', qqGroup: targetKind === 'group' };
    } else {
      // 只绑账号：发到哪由「社交 → 白名单」决定
      c.qq = { accountLabel };
      c.bindings = { ...c.bindings, qqPrivate: false, qqGroup: false };
    }
    this.save();
    return { ok: true, character: c, released };
  }

  /** 解绑 QQ（Live2D 绑定不受影响） */
  unbindChannel(id: string): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    c.qq = null;
    c.bindings = { ...c.bindings, qqPrivate: false, qqGroup: false };
    this.save();
    return { ok: true, character: c };
  }

  /** 这个 QQ 账号现在归哪个角色 */
  findByAccount(accountLabel: string): RosterEntry | null {
    const l = String(accountLabel || '');
    if (!l) return null;
    return this.list().find((c) => c.qq && c.qq.accountLabel === l) || null;
  }

  /** 这个账号 + 目标目前归哪个角色（决定谁来应声） */
  findByTarget(accountLabel: string, targetKind: 'private' | 'group', targetId: string): RosterEntry | null {
    const l = String(accountLabel || '');
    const t = String(targetId || '');
    return this.list().find((c) =>
      c.qq && c.qq.accountLabel === l && c.qq.targetKind === targetKind && c.qq.targetId === t) || null;
  }

  /** 所有已绑 QQ 的账号 label（给「这个号已被占用」提示用） */
  boundAccountLabels(): string[] {
    return this.list().filter((c) => c.qq).map((c) => String(c.qq!.accountLabel));
  }

  // ─── 每个角色独立的云端密钥 ────────────────────────────

  /** 写入云端配置（key 由上层加密成 apiKeyEnc 再传进来） */
  setCloud(id: string, patch: Partial<RosterCloudConfig>): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.kind !== 'cloud_api') return { ok: false, code: 'NOT_CLOUD', error: '本地角色不需要云端密钥' };
    const cur: RosterCloudConfig = c.cloud || { providerId: c.cloudProviderId || 'deepseek' };
    const next: RosterCloudConfig = { ...cur };
    if (patch.providerId !== undefined) next.providerId = String(patch.providerId);
    if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl);
    if (patch.model !== undefined) next.model = String(patch.model);
    if (patch.apiKeyEnc !== undefined) next.apiKeyEnc = String(patch.apiKeyEnc);
    if (patch.temperature !== undefined) next.temperature = Number(patch.temperature);
    if (patch.maxTokens !== undefined) next.maxTokens = Number(patch.maxTokens);
    c.cloud = next;
    c.cloudProviderId = next.providerId;
    this.save();
    return { ok: true, character: c };
  }

  /** 清掉密钥（保留服务商/模型选择） */
  clearCloudKey(id: string): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.cloud) delete c.cloud.apiKeyEnc;
    this.save();
    return { ok: true, character: c };
  }

  /** 休眠 / 唤醒 */
  setState(id: string, state: 'active' | 'sleeping'): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.state === 'trashed') return { ok: false, code: 'ALREADY_TRASHED', error: '角色已在回收站' };
    c.state = state;
    this.save();
    return { ok: true, character: c };
  }

  /** 移入回收站（软删除） */
  trash(id: string): RosterResult<{}> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.protection === 'fixed_protected') {
      return { ok: false, code: 'PROTECTED', error: '「' + c.name + '」是固定角色，当前版本不可删除。' };
    }
    if (c.protection === 'default_protected') {
      return { ok: false, code: 'PROTECTED', error: '「' + c.name + '」是默认保护角色，首期没有永久删除入口。' };
    }
    c.state = 'trashed';
    c.bindings = { ...EMPTY_BINDINGS };
    c.qq = null;
    this.save();
    return { ok: true };
  }

  /** 从回收站恢复 */
  restore(id: string): RosterResult<{ character: RosterEntry }> {
    const c = this.get(id);
    if (!c) return { ok: false, code: 'NOT_FOUND', error: '角色不存在' };
    if (c.kind === 'local_dsh' && localLimitReached(this.data.characters.filter((x) => x.id !== id))) {
      return { ok: false, code: 'LOCAL_LIMIT', error: '已经有本地角色了，无法恢复' };
    }
    c.state = 'active';
    this.save();
    return { ok: true, character: c };
  }

  /** 这个角色是否真的绑了 QQ（有账号 + 有对象才算） */
  static hasQqBinding(c: RosterEntry): boolean {
    // 只要绑定了账号就算绑上 QQ；发到哪由白名单决定
    return !!(c.qq && c.qq.accountLabel);
  }

  /** 统计：每个渠道绑了几个角色 */
  bindingSummary(): {
    qqPrivate: number; qqGroup: number; live2d: number; unbound: number; qqBound: number;
  } {
    const active = this.list();
    const qq = active.filter((c) => RosterStore.hasQqBinding(c));
    return {
      qqPrivate: qq.filter((c) => c.qq!.targetId && c.qq!.targetKind === 'private').length,
      qqGroup: qq.filter((c) => c.qq!.targetId && c.qq!.targetKind === 'group').length,
      live2d: active.filter((c) => c.bindings.live2d).length,
      unbound: active.filter((c) => !RosterStore.hasQqBinding(c) && !c.bindings.live2d).length,
      qqBound: qq.length,
    };
  }
}