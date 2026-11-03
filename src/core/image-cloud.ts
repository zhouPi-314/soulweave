/*
 * SoulWeave S6.11：云端图片生成（Cloudflare Workers AI + ModelScope）
 *
 * 依据：S6 设计文档「云端模块设计」；用户 Q5 要求内置 CF + ModelScope
 *
 * 【两家服务】
 *   Cloudflare Workers AI —— FLUX.1-schnell（Apache-2.0），免费 10,000 neurons/天
 *   ModelScope 魔搭       —— 国内，需阿里云账号，额度政策会变
 *
 * 【响应格式兼容】
 * 不同服务、不同版本的响应结构不一致，所以要做容错：
 *   · 二进制图片（image/jpeg）
 *   · JSON + base64（{result:{image:"..."}} 或 {data:[{b64_json}]}）
 *   · JSON + URL（{data:[{url}]}）→ 需再下载
 * 三种都要能处理。
 */

import type { ImageProviderAdapter, ProviderProbe } from './image-provider.js';
import type { ImageGenRequest, ImageGenResult } from './life-album.js';
import { dayKey } from './life-budget.js';

// ─── 类型 ───────────────────────────────────────────

export type CloudProviderId = 'cloudflare' | 'modelscope' | 'openai-compatible';

export interface CloudConfig {
  provider: CloudProviderId;
  /** Cloudflare 用 */
  accountId?: string;
  /** Cloudflare API Token / 其他家的 Key */
  apiKey?: string;
  /** OpenAI 兼容端点（ModelScope / 硅基流动 / 智谱） */
  baseUrl?: string;
  /** 模型名 */
  model?: string;
  /** 请求超时 */
  timeoutMs?: number;
  /** 默认尺寸 */
  width?: number;
  height?: number;
  /** 采样步数（CF 的 flux-schnell 建议 4） */
  steps?: number;
  /** 每天最多生成张数（本地计数，防超额度） */
  dailyMax?: number;
}

export const CLOUD_DEFAULTS: Record<CloudProviderId, {
  label: string;
  model: string;
  baseUrl?: string;
  dailyMax: number;
  /** 额度单位说明 */
  quotaUnit: string;
}> = {
  cloudflare: {
    label: 'Cloudflare Workers AI',
    model: '@cf/black-forest-labs/flux-1-schnell',
    dailyMax: 200,
    quotaUnit: '张',
  },
  modelscope: {
    label: 'ModelScope 魔搭',
    model: 'MusePublic/489_ckpt_FLUX_1',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    dailyMax: 100,
    quotaUnit: '张',
  },
  'openai-compatible': {
    label: 'OpenAI 兼容服务',
    model: 'Kwai-Kolors/Kolors',
    baseUrl: 'https://api.siliconflow.cn/v1',
    dailyMax: 100,
    quotaUnit: '张',
  },
};

export interface CloudDeps {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

function d(deps: CloudDeps) {
  return {
    fetch: deps.fetch || fetch,
    now: deps.now || (() => Date.now()),
    log: deps.log || (() => {}),
  };
}

// ─── 额度估算（Cloudflare Neurons） ─────────────────

/**
 * 估算 Cloudflare 一次生成的 Neurons 消耗。
 *
 * 官方定价（2026-10 文档）：
 *   4.80 neurons / 512×512 tile
 *   9.60 neurons / step
 *
 * 所以 512×512 4 步 ≈ 4.8 + 9.6×4 = 43.2 neurons
 * 1024×1024（4 tile）4 步 ≈ 19.2 + 38.4 = 57.6 neurons
 */
export function estimateNeurons(width: number, height: number, steps: number): number {
  const w = Math.max(1, Number(width) || 512);
  const h = Math.max(1, Number(height) || 512);
  const s = Math.max(1, Number(steps) || 4);
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return Math.round((tiles * 4.8 + s * 9.6) * 10) / 10;
}

/** 免费额度下每天能生成多少张 */
export const CLOUDFLARE_FREE_NEURONS = 10000;

export function freeImagesPerDay(width: number, height: number, steps: number): number {
  const per = estimateNeurons(width, height, steps);
  if (per <= 0) return 0;
  return Math.floor(CLOUDFLARE_FREE_NEURONS / per);
}

// ─── 本地额度计数 ───────────────────────────────────

export interface QuotaState {
  /** YYYY-MM-DD */
  day: string;
  /** 今日已用张数 */
  count: number;
  /** 累计 Neurons（仅 Cloudflare） */
  neurons: number;
}

export function emptyQuota(now: Date): QuotaState {
  return { day: dayKey(now), count: 0, neurons: 0 };
}

/** 跨天归零 */
export function rollQuota(q: QuotaState, now: Date): QuotaState {
  const dk = dayKey(now);
  if (q.day !== dk) return { day: dk, count: 0, neurons: 0 };
  return q;
}

export function checkCloudQuota(
  q: QuotaState,
  dailyMax: number,
): { ok: boolean; reason?: string; remaining: number } {
  const max = Math.max(1, Number(dailyMax) || 100);
  const remaining = Math.max(0, max - q.count);
  if (q.count >= max) {
    return { ok: false, reason: '今日云端生成已达上限 (' + q.count + '/' + max + ')', remaining: 0 };
  }
  return { ok: true, remaining };
}

// ─── 响应解析（三种格式都认）───────────────────────

export interface ParsedImage {
  ok: boolean;
  data?: Uint8Array;
  mime?: string;
  /** 需要二次下载的 URL */
  url?: string;
  error?: string;
}

/**
 * 判断字节是否像真实图片。
 *
 * 之前用「字符串长度 > 100」判断，太脆弱：
 * 小图可能不足 100 字符，而错误信息也可能很长。
 * 改成校验文件头更可靠。
 */
export function looksLikeImage(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < 12) return false;
  const b = bytes;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;
  // GIF: GIF8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  return false;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = String(b64 || '').replace(/^data:image\/[a-z]+;base64,/i, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/**
 * 从 JSON 响应里挖出图片。
 *
 * 见过的形状：
 *   { result: { image: "<base64>" } }            ← Cloudflare flux
 *   { data: [ { b64_json: "<base64>" } ] }       ← OpenAI 兼容
 *   { data: [ { url: "https://..." } ] }         ← OpenAI 兼容
 *   { images: ["<base64>"] }                     ← 少数实现
 *   { image: "<base64>" }                        ← 更简单的
 */
export function extractImageFromJson(j: any): ParsedImage {
  if (!j || typeof j !== 'object') return { ok: false, error: '响应不是对象' };

  // Cloudflare 风格
  const cf = j.result && (j.result.image || (j.result.images && j.result.images[0]));
  if (typeof cf === 'string' && cf.length > 20) {
    try {
      const bytes = base64ToBytes(cf);
      if (looksLikeImage(bytes)) {
        // 按魔数判 mime
        const mime = bytes[0] === 0x89 ? 'image/png'
          : bytes[0] === 0xff ? 'image/jpeg'
          : bytes[0] === 0x52 ? 'image/webp'
          : 'image/png';
        return { ok: true, data: bytes, mime };
      }
    } catch (e) { /* 落到后面 */ }
  }

  // OpenAI 兼容 data[]
  if (Array.isArray(j.data) && j.data.length) {
    const item = j.data[0];
    if (item && typeof item.b64_json === 'string') {
      try {
        const bytes = base64ToBytes(item.b64_json);
        if (looksLikeImage(bytes)) {
          const mime = bytes[0] === 0x89 ? 'image/png'
            : bytes[0] === 0xff ? 'image/jpeg'
            : bytes[0] === 0x52 ? 'image/webp'
            : 'image/png';
          return { ok: true, data: bytes, mime };
        }
      } catch (e) { /* 落到后面 */ }
    }
    if (item && typeof item.url === 'string' && item.url) {
      return { ok: true, url: item.url };
    }
  }

  // 顶层 images[]
  if (Array.isArray(j.images) && typeof j.images[0] === 'string') {
    try {
      const bytes = base64ToBytes(j.images[0]);
      if (looksLikeImage(bytes)) return { ok: true, data: bytes, mime: 'image/png' };
    } catch (e) { /* 落到后面 */ }
  }

  // 顶层 image 字符串
  if (typeof j.image === 'string' && j.image.length > 20) {
    try {
      const bytes = base64ToBytes(j.image);
      if (looksLikeImage(bytes)) {
        const mime = bytes[0] === 0x89 ? 'image/png'
          : bytes[0] === 0xff ? 'image/jpeg'
          : bytes[0] === 0x52 ? 'image/webp'
          : 'image/png';
        return { ok: true, data: bytes, mime };
      }
    } catch (e) { /* 落到后面 */ }
  }

  // 错误信息
  if (j.errors && Array.isArray(j.errors) && j.errors.length) {
    return { ok: false, error: '服务返回错误：' + JSON.stringify(j.errors[0]).slice(0, 150) };
  }
  if (j.error) {
    const msg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
    return { ok: false, error: String(msg).slice(0, 200) };
  }
  return { ok: false, error: '响应里找不到图片字段' };
}

// ─── Cloudflare 生成 ────────────────────────────────

export function buildCloudflareUrl(accountId: string, model: string): string {
  const acct = String(accountId || '').trim();
  const m = String(model || CLOUD_DEFAULTS.cloudflare.model).trim();
  return 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(acct) + '/ai/run/' + m;
}

export function buildCloudflareBody(req: ImageGenRequest, cfg: CloudConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: String(req.prompt || ''),
  };
  if (req.negative) body.negative_prompt = String(req.negative);
  const steps = Number(cfg.steps) || 4;
  body.steps = Math.max(1, Math.min(8, steps));   // CF flux-schnell 限 4-8 步
  if (typeof req.seed === 'number') body.seed = Math.trunc(req.seed);
  return body;
}

async function generateCloudflare(
  cfg: CloudConfig,
  req: ImageGenRequest,
  deps: CloudDeps,
): Promise<ImageGenResult> {
  const x = d(deps);
  if (!cfg.accountId || !cfg.apiKey) {
    return { ok: false, error: 'Cloudflare 需要 Account ID 和 API Token' };
  }

  const url = buildCloudflareUrl(cfg.accountId, cfg.model || CLOUD_DEFAULTS.cloudflare.model);
  const timeoutMs = Number(cfg.timeoutMs) || 120_000;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await x.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(buildCloudflareBody(req, cfg)),
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);

    if (!r.ok) {
      const txt = await (r as any).text().catch(() => '');
      return { ok: false, error: 'Cloudflare HTTP ' + r.status + '：' + String(txt).slice(0, 200) };
    }

    const ct = ((r.headers as any).get && (r.headers as any).get('content-type')) || '';
    // 二进制直接返回
    if (/^image\//i.test(ct)) {
      const buf = Buffer.from(await (r as any).arrayBuffer());
      if (!buf.length) return { ok: false, error: '返回空图片' };
      return { ok: true, data: new Uint8Array(buf), mime: ct.split(';')[0], provider: 'cloudflare' };
    }

    // JSON
    let j: any;
    try { j = await (r as any).json(); } catch (e) {
      return { ok: false, error: '响应不是 JSON 也不是图片' };
    }
    const parsed = extractImageFromJson(j);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.url) {
      // 二次下载
      const r2 = await x.fetch(parsed.url);
      if (!r2.ok) return { ok: false, error: '下载图片 HTTP ' + r2.status };
      const buf = Buffer.from(await (r2 as any).arrayBuffer());
      return { ok: true, data: new Uint8Array(buf), mime: 'image/png', provider: 'cloudflare' };
    }
    return { ok: true, data: parsed.data, mime: parsed.mime, provider: 'cloudflare' };
  } catch (e) {
    const msg = String(e);
    const hint = /abort/i.test(msg) ? '请求超时' : msg.slice(0, 150);
    return { ok: false, error: 'Cloudflare 请求失败：' + hint };
  }
}

// ─── OpenAI 兼容生成（ModelScope / 硅基流动 / 智谱）──

export function buildOpenAIUrl(baseUrl: string, path = '/images/generations'): string {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  return b + path;
}

export function buildOpenAIBody(req: ImageGenRequest, cfg: CloudConfig, provider: CloudProviderId): Record<string, unknown> {
  const w = Number(req.width) || Number(cfg.width) || 1024;
  const h = Number(req.height) || Number(cfg.height) || 1024;
  const body: Record<string, unknown> = {
    model: cfg.model || CLOUD_DEFAULTS[provider].model,
    prompt: String(req.prompt || ''),
    n: 1,
    size: w + 'x' + h,
    response_format: 'b64_json',
  };
  if (req.negative) body.negative_prompt = String(req.negative);
  if (typeof req.seed === 'number') body.seed = Math.trunc(req.seed);
  return body;
}

async function generateOpenAI(
  cfg: CloudConfig,
  req: ImageGenRequest,
  deps: CloudDeps,
  provider: CloudProviderId,
): Promise<ImageGenResult> {
  const x = d(deps);
  const baseUrl = cfg.baseUrl || CLOUD_DEFAULTS[provider].baseUrl;
  if (!baseUrl) return { ok: false, error: '未配置服务地址' };
  if (!cfg.apiKey) return { ok: false, error: '未配置 API Key' };

  const url = buildOpenAIUrl(baseUrl);
  const timeoutMs = Number(cfg.timeoutMs) || 180_000;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await x.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(buildOpenAIBody(req, cfg, provider)),
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);

    if (!r.ok) {
      const txt = await (r as any).text().catch(() => '');
      return { ok: false, error: CLOUD_DEFAULTS[provider].label + ' HTTP ' + r.status + '：' + String(txt).slice(0, 200) };
    }

    const ct = ((r.headers as any).get && (r.headers as any).get('content-type')) || '';
    if (/^image\//i.test(ct)) {
      const buf = Buffer.from(await (r as any).arrayBuffer());
      return { ok: true, data: new Uint8Array(buf), mime: ct.split(';')[0], provider };
    }

    let j: any;
    try { j = await (r as any).json(); } catch (e) {
      return { ok: false, error: '响应不是 JSON 也不是图片' };
    }
    const parsed = extractImageFromJson(j);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.url) {
      const r2 = await x.fetch(parsed.url);
      if (!r2.ok) return { ok: false, error: '下载图片 HTTP ' + r2.status };
      const buf = Buffer.from(await (r2 as any).arrayBuffer());
      return { ok: true, data: new Uint8Array(buf), mime: 'image/png', provider };
    }
    return { ok: true, data: parsed.data, mime: parsed.mime, provider };
  } catch (e) {
    const msg = String(e);
    const hint = /abort/i.test(msg) ? '请求超时' : msg.slice(0, 150);
    return { ok: false, error: CLOUD_DEFAULTS[provider].label + ' 请求失败：' + hint };
  }
}

// ─── 统一入口 ───────────────────────────────────────

export async function generateWithCloud(
  cfg: CloudConfig,
  req: ImageGenRequest,
  deps: CloudDeps = {},
): Promise<ImageGenResult> {
  if (cfg.provider === 'cloudflare') return generateCloudflare(cfg, req, deps);
  return generateOpenAI(cfg, req, deps, cfg.provider);
}

// ─── 连接测试 ───────────────────────────────────────

export interface CloudTestResult {
  ok: boolean;
  error?: string;
  /** 免费额度估算（张/天） */
  freePerDay?: number;
}

export async function testCloud(
  cfg: CloudConfig,
  deps: CloudDeps = {},
): Promise<CloudTestResult> {
  const x = d(deps);

  if (cfg.provider === 'cloudflare') {
    if (!cfg.accountId) return { ok: false, error: '缺少 Account ID' };
    if (!cfg.apiKey) return { ok: false, error: '缺少 API Token' };
    // CF 没有轻量 ping，用一次极小生成验证（64×64, 1 步，成本极低）
    const r = await generateCloudflare(cfg, { prompt: 'test', width: 64, height: 64 }, deps);
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      freePerDay: freeImagesPerDay(cfg.width || 1024, cfg.height || 1024, cfg.steps || 4),
    };
  }

  const baseUrl = cfg.baseUrl || CLOUD_DEFAULTS[cfg.provider].baseUrl;
  if (!baseUrl) return { ok: false, error: '缺少服务地址' };
  if (!cfg.apiKey) return { ok: false, error: '缺少 API Key' };

  // OpenAI 兼容：GET /models 探活
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    const r = await x.fetch(buildOpenAIUrl(baseUrl, '/models'), {
      headers: { Authorization: 'Bearer ' + cfg.apiKey },
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'API Key 无效（HTTP ' + r.status + '）' };
    // 有些服务不暴露 /models，非 401/403 就当作可用
    return { ok: true };
  } catch (e) {
    const msg = String(e);
    return { ok: false, error: /abort/i.test(msg) ? '连接超时' : msg.slice(0, 120) };
  }
}

// ─── Provider 适配 ──────────────────────────────────

export function createCloudProvider(
  cfg: CloudConfig,
  deps: CloudDeps = {},
): ImageProviderAdapter {
  const timeout = Number(cfg.timeoutMs) || 120_000;
  return {
    id: cfg.provider as any,
    label: CLOUD_DEFAULTS[cfg.provider].label,
    requiresConfig: true,
    requiresNetwork: true,
    requiresModel: false,
    timeoutMs: timeout + 10_000,
    async probe(): Promise<ProviderProbe> {
      if (cfg.provider === 'cloudflare') {
        if (!cfg.accountId) return { available: false, reason: '未配置 Account ID', missing: 'key' };
        if (!cfg.apiKey) return { available: false, reason: '未配置 API Token', missing: 'key' };
      } else {
        if (!cfg.apiKey) return { available: false, reason: '未配置 API Key', missing: 'key' };
      }
      return { available: true };
    },
    async generate(req) { return generateWithCloud(cfg, req, deps); },
  };
}