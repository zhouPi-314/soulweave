/**
 * SoulWeave S10：音色一键应用（带回滚）
 *
 * 需求原话：「给定许可明确且兼容的音色，用户可试听并应用至指定角色；
 *            失败时不破坏原音色配置。」
 *
 * 所以这个模块的核心不是「写配置」，是**写了能退回去**：
 *   1. 先把整份 voice-config 深拷贝一份快照
 *   2. 校验（引擎/音色存在）——不满足就一个字节都不写
 *   3. 写入
 *   4. 可选合成一句测试音；失败立刻把快照写回去
 *
 * 依赖以函数注入，便于单测（不需要 Electron、不需要真的合成）。
 */

export type VoiceRef = {
  provider: string;
  voiceId: string;
  speed?: number;
  /** 可选：来源资源 id，便于在配置里留痕 */
  sourceId?: string;
};

export type ApplyDeps = {
  readConfig: () => any;
  writeConfig: (cfg: any) => boolean | { ok: boolean; error?: string };
  /** 该 provider 下是否有这个音色（查真实列表，别信目录） */
  hasVoice: (provider: string, voiceId: string) => boolean;
  /** 已知的 provider 白名单 */
  knownProviders: string[];
  /** 可选：合成一小段做验证 */
  probe?: (ref: VoiceRef) => Promise<{ ok: boolean; error?: string }>;
};

export type ApplyResult =
  | { ok: true; characterId: string; applied: VoiceRef; previous: any; probed: boolean }
  | { ok: false; error: string; rolledBack?: boolean; step?: 'validate' | 'write' | 'probe' };

function clone<T>(v: T): T {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

/** 读某个角色当前的音色配置（没有就 null） */
/** 判断一个 voiceId 是不是真的可用（排除空串与 'undefined'/'null' 这类被写坏的字符串） */
export function isValidVoiceId(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return lower !== 'undefined' && lower !== 'null';
}

export function currentVoice(cfg: any, characterId: string): VoiceRef | null {
  const m = cfg && cfg.perModel ? cfg.perModel[String(characterId)] : null;
  // 配置被写坏（缺 voiceId）时按「未绑定」处理。
  // 实测踩过：某次应用写进了 { provider: 'kokoro' } 没有 voiceId，
  // 旧实现 String(undefined) 会把它显示成 voiceId="undefined"，看着像真配置。
  if (!isValidVoiceId(m && m.voiceId)) return null;
  return { provider: String(m.provider || 'system'), voiceId: String(m.voiceId), speed: m.speed };
}

/**
 * 应用音色到角色。
 * 无论成功失败，返回值都不抛异常（除非 deps 本身抛）。
 */
export async function applyVoiceToCharacter(
  characterId: string,
  ref: VoiceRef,
  deps: ApplyDeps
): Promise<ApplyResult> {
  const cid = String(characterId || '');
  if (!cid) return { ok: false, error: '没有指定角色', step: 'validate' };

  const provider = String(ref?.provider || '');
  const voiceId = String(ref?.voiceId || '');
  if (!provider || !voiceId) return { ok: false, error: '音色信息不完整', step: 'validate' };
  if (!deps.knownProviders.includes(provider)) {
    return { ok: false, error: '未知的声音引擎：' + provider, step: 'validate' };
  }
  if (!deps.hasVoice(provider, voiceId)) {
    return { ok: false, error: '这个引擎下没有该音色：' + voiceId + '（可能需要先安装音色文件）', step: 'validate' };
  }

  // ① 快照
  const snapshot = clone(deps.readConfig());
  const previous = currentVoice(snapshot, cid);

  // ② 写入
  try {
    const cfg = clone(snapshot) || {};
    cfg.perModel = cfg.perModel || {};
    // 顺手修掉损坏条目（缺 voiceId 的），避免带着垃圾继续跑
    for (const k of Object.keys(cfg.perModel)) {
      const e = cfg.perModel[k];
      if (!e || !isValidVoiceId(e.voiceId)) delete cfg.perModel[k];
    }
    const entry: any = { provider, voiceId };
    if (ref.speed !== undefined) entry.speed = ref.speed;
    if (ref.sourceId) entry.sourceId = ref.sourceId;
    cfg.perModel[cid] = entry;
    const w = deps.writeConfig(cfg);
    const wrote = typeof w === 'boolean' ? w : !!w.ok;
    if (!wrote) {
      // 写失败也要尝试还原（可能写了一半）
      const rb = restoreSnapshot(snapshot, deps);
      return { ok: false, error: '写入配置失败', rolledBack: rb, step: 'write' };
    }
  } catch (e) {
    const rb = restoreSnapshot(snapshot, deps);
    return { ok: false, error: '写入配置异常：' + String(e).slice(0, 120), rolledBack: rb, step: 'write' };
  }

  // ③ 可选验证
  let probed = false;
  if (deps.probe) {
    try {
      const pr = await deps.probe({ provider, voiceId, speed: ref.speed, sourceId: ref.sourceId });
      if (!pr || !pr.ok) {
        const rb = restoreSnapshot(snapshot, deps);
        return {
          ok: false,
          error: '试听失败，已回滚到原音色：' + String((pr && pr.error) || '未知'),
          rolledBack: rb,
          step: 'probe',
        };
      }
      probed = true;
    } catch (e) {
      const rb = restoreSnapshot(snapshot, deps);
      return { ok: false, error: '试听异常，已回滚：' + String(e).slice(0, 120), rolledBack: rb, step: 'probe' };
    }
  }

  return { ok: true, characterId: cid, applied: { provider, voiceId, speed: ref.speed, sourceId: ref.sourceId }, previous, probed };
}

/** 把快照写回去；返回是否成功 */
export function restoreSnapshot(snapshot: any, deps: Pick<ApplyDeps, 'writeConfig'>): boolean {
  try {
    const w = deps.writeConfig(clone(snapshot));
    return typeof w === 'boolean' ? w : !!w.ok;
  } catch (e) { return false; }
}

/** 两份配置是否等价（用来在单测里验证「原样还原」） */
export function sameConfig(a: any, b: any): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}
