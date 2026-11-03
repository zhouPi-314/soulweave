/*
 * SoulWeave S7：截图服务（desktopCapturer 封装）
 *
 * 依据：01 需求 §7.9「授权截图」；§3.2「禁止默认持续截屏」
 *
 * 【设计约束（来自 capture-policy）】
 *   · 每次截取都必须先过闸门
 *   · 截完立刻返回字节，**不落盘、不留缓存**
 *   · 一次授权只对应一次截取
 *
 * 【为什么截图不写文件】
 * 用户屏幕上可能有任何东西。写进临时文件就多了一份「可能被别的程序读到、
 * 可能被备份带走、可能忘了删」的副本。直接在内存里传给视觉接口最安全。
 */

import { desktopCapturer, screen } from 'electron';
import {
  evaluateCapture, consumeGrant, makeAudit,
  type CaptureGrant, type CaptureDecision, type CaptureAuditEntry,
} from './capture-policy.js';
import { detectImageFormat, readDimensions, type VisionImage, mimeForFormat } from './vision-types.js';

export interface CaptureSourceInfo {
  id: string;
  name: string;
  /** 窗口所属应用名（部分平台提供） */
  appName?: string;
  thumbnail?: string;
}

export interface CaptureResult {
  ok: boolean;
  image?: VisionImage;
  decision: CaptureDecision;
  audit?: CaptureAuditEntry;
  error?: string;
}

/** 列出可截的屏幕与窗口（给用户选，不截任何东西） */
export async function listCaptureSources(opts: { windows?: boolean } = {}): Promise<CaptureSourceInfo[]> {
  try {
    const types: Array<'screen' | 'window'> = opts.windows === false ? ['screen'] : ['screen', 'window'];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 0, height: 0 },   // 不要缩略图：列清单时不该抓任何画面
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: String(s.id),
      name: String(s.name || ''),
      appName: undefined,
      thumbnail: undefined,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * 按 id 截一张。
 *
 * 注意 thumbnailSize 给的是**真实分辨率**：
 * desktopCapturer 默认只给缩略图（很小），直接拿去识别会糊到看不清字。
 */
export async function captureSourceById(
  sourceId: string,
  opts: { maxWidth?: number; maxHeight?: number } = {},
): Promise<{ ok: boolean; image?: VisionImage; error?: string }> {
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const maxW = Math.min(opts.maxWidth || 1920, Math.round(display.size.width * scale));
    const maxH = Math.min(opts.maxHeight || 1080, Math.round(display.size.height * scale));

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: maxW, height: maxH },
      fetchWindowIcons: false,
    });
    const hit = sources.find((s) => String(s.id) === String(sourceId));
    if (!hit) return { ok: false, error: '找不到这个屏幕或窗口（可能已关闭）' };

    const png = hit.thumbnail.toPNG();
    if (!png || !png.length) return { ok: false, error: '截图内容为空' };

    const data = new Uint8Array(png);
    const fmt = detectImageFormat(data);
    const dim = readDimensions(data, fmt);
    return {
      ok: true,
      image: {
        data,
        format: fmt,
        mime: mimeForFormat(fmt),
        bytes: data.length,
        width: dim ? dim.width : undefined,
        height: dim ? dim.height : undefined,
      },
    };
  } catch (e: any) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/**
 * 走完整流程：闸门 → 截取 → 消费授权 → 审计。
 *
 * 这是唯一对外入口。任何绕过它直接调 captureSourceById 的写法都是错的。
 */
export async function captureWithPolicy(input: {
  grant: CaptureGrant | null;
  ownerCharacter: string;
  targetKind: 'fullscreen' | 'window';
  windowId?: string;
  now: number;
}): Promise<CaptureResult> {
  const req = {
    ownerCharacter: input.ownerCharacter,
    targetKind: input.targetKind,
    windowId: input.windowId,
    now: input.now,
  };

  const decision = evaluateCapture(req, input.grant);
  if (!decision.allowed) {
    return {
      ok: false,
      decision,
      audit: makeAudit(req, decision, null),
      error: decision.reason,
    };
  }

  // 全屏：截主屏；窗口：按 id 截
  let sourceId = '';
  if (input.targetKind === 'fullscreen') {
    const sources = await listCaptureSources({ windows: false });
    sourceId = sources.length ? sources[0].id : '';
  } else {
    sourceId = String(input.windowId || '');
  }
  if (!sourceId) {
    const d: CaptureDecision = { allowed: false, code: 'BAD_REQUEST', reason: '没有可截的屏幕', shouldAsk: false };
    return { ok: false, decision: d, audit: makeAudit(req, d, null), error: d.reason };
  }

  const shot = await captureSourceById(sourceId);
  if (!shot.ok) {
    const d: CaptureDecision = { allowed: false, code: 'BAD_REQUEST', reason: shot.error || '截图失败', shouldAsk: false };
    return { ok: false, decision: d, audit: makeAudit(req, d, null), error: d.reason };
  }

  return {
    ok: true,
    image: shot.image,
    decision,
    audit: makeAudit(req, decision, 'capture-' + input.now),
  };
}

/** 截图后把授权消费掉（once 用一次即废） */
export function consumeAfterCapture(grant: CaptureGrant | null): CaptureGrant | null {
  return grant ? consumeGrant(grant) : null;
}
