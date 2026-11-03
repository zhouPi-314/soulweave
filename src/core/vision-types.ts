/*
 * SoulWeave S7：视觉（图片理解）类型与抽象
 *
 * 依据：
 *   01 需求 §3.2「视觉：用户发来的图片、经明确授权的屏幕截图；禁止默认持续截屏」
 *   01 需求 §7.9「图片识别、QQ 图片、授权截图、图片生成 API、质量尺寸/次数」
 *   01 需求 §7.5「权限在后端强制执行，不能仅靠提示词；屏幕截图按需授权」
 *   D31「用户主动上传图片与授权截图，不持续抓屏」
 *
 * 【这个文件只放类型和纯函数，不做 IO】
 * 理由：视觉链路的错误分支特别多（没 key / 模型不支持图片 / 图太大 / 下载失败），
 * 把判定逻辑做成纯函数才能穷举测试，不会因为一个分支漏测而把隐私图传出去。
 */

// ─── 图片来源 ───────────────────────────────────────

/**
 * 图片从哪来。
 *
 * 分开记不是为了好看：不同来源的**默认授权**完全不同。
 *   user_upload  用户自己拖进来的 → 用户意图明确，默认允许
 *   qq_image     好友发来的       → 默认**不识别**（可能是别人的隐私）
 *   screenshot   屏幕截图         → 必须单独授权，见 capture-policy
 */
export type VisionSourceKind = 'user_upload' | 'qq_image' | 'screenshot';

export const VISION_SOURCE_KINDS: VisionSourceKind[] = ['user_upload', 'qq_image', 'screenshot'];

/** 每种来源的默认是否允许自动识别 */
export const DEFAULT_SOURCE_ALLOWED: Record<VisionSourceKind, boolean> = {
  user_upload: true,
  qq_image: false,
  screenshot: false,
};

// ─── 图片输入 ───────────────────────────────────────

/** 支持的图片格式（按 magic bytes 判定，不看扩展名） */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'unknown';

export interface VisionImage {
  /** 原始字节 */
  data: Uint8Array;
  /** 探测出的格式 */
  format: ImageFormat;
  /** MIME */
  mime: string;
  /** 字节数 */
  bytes: number;
  width?: number;
  height?: number;
}

export interface VisionRequest {
  /** 图片（单次最多 MAX_IMAGES_PER_REQUEST 张） */
  images: VisionImage[];
  /** 用户想问什么；空则用默认「描述这张图」 */
  prompt?: string;
  /** 来源（决定审计与默认授权） */
  sourceKind: VisionSourceKind;
  /** 来源引用（消息 id / 文件路径 / 截图 id），审计用 */
  sourceRef?: string;
  /** 发起角色 */
  ownerCharacter?: string;
}

// ─── 限制（防呆，不是性能调优） ─────────────────────

/** 单张图上限 8 MB —— 大多数多模态 API 的实际门槛在 5–20 MB 之间 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单次最多 4 张，再多 token 会爆 */
export const MAX_IMAGES_PER_REQUEST = 4;
/** 一次识别的建议超时 */
export const VISION_TIMEOUT_MS = 60_000;

// ─── 结果 ───────────────────────────────────────────

export type VisionErrorCode =
  | 'NO_CONFIG'       // 没配 key / 地址
  | 'NOT_SUPPORTED'   // 模型不支持图片输入
  | 'IMAGE_TOO_BIG'   // 超过 MAX_IMAGE_BYTES
  | 'IMAGE_INVALID'   // 不是有效图片
  | 'TOO_MANY_IMAGES' // 超过 MAX_IMAGES_PER_REQUEST
  | 'DENIED'          // 权限闸门拒绝（截图/QQ 图片未授权）
  | 'NETWORK'
  | 'QUOTA'
  | 'TIMEOUT';

export interface VisionResult {
  ok: boolean;
  /** 模型给的描述/回答 */
  text?: string;
  /** 抽出的标签（模型返回 JSON 时可用；否则空） */
  tags?: string[];
  /** 实际用的模型 */
  model?: string;
  /** 耗时 */
  ms?: number;
  error?: string;
  code?: VisionErrorCode;
}

// ─── 纯函数：格式探测 ───────────────────────────────

/**
 * 按 magic bytes 判断格式。
 *
 * 【为什么不看扩展名】
 * QQ 存下来的图片经常没有扩展名，或者叫 xxx.jpg 其实是 PNG。
 * 扩展名只影响我们怎么告诉 API，不能拿来判断内容。
 */
export function detectImageFormat(buf: Uint8Array | null | undefined): ImageFormat {
  if (!buf || buf.length < 4) return 'unknown';
  const b = buf;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // GIF: 47 49 46 38
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  // BMP: 42 4D
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  // WEBP: RIFF....WEBP
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return 'unknown';
}

export function mimeForFormat(f: ImageFormat): string {
  switch (f) {
    case 'png': return 'image/png';
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

/** 多模态 API 通常只吃这四种 */
export function isSupportedFormat(f: ImageFormat): boolean {
  return f === 'png' || f === 'jpeg' || f === 'webp' || f === 'gif';
}

// ─── 纯函数：尺寸探测（不依赖图像库） ───────────────

export interface Dimensions { width: number; height: number }

/**
 * 从文件头读出宽高。
 *
 * 只解析 PNG / JPEG / GIF 三种 —— 覆盖 QQ 图片与截图的绝大多数，
 * 且都不需要解码整张图（几个字节就够），避免为了「知道多大」去装图像库。
 */
export function readDimensions(buf: Uint8Array | null | undefined, fmt?: ImageFormat): Dimensions | null {
  if (!buf || buf.length < 10) return null;
  const f = fmt || detectImageFormat(buf);
  const b = buf;

  if (f === 'png') {
    // IHDR 从第 16 字节开始：width(4) height(4) 大端
    if (b.length < 24) return null;
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return w && h ? { width: w, height: h } : null;
  }

  if (f === 'gif') {
    // 第 6..9：宽高各 2 字节小端
    if (b.length < 10) return null;
    const w = b[6] | (b[7] << 8);
    const h = b[8] | (b[9] << 8);
    return w && h ? { width: w, height: h } : null;
  }

  if (f === 'jpeg') {
    // 扫 SOFn 段（C0–CF，排除 C4/C8/CC）
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return w && h ? { width: w, height: h } : null;
      }
      i += 2 + len;
    }
    return null;
  }

  return null;
}

// ─── 纯函数：入参校验 ───────────────────────────────

export interface ValidateOptions {
  maxBytes?: number;
  maxImages?: number;
  /** 允许的格式；默认 png/jpeg/webp/gif */
  allowFormats?: ImageFormat[];
}

/**
 * 校验一次视觉请求。
 *
 * 顺序是刻意的：先看数量（最便宜）→ 再看单张体积 → 再看格式。
 * 任何一项不过都返回具体错误码，上层才能给出「该换图还是该改配置」的建议。
 */
export function validateVisionRequest(
  req: Partial<VisionRequest>,
  opts: ValidateOptions = {},
): { ok: boolean; code?: VisionErrorCode; error?: string } {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const maxImages = opts.maxImages ?? MAX_IMAGES_PER_REQUEST;
  const allow = opts.allowFormats ?? ['png', 'jpeg', 'webp', 'gif'];

  const imgs = Array.isArray(req.images) ? req.images : [];
  if (!imgs.length) {
    return { ok: false, code: 'IMAGE_INVALID', error: '没有图片' };
  }
  if (imgs.length > maxImages) {
    return {
      ok: false, code: 'TOO_MANY_IMAGES',
      error: '一次最多 ' + maxImages + ' 张图（收到 ' + imgs.length + ' 张）',
    };
  }

  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    const n = i + 1;
    if (!img || !img.data || !img.data.length) {
      return { ok: false, code: 'IMAGE_INVALID', error: '第 ' + n + ' 张是空的' };
    }
    const bytes = img.data.length;
    if (bytes > maxBytes) {
      return {
        ok: false, code: 'IMAGE_TOO_BIG',
        error: '第 ' + n + ' 张有 ' + Math.round(bytes / 1048576) + ' MB，上限 ' + Math.round(maxBytes / 1048576) + ' MB',
      };
    }
    const fmt = img.format && img.format !== 'unknown' ? img.format : detectImageFormat(img.data);
    if (!allow.includes(fmt)) {
      return {
        ok: false, code: 'IMAGE_INVALID',
        error: '第 ' + n + ' 张的格式不支持（' + fmt + '）',
      };
    }
  }

  return { ok: true };
}

/** 把字节变成 data URI（OpenAI 兼容视觉接口用这个） */
export function toDataUri(data: Uint8Array, fmt?: ImageFormat): string {
  const f = fmt || detectImageFormat(data);
  const mime = mimeForFormat(f);
  const b64 = Buffer.from(data).toString('base64');
  return 'data:' + mime + ';base64,' + b64;
}

/** 默认提问 */
export const DEFAULT_VISION_PROMPT = '请用中文描述这张图里有什么，注意文字内容、人物动作和场景。不要编造看不到的细节。';

/** 组装请求里的 prompt（纯函数，便于测试） */
export function buildVisionPrompt(prompt?: string): string {
  const p = String(prompt || '').trim();
  return p || DEFAULT_VISION_PROMPT;
}
