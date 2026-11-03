/**
 * 角色注册表
 *
 * V1.7 D55 / D58 的服务层强制实现。
 * 数据库约束是第二道防线，这里才是第一道。
 *
 * S1 阶段用内存实现，S4 接 PostgreSQL。
 */

import type { Character, CharacterKind, ProtectionLevel, CharacterState } from '../shared/types.js';

export class CharacterError extends Error {
  constructor(
    public readonly code:
      | 'LOCAL_DSH_LIMIT'
      | 'PROTECTED_CANNOT_DELETE'
      | 'NOT_FOUND'
      | 'ALREADY_TRASHED'
      | 'INVALID_KIND'
      | 'CLOUD_ONLY_OPERATION',
    message: string
  ) { super(message); this.name = 'CharacterError'; }
}

export interface CreateCharacterInput {
  kind: CharacterKind;
  name: string;
  protection?: ProtectionLevel;
  personaRef?: string | null;
  voiceRef?: string | null;
  avatarRef?: string | null;
}

let seq = 0;
function nextId(): string {
  return 'char-' + Date.now().toString(36) + '-' + (++seq).toString(36);
}

export class CharacterRegistry {
  private characters = new Map<string, Character>();

  /**
   * 创建角色。
   *
   * D58-1：local_dsh 当前只允许一个（冰糖已占位）
   * D58-2：小橘子是 default_protected
   */
  create(input: CreateCharacterInput): Character {
    if (input.kind === 'local_dsh') {
      const existing = this.findByKind('local_dsh');
      if (existing) {
        throw new CharacterError(
          'LOCAL_DSH_LIMIT',
          '当前版本仅支持一个本地 DSH 角色，未来扩展，敬请期待。'
        );
      }
    }

    // 保护级别默认值
    const protection: ProtectionLevel =
      input.protection ??
      (input.kind === 'local_dsh' ? 'fixed_protected' : 'normal');

    // local_dsh 必须是 fixed_protected
    if (input.kind === 'local_dsh' && protection !== 'fixed_protected') {
      throw new CharacterError(
        'INVALID_KIND',
        'local_dsh 角色必须是 fixed_protected'
      );
    }

    const c: Character = {
      id: nextId(),
      kind: input.kind,
      protection,
      name: input.name,
      personaRef: input.personaRef ?? null,
      voiceRef: input.voiceRef ?? null,
      avatarRef: input.avatarRef ?? null,
      state: 'active',
      createdAt: new Date(),
    };

    this.characters.set(c.id, c);
    return c;
  }

  /**
   * 初始化两个默认角色。
   * 幂等：已存在则返回现有。
   */
  ensureDefaults(): { bingtang: Character; xiaojuzi: Character } {
    let bingtang = this.findByKind('local_dsh');
    if (!bingtang) {
      bingtang = this.create({
        kind: 'local_dsh',
        name: '冰糖',
        protection: 'fixed_protected',
      });
    }

    let xiaojuzi = this.findByName('小橘子');
    if (!xiaojuzi) {
      xiaojuzi = this.create({
        kind: 'cloud_api',
        name: '小橘子',
        protection: 'default_protected',
      });
    }

    return { bingtang, xiaojuzi };
  }

  get(id: string): Character | undefined {
    return this.characters.get(id);
  }

  list(includeTrashed = false): Character[] {
    return [...this.characters.values()].filter(c =>
      includeTrashed ? c.state !== 'deleted' : c.state === 'active' || c.state === 'sleeping'
    );
  }

  findByKind(kind: CharacterKind): Character | undefined {
    return [...this.characters.values()].find(
      c => c.kind === kind && c.state !== 'deleted'
    );
  }

  findByName(name: string): Character | undefined {
    return [...this.characters.values()].find(
      c => c.name === name && c.state !== 'deleted'
    );
  }

  // ── 状态变更 ────────────────────────────────────

  sleep(id: string): void {
    const c = this.mustGet(id);
    c.state = 'sleeping';
  }

  wake(id: string): void {
    const c = this.mustGet(id);
    c.state = 'active';
  }

  /**
   * 移入回收站（软删除）。
   *
   * D58-1：冰糖不可删除，连回收站都不行
   * D58-2：小橘子可移入回收站，但首期无「永久删除」入口
   */
  trash(id: string): void {
    const c = this.mustGet(id);

    if (c.protection === 'fixed_protected') {
      throw new CharacterError(
        'PROTECTED_CANNOT_DELETE',
        c.name + ' 是固定保护角色，不可删除。'
      );
    }

    if (c.state === 'trashed') {
      throw new CharacterError('ALREADY_TRASHED', c.name + ' 已在回收站中。');
    }

    c.state = 'trashed';
  }

  restore(id: string): void {
    const c = this.mustGet(id);
    if (c.state !== 'trashed') {
      throw new CharacterError('NOT_FOUND', c.name + ' 不在回收站中。');
    }
    c.state = 'active';
  }

  /**
   * 永久删除。
   *
   * D58-2：小橘子首期**不提供**此入口
   * D58-3：其他云端角色可二次确认后永久删除
   */
  purge(id: string): void {
    const c = this.mustGet(id);

    if (c.protection === 'fixed_protected') {
      throw new CharacterError(
        'PROTECTED_CANNOT_DELETE',
        c.name + ' 是固定保护角色，不可删除。'
      );
    }

    if (c.protection === 'default_protected') {
      throw new CharacterError(
        'PROTECTED_CANNOT_DELETE',
        c.name + ' 是默认保护角色，首期不提供永久删除入口。' +
        '可通过停用、隐藏或备份管理。'
      );
    }

    c.state = 'deleted';
    this.characters.delete(id);
  }

  // ── 内部 ────────────────────────────────────────

  private mustGet(id: string): Character {
    const c = this.characters.get(id);
    if (!c) throw new CharacterError('NOT_FOUND', '角色不存在: ' + id);
    return c;
  }
}
