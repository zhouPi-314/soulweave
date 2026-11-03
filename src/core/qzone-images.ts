/**
 * SoulWeave S11：QQ 空间配图校验
 *
 * NapCat 的 send_qzone_msg 接受 images 数组（本地路径 / URL / Base64），
 * 但 QQ 空间单条最多 9 图，且对格式挑剔。
 *
 * 【为什么先校验】
 * 图片是在「发送」那一刻才被读取的。如果等到点发布才发现路径不存在或格式不支持，
 * 用户已经走完审批流程了 —— 失败一次很挫败。所以在入草稿时就挡掉。
 */

import fs from 'node:fs';

export type ImageCheck = {
  ok: boolean;
  images: string[];
  errors: string[];
};

/** QQ 空间接受的图片扩展名 */
export const ALLOWED_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

/** 单张上限（QQ 空间实际限制更宽松，但 10MB 足够，也避免误传大文件） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 单条最多 9 图 */
export const MAX_IMAGES = 9;

export type ImageDeps = {
  exists?: (p: string) => boolean;
  sizeOf?: (p: string) => number;
};

function extOf(p: string): string {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i).toLowerCase();
}

/**
 * 校验一组图片路径。
 * 只做本地文件校验：URL 与 Base64 直接放过（交给 NapCat）。
 */
export function validateImages(paths: string[], deps: ImageDeps = {}): ImageCheck {
  const exists = deps.exists || ((p: string) => {
    try { return fs.existsSync(p); } catch (e) { return false; }
  });
  const sizeOf = deps.sizeOf || ((p: string) => {
    try { return fs.statSync(p).size; } catch (e) { return 0; }
  });

  const list = (paths || []).map((x) => String(x || '').trim()).filter(Boolean);
  const errors: string[] = [];
  if (!list.length) return { ok: true, images: [], errors: [] };
  if (list.length > MAX_IMAGES) {
    return { ok: false, images: [], errors: ['单条最多 ' + MAX_IMAGES + ' 张图片（当前 ' + list.length + ' 张）'] };
  }

  const out: string[] = [];
  for (const p of list) {
    // URL / data URI 直接放行
    if (/^https?:\/\//i.test(p) || /^data:image\//i.test(p)) { out.push(p); continue; }
    const ext = extOf(p);
    if (!ALLOWED_IMAGE_EXT.includes(ext)) {
      errors.push('不支持的图片格式：' + (ext || '(无扩展名)') + ' — ' + p);
      continue;
    }
    if (!exists(p)) { errors.push('图片不存在：' + p); continue; }
    const size = sizeOf(p);
    if (size <= 0) { errors.push('图片是空文件：' + p); continue; }
    if (size > MAX_IMAGE_BYTES) { errors.push('图片超过 10MB：' + p); continue; }
    out.push(p);
  }
  return { ok: errors.length === 0, images: out, errors };
}
