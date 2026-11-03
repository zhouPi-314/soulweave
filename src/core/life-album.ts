/*
 * SoulWeave S6：虚拟相册 + 图片生成抽象层
 *
 * 依据：01 需求 6.3「虚拟相册：按角色、时间、事件分类，预览、搜索、收藏、删除、导出；
 *                  图片生成频率可在 Desktop 自定义」
 *      01 需求 7.8「虚拟照片、画作、相册」
 *
 * 【图片生成的三种 Provider】（详见 S6_图片生成方案评估.md）
 *   pollinations —— 免费无 key，45 秒 1 张（默认）
 *   openai-compatible —— 硅基流动/智谱等，需 key
 *   local-sd —— ComfyUI / sd.cpp，需本地安装
 *
 * 所有 provider 失败时降级为占位图，不阻塞日记保存。
 */

// ─── 类型 ───────────────────────────────────────────

export type MediaKind = 'photo' | 'illustration';
export type ImageProvider = 'pollinations' | 'openai-compatible' | 'local-sd' | 'none';

export interface LifeMedia {
  id?: number;
  ownerCharacter: string;
  eventId?: number | null;
  relPath: string;
  mediaKind: MediaKind;
  width?: number;
  height?: number;
  bytes?: number;
  prompt?: string;
  provider?: string;
  isFictional: boolean;
  aiGenerated: boolean;
  favorite: boolean;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface ImageGenRequest {
  prompt: string;
  width?: number;
  height?: number;
  /** 负面提示词（部分 provider 支持） */
  negative?: string;
  /** 随机种子 */
  seed?: number;
}

export interface ImageGenResult {
  ok: boolean;
  /** 图片二进制 */
  data?: Uint8Array;
  /** MIME 类型 */
  mime?: string;
  error?: string;
  /** 实际使用的 provider */
  provider?: string;
  /** 是否需要等待（限流） */
  retryAfterMs?: number;
  /**
   * 机器可读的错误码。
   * 用于上层区分「可以继续降级」和「必须让用户决定」两类失败。
   */
  code?: ImageErrorCode;
}

/** 图片生成的错误码 */
export type ImageErrorCode =
  | 'IGPU_ONLY'      // 只有核显，本地 SD 会崩溃
  | 'NO_MODEL'       // 缺模型文件
  | 'NO_CONFIG'      // 缺配置（key/地址）
  | 'NETWORK'        // 网络不可达
  | 'QUOTA'          // 额度用尽
  | 'TIMEOUT';       // 超时

export interface ImageGenConfig {
  provider: ImageProvider;
  /** openai-compatible 用 */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** local-sd 用 */
  localEndpoint?: string;
  /** 默认尺寸 */
  defaultWidth?: number;
  defaultHeight?: number;
}

export const DEFAULT_IMAGE_CFG: ImageGenConfig = {
  provider: 'pollinations',
  defaultWidth: 768,
  defaultHeight: 768,
};

// ─── 校验 ───────────────────────────────────────────

const VALID_MEDIA_KINDS: MediaKind[] = ['photo', 'illustration'];

export function validateMedia(m: Partial<LifeMedia>): { ok: boolean; error?: string } {
  if (!m.ownerCharacter || !String(m.ownerCharacter).trim()) {
    return { ok: false, error: '缺少角色标识' };
  }
  if (!m.relPath || !String(m.relPath).trim()) {
    return { ok: false, error: '缺少文件路径' };
  }
  // 路径安全：不允许绝对路径和 ..
  const rp = String(m.relPath);
  if (/^[a-zA-Z]:|^[\\\\/]/.test(rp) || rp.includes('..')) {
    return { ok: false, error: '路径必须是相对路径且不能包含 ..' };
  }
  if (m.mediaKind && !VALID_MEDIA_KINDS.includes(m.mediaKind)) {
    return { ok: false, error: '媒体类型非法' };
  }
  return { ok: true };
}

/** 规范化：AI 生成的图片默认虚构 */
export function normalizeMedia(m: Partial<LifeMedia>): LifeMedia {
  const provider = String(m.provider || '');
  const isAi = provider !== '' && provider !== 'user';
  const isUserReal = provider === 'user' && m.isFictional === false;
  return {
    ownerCharacter: String(m.ownerCharacter || '').trim(),
    eventId: m.eventId ?? null,
    relPath: String(m.relPath || '').trim(),
    mediaKind: VALID_MEDIA_KINDS.includes(m.mediaKind as MediaKind) ? (m.mediaKind as MediaKind) : 'photo',
    width: m.width ? Number(m.width) : undefined,
    height: m.height ? Number(m.height) : undefined,
    bytes: m.bytes ? Number(m.bytes) : undefined,
    prompt: m.prompt ? String(m.prompt).slice(0, 2000) : undefined,
    provider: provider || undefined,
    isFictional: isUserReal ? false : true,
    aiGenerated: isAi ? true : !!m.aiGenerated,
    favorite: !!m.favorite,
  };
}

// ─── 尺寸档位（显存友好） ───────────────────────────

export interface SizePreset {
  label: string;
  width: number;
  height: number;
  /** 大致显存需求（MB），本地生成用 */
  vramMb: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  { label: '小（512×512）', width: 512, height: 512, vramMb: 3000 },
  { label: '中（768×768）', width: 768, height: 768, vramMb: 4200 },
  { label: '大（1024×1024）', width: 1024, height: 1024, vramMb: 6000 },
  { label: '竖版（768×1024）', width: 768, height: 1024, vramMb: 5200 },
  { label: '横版（1024×768）', width: 1024, height: 768, vramMb: 5200 },
];

/**
 * 按可用显存推荐尺寸。
 *
 * 你的机器是 6141 MiB，Live2D 占 0.5-1 GB，
 * 所以本地 SD 实际可用约 5 GB → 推荐 768×768。
 */
export function recommendSize(availableVramMb: number): SizePreset {
  const usable = availableVramMb * 0.85;  // 留 15% 余量
  const fit = SIZE_PRESETS.filter((p) => p.vramMb <= usable);
  if (!fit.length) return SIZE_PRESETS[0];
  return fit[fit.length - 1];
}

// ─── 占位图（所有 provider 失败时的降级） ───────────

/**
 * 生成一个纯色 SVG 占位图。
 *
 * 为什么用 SVG：不需要任何图像库，几行字符串就能生成，
 * 且浏览器/Electron 原生支持。
 */
export function makePlaceholderSvg(opts: {
  width?: number;
  height?: number;
  text?: string;
  hue?: number;
}): string {
  const wd = opts.width || 768;
  const ht = opts.height || 768;
  const hue = opts.hue ?? 210;
  const text = String(opts.text || '图片生成暂不可用').slice(0, 40);
  // 转义 XML 特殊字符
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + wd + '" height="' + ht + '" viewBox="0 0 ' + wd + ' ' + ht + '">',
    '  <defs>',
    '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    '      <stop offset="0%" stop-color="hsl(' + hue + ',40%,22%)"/>',
    '      <stop offset="100%" stop-color="hsl(' + (hue + 40) + ',35%,14%)"/>',
    '    </linearGradient>',
    '  </defs>',
    '  <rect width="100%" height="100%" fill="url(#g)"/>',
    '  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" ',
    '        font-family="system-ui,sans-serif" font-size="' + Math.round(wd / 24) + '" ',
    '        fill="rgba(255,255,255,0.55)">' + esc + '</text>',
    '</svg>',
  ].join('\n');
}

// ─── 提示词构造 ─────────────────────────────────────

/**
 * 构造二次元风格的图片提示词。
 *
 * 需求强调「虚拟生活照片、插画」「积极乐观向上」，
 * 所以固定加正向风格词，避免生成阴暗内容。
 */
export function buildImagePrompt(input: {
  subject: string;
  scene?: string;
  mood?: string;
  style?: string;
}): string {
  const parts = [
    input.subject,
    input.scene || '',
    input.mood || '',
    input.style || 'anime style illustration',
    'soft lighting',
    'high quality',
    'warm colors',
    'wholesome',
  ];
  return parts.filter((p) => p && p.trim()).join(', ').slice(0, 1000);
}

export const DEFAULT_NEGATIVE = 'lowres, bad anatomy, bad hands, text, watermark, signature, nsfw, dark, gloomy';

// ─── 频率控制（图片生成比文字贵，单独限流） ─────────

export interface ImageRateLimit {
  /** 最小间隔（秒）。Pollinations 免费额度是 45 秒 */
  minIntervalSeconds: number;
  /** 每天最多生成张数 */
  dailyMax: number;
}

export const DEFAULT_IMAGE_RATE: ImageRateLimit = {
  minIntervalSeconds: 45,
  dailyMax: 30,
};

/** 按 provider 调整限流参数 */
export function rateLimitFor(provider: ImageProvider): ImageRateLimit {
  switch (provider) {
    case 'pollinations':
      return { minIntervalSeconds: 45, dailyMax: 30 };
    case 'openai-compatible':
      return { minIntervalSeconds: 5, dailyMax: 200 };
    case 'local-sd':
      return { minIntervalSeconds: 3, dailyMax: 500 };
    default:
      return DEFAULT_IMAGE_RATE;
  }
}

export function checkImageRate(
  lastAt: number | null,
  todayCount: number,
  now: number,
  lim: ImageRateLimit,
): { ok: boolean; reason?: string; retryAfterMs?: number } {
  if (todayCount >= lim.dailyMax) {
    return { ok: false, reason: '今日图片生成已达上限 (' + todayCount + '/' + lim.dailyMax + ')' };
  }
  if (lastAt != null && lim.minIntervalSeconds > 0) {
    const elapsed = now - lastAt;
    const need = lim.minIntervalSeconds * 1000;
    if (elapsed < need) {
      const left = need - elapsed;
      return {
        ok: false,
        reason: '图片生成冷却中，还需 ' + Math.ceil(left / 1000) + ' 秒',
        retryAfterMs: left,
      };
    }
  }
  return { ok: true };
}
