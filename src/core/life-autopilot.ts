/*
 * SoulWeave S6.16：主动行为的「执行」环节
 *
 * 前面的模块负责「该不该动」（三重闸门 + 计划 + 信号），
 * 这个模块负责「动了以后要留下什么」：
 *   生成图片 → 落盘 → 写事件 → 写媒体 → 记录用量
 *
 * 【为什么单独抽出来】
 * 这段逻辑要能被测试驱动（假 repo、假生成器、假时钟），
 * 如果写死在主进程的 IPC 里就只能靠手动点界面验证。
 *
 * 【失败时的原则】
 *   · 图片生成失败 → 什么都不写（不留下空记录）
 *   · 落盘失败 → 不写媒体，也不写事件（避免有事件没图）
 *   · 写事件成功、写媒体失败 → 事件保留，返回部分成功
 *   · 用量计数只在真正产出后 +1
 */

import { dayKey } from './life-budget.js';

// ─── 类型 ───────────────────────────────────────────

export interface ProactiveRepoLike {
  createEvent(input: any): Promise<{ ok: boolean; id?: number; error?: string }>;
  createMedia(input: any): Promise<{ ok: boolean; id?: number; error?: string }>;
  bumpProactiveUsage(owner: string, day: string, kind: string): Promise<{ ok: boolean; count?: number; error?: string }>;
}

export interface GenResultLike {
  ok: boolean;
  data?: Uint8Array;
  mime?: string;
  provider?: string;
  error?: string;
  code?: string;
}

export interface ProactiveActionDeps {
  repo: ProactiveRepoLike;
  generate: (req: { prompt: string; character: string; activityKind: string; mood?: string }) => Promise<GenResultLike>;
  /** 把图片写到 (角色/文件名)，路径相对相册根 */
  saveImage: (relPath: string, data: Uint8Array) => Promise<{ ok: boolean; error?: string }>;
  now?: () => Date;
  /** 文件名里的随机串（测试可固定） */
  token?: () => string;
}

export interface ProactiveActionInput {
  character: string;
  activityTitle: string;
  activityKind: string;
  mood?: string;
  /** 触发的计划点（分钟）；手动触发时为空 */
  plannedMinute?: number;
  /** 触发来源 */
  trigger?: 'plan' | 'signal' | 'manual';
}

export interface ProactiveActionResult {
  ok: boolean;
  error?: string;
  /** 出错在哪个阶段 */
  stage?: 'generate' | 'save' | 'event' | 'media';
  code?: string;
  eventId?: number;
  mediaId?: number;
  relPath?: string;
  provider?: string;
  prompt?: string;
  bytes?: number;
  /** 部分成功：事件写了但媒体没写 */
  partial?: boolean;
}

// ─── 提示词构造 ─────────────────────────────────────

const KIND_SCENE: Record<string, string> = {
  sleep: 'sleeping peacefully in a cozy bedroom, soft moonlight',
  work: 'working at a tidy desk with a laptop, warm afternoon light',
  study: 'reading a book at a wooden desk, quiet library atmosphere',
  meal: 'enjoying a meal at a sunny kitchen table',
  rest: 'relaxing on a sofa with a cup of tea, gentle sunlight',
  play: 'having fun in a cozy living room, playful atmosphere',
  walk: 'walking along a tree-lined path, soft daylight',
  wake: 'waking up in a bright bedroom, morning light',
};

/**
 * 把「当前活动」翻译成图片提示词。
 *
 * 为什么不用 AI 生成提示词：
 *   多一次模型调用 = 多一次失败点和延迟；
 *   固定模板 + 活动类型 + 心情已经足够稳定。
 */
export function buildImagePrompt(input: {
  character: string;
  activityKind?: string;
  activityTitle?: string;
  mood?: string;
}): string {
  const kind = String(input.activityKind || '');
  const scene = KIND_SCENE[kind] || ('doing something quiet at home, ' + String(input.activityTitle || 'peaceful moment'));
  const mood = input.mood ? (', ' + input.mood + ' mood') : '';
  return ('a gentle anime illustration of a girl ' + scene + mood +
    ', soft warm lighting, cozy atmosphere, clean line art, pastel colors, high quality');
}

// ─── 扩展名 ─────────────────────────────────────────

/**
 * 按 MIME 决定文件扩展名。
 *
 * 实测教训：Cloudflare 返回的是 JPEG（image/jpeg），
 * 如果一律存成 .png，文件内容与后缀不符，
 * 读取图片时会报「扩展名声明 png 但字节不是」。
 */
export function extFromMime(mime?: string): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('png')) return '.png';
  return '.png';
}

/** 生成文件名：<角色>/<YYYYMMDD-HHmmss>-<token><ext> */
export function buildRelPath(character: string, now: Date, ext: string, token: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
    '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
  const safeChar = String(character || 'shared').replace(/[\\/:*?"<>|]/g, '_');
  return safeChar + '/' + stamp + '-' + token + ext;
}

// ─── 事件标题 ───────────────────────────────────────

export function buildEventTitle(input: ProactiveActionInput): string {
  const t = input.activityTitle || '安静的时刻';
  if (input.trigger === 'signal') return '想起了你 · ' + t;
  if (input.trigger === 'manual') return '分享此刻 · ' + t;
  return '此刻 · ' + t;
}

// ─── 主流程 ─────────────────────────────────────────

/**
 * 执行一次主动行为：生成图 → 落盘 → 写事件 → 写媒体 → 记用量。
 *
 * 调用方负责在前面做闸门判断；这里只管执行和落库。
 */
export async function performProactiveAction(
  deps: ProactiveActionDeps,
  input: ProactiveActionInput,
): Promise<ProactiveActionResult> {
  const now = (deps.now || (() => new Date()))();
  const character = String(input.character || '').trim();
  if (!character) return { ok: false, error: '缺少角色标识', stage: 'generate' };

  const prompt = buildImagePrompt(input);

  // 1. 生成
  let gen: GenResultLike;
  try {
    gen = await deps.generate({
      prompt, character,
      activityKind: input.activityKind,
      mood: input.mood,
    });
  } catch (e) {
    return { ok: false, error: '生成抛异常：' + String(e).slice(0, 150), stage: 'generate' };
  }
  if (!gen || !gen.ok || !gen.data || !gen.data.length) {
    return {
      ok: false,
      error: (gen && gen.error) || '生成失败或返回空数据',
      stage: 'generate',
      code: gen && gen.code,
    };
  }

  // 2. 落盘（按 mime 选扩展名）
  const ext = extFromMime(gen.mime);
  const token = (deps.token || (() => Math.random().toString(36).slice(2, 8)))();
  const relPath = buildRelPath(character, now, ext, token);
  try {
    const saved = await deps.saveImage(relPath, gen.data);
    if (!saved || !saved.ok) {
      return { ok: false, error: '落盘失败：' + ((saved && saved.error) || '未知'), stage: 'save' };
    }
  } catch (e) {
    return { ok: false, error: '落盘抛异常：' + String(e).slice(0, 150), stage: 'save' };
  }

  // 3. 写事件
  const title = buildEventTitle(input);
  const body = input.trigger === 'manual'
    ? '手动分享了一张此刻的画面。'
    : (input.trigger === 'signal' ? '忽然想起你，发来一张当下的画面。' : '按今天的节奏，记录此刻。');

  let eventId: number | undefined;
  try {
    const ev = await deps.repo.createEvent({
      ownerCharacter: character,
      kind: 'activity',   // 必须是 VALID_KINDS 里的值，否则会被归一化成 event
      title,
      body,
      mood: input.mood,
      occurredAt: now.toISOString(),
      isFictional: true,
      aiGenerated: true,
      source: 'ai',
      scope: 'private',
    });
    if (!ev || !ev.ok) {
      return { ok: false, error: '写事件失败：' + ((ev && ev.error) || '未知'), stage: 'event', relPath };
    }
    eventId = ev.id;
  } catch (e) {
    return { ok: false, error: '写事件抛异常：' + String(e).slice(0, 150), stage: 'event', relPath };
  }

  // 4. 写媒体
  try {
    const md = await deps.repo.createMedia({
      ownerCharacter: character,
      eventId,
      relPath,
      mediaKind: 'illustration',
      bytes: gen.data.length,
      prompt,
      provider: gen.provider,
      isFictional: true,
      aiGenerated: true,
    });
    if (!md || !md.ok) {
      return {
        ok: false, error: '写媒体失败：' + ((md && md.error) || '未知'),
        stage: 'media', eventId, relPath, provider: gen.provider,
        prompt, bytes: gen.data.length, partial: true,
      };
    }

    // 5. 记用量（只有真正产出后）
    try {
      await deps.repo.bumpProactiveUsage(character, dayKey(now), 'private_chat');
    } catch (e) { /* 计数失败不回滚已产出的内容 */ }

    return {
      ok: true, eventId, mediaId: md.id, relPath,
      provider: gen.provider, prompt, bytes: gen.data.length,
    };
  } catch (e) {
    return {
      ok: false, error: '写媒体抛异常：' + String(e).slice(0, 150),
      stage: 'media', eventId, relPath, provider: gen.provider, partial: true,
    };
  }
}