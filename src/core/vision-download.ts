/*
 * SoulWeave S7：远端图片下载与校验
 *
 * 依据：01 需求 §7.9「QQ 图片」—— QQ 消息里的图片是 URL，
 *       要识别就得先拉下来，而拉下来的东西必须当**不可信输入**处理。
 *
 * 【为什么单独一个模块】
 * 下载这一环有三个真实风险，混在业务里必然漏：
 *   1. 无限大的文件（对方发个 2 GB 的「图片」）
 *   2. 不是图片（服务端返回 HTML 错误页、甚至可执行文件）
 *   3. 慢速攻击（一直不结束，占着连接）
 * 所以这里的每一步都有硬上限，且全部可测。
 */

import {
  detectImageFormat, isSupportedFormat, readDimensions, mimeForFormat,
  MAX_IMAGE_BYTES,
  type ImageFormat, type VisionImage,
} from './vision-types.js';

export interface DownloadOptions {
  /** 体积上限，默认 8 MB */
  maxBytes?: number;
  /** 总超时，默认 20 秒 */
  timeoutMs?: number;
  /** 允许的格式，默认 png/jpeg/webp/gif */
  allowFormats?: ImageFormat[];
  /** 只允许 http/https（默认 true，防 file:// 读取本地文件） */
  requireHttp?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export type DownloadErrorCode =
  | 'BAD_URL'
  | 'TOO_BIG'
  | 'NOT_IMAGE'
  | 'UNSUPPORTED_FORMAT'
  | 'TIMEOUT'
  | 'NETWORK';

export interface DownloadResult {
  ok: boolean;
  image?: VisionImage;
  code?: DownloadErrorCode;
  error?: string;
  /** 实际下载字节数（截断前） */
  bytes?: number;
  ms?: number;
}

// ─── URL 校验（纯函数） ─────────────────────────────

/**
 * 判断这个 URL 能不能下。
 *
 * 拒绝 file: / data: / ftp: —— 这是安全边界，不是洁癖：
 * QQ 消息里的 URL 来自对方，如果允许 file:// 就等于让对方读你硬盘。
 */
export function validateImageUrl(raw: string, opts: { requireHttp?: boolean } = {}): { ok: boolean; url?: string; error?: string } {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: '空地址' };
  if (s.length > 2048) return { ok: false, error: '地址过长' };

  const requireHttp = opts.requireHttp !== false;
  let u: URL;
  try {
    u = new URL(s);
  } catch (e) {
    return { ok: false, error: '不是合法地址：' + s.slice(0, 80) };
  }

  if (requireHttp) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: '只允许 http/https，拒绝 ' + u.protocol };
    }
  }
  return { ok: true, url: u.toString() };
}

// ─── 字节校验（纯函数） ─────────────────────────────

export interface ByteCheck {
  ok: boolean;
  code?: DownloadErrorCode;
  error?: string;
  format?: ImageFormat;
}

/**
 * 校验下载下来的字节真的是图片。
 *
 * 不信任 Content-Type：很多图床对错误页也返回 image/*，
 * 而有些 CDN 把 JPEG 标成 application/octet-stream。
 * **只看 magic bytes。**
 */
export function checkImageBytes(buf: Uint8Array | null | undefined, opts: { maxBytes?: number; allowFormats?: ImageFormat[] } = {}): ByteCheck {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const allow = opts.allowFormats ?? ['png', 'jpeg', 'webp', 'gif'];

  if (!buf || !buf.length) {
    return { ok: false, code: 'NOT_IMAGE', error: '内容为空' };
  }
  if (buf.length > maxBytes) {
    return {
      ok: false, code: 'TOO_BIG',
      error: '图片有 ' + Math.round(buf.length / 1048576) + ' MB，上限 ' + Math.round(maxBytes / 1048576) + ' MB',
    };
  }
  const fmt = detectImageFormat(buf);
  if (fmt === 'unknown') {
    return { ok: false, code: 'NOT_IMAGE', error: '内容不是图片（可能是错误页或其它文件）' };
  }
  if (!allow.includes(fmt)) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', error: '不支持 ' + fmt + ' 格式' };
  }
  return { ok: true, format: fmt };
}

/** 字节 → VisionImage（带尺寸） */
export function toImage(buf: Uint8Array, fmt?: ImageFormat): VisionImage {
  const f = fmt || detectImageFormat(buf);
  const dim = readDimensions(buf, f);
  return {
    data: buf,
    format: f,
    mime: mimeForFormat(f),
    bytes: buf.length,
    width: dim ? dim.width : undefined,
    height: dim ? dim.height : undefined,
  };
}

// ─── 下载 ───────────────────────────────────────────

/**
 * 下载一张图并校验。
 *
 * 体积检查是**边下边算**的：不能先下完再看大小，
 * 否则一个 2 GB 的响应已经进了内存。
 */
export async function downloadImage(rawUrl: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const now = opts.now || (() => Date.now());
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const t0 = now();

  const v = validateImageUrl(rawUrl, { requireHttp: opts.requireHttp });
  if (!v.ok) return { ok: false, code: 'BAD_URL', error: v.error, ms: now() - t0 };

  const f = opts.fetch || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const r = await f(v.url!, { signal: ctl.signal, redirect: 'follow' } as any);
    if (!r.ok) {
      clearTimeout(timer);
      return { ok: false, code: 'NETWORK', error: 'HTTP ' + r.status, ms: now() - t0 };
    }

    // 声明长度超限就直接放弃，省得白下
    const declared = Number(r.headers && (r.headers as any).get ? (r.headers as any).get('content-length') : 0) || 0;
    if (declared > maxBytes) {
      clearTimeout(timer);
      return {
        ok: false, code: 'TOO_BIG',
        error: '服务端声明 ' + Math.round(declared / 1048576) + ' MB，超过上限',
        bytes: declared, ms: now() - t0,
      };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (r.body && typeof (r.body as any).getReader === 'function') {
      const reader = (r.body as any).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch (e) { void e; }
            clearTimeout(timer);
            return {
              ok: false, code: 'TOO_BIG',
              error: '下载超过 ' + Math.round(maxBytes / 1048576) + ' MB，已中止',
              bytes: total, ms: now() - t0,
            };
          }
          chunks.push(value);
        }
      }
    } else {
      const buf = new Uint8Array(await r.arrayBuffer());
      total = buf.length;
      chunks.push(buf);
    }
    clearTimeout(timer);

    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }

    const check = checkImageBytes(merged, { maxBytes, allowFormats: opts.allowFormats });
    if (!check.ok) {
      return { ok: false, code: check.code, error: check.error, bytes: total, ms: now() - t0 };
    }

    return {
      ok: true,
      image: toImage(merged, check.format),
      bytes: total,
      ms: now() - t0,
    };
  } catch (e: any) {
    clearTimeout(timer);
    const msg = String(e && e.message ? e.message : e);
    const ms = now() - t0;
    if (/abort/i.test(msg)) return { ok: false, code: 'TIMEOUT', error: '下载超时', ms };
    return { ok: false, code: 'NETWORK', error: msg.slice(0, 160), ms };
  }
}

/**
 * 把 data URI 直接解析成图片（不联网）。
 *
 * QQ 有些实现会直接给 base64:// 或 data:image/...，这种不用下载。
 */
export function parseDataUri(raw: string): { ok: boolean; image?: VisionImage; error?: string } {
  const s = String(raw || '');
  const m = s.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return { ok: false, error: '不是 data URI' };
  try {
    const buf = m[2]
      ? new Uint8Array(Buffer.from(m[3], 'base64'))
      : new Uint8Array(Buffer.from(decodeURIComponent(m[3]), 'binary'));
    const check = checkImageBytes(buf);
    if (!check.ok) return { ok: false, error: check.error };
    return { ok: true, image: toImage(buf, check.format) };
  } catch (e: any) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

/**
 * OneBot 的 image 段可能给三种东西：http URL、base64://xxx、file://xxx。
 * 这里统一成一个入口，调用方不用关心是哪种。
 */
export async function resolveImageSource(
  seg: { url?: string; file?: string },
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const url = String(seg && seg.url ? seg.url : '');
  const file = String(seg && seg.file ? seg.file : '');

  if (url) return downloadImage(url, opts);

  if (file.startsWith('base64://')) {
    const b64 = file.slice('base64://'.length);
    try {
      const buf = new Uint8Array(Buffer.from(b64, 'base64'));
      const check = checkImageBytes(buf, { maxBytes: opts.maxBytes, allowFormats: opts.allowFormats });
      if (!check.ok) return { ok: false, code: check.code, error: check.error };
      return { ok: true, image: toImage(buf, check.format), bytes: buf.length };
    } catch (e: any) {
      return { ok: false, code: 'NOT_IMAGE', error: 'base64 解析失败' };
    }
  }

  if (file.startsWith('data:')) {
    const r = parseDataUri(file);
    if (!r.ok) return { ok: false, code: 'NOT_IMAGE', error: r.error };
    return { ok: true, image: r.image, bytes: r.image!.bytes };
  }

  return { ok: false, code: 'BAD_URL', error: '这张图既没有 URL 也不是内联数据，无法读取' };
}
