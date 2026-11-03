/*
 * SoulWeave S7：OpenAI 兼容视觉（图片理解）
 *
 * 依据：01 需求 §7.9「图片识别…内置测试图片理解」
 *
 * 【为什么只做 OpenAI 兼容】
 * 国内主流多模态（通义 / 智谱 / 硅基流动 / 豆包）都兼容 /chat/completions 的
 * image_url 形式；而每家自己的原生协议又各不相同。
 * 做一个兼容层，等于一次接上十家，维护面最小。
 *
 * 【错误必须能翻译成人话】
 * 视觉失败的原因和文本完全不同：
 *   · 模型存在但不支持图片 → 400 + 一句含糊的 message
 *   · 图片太大 → 413 或 400
 *   · 图片格式不认 → 400
 * 如果只把 status code 丢给用户，他会以为是网络问题，反复重试。
 */

import {
  detectImageFormat, mimeForFormat, toDataUri, readDimensions,
  validateVisionRequest, buildVisionPrompt,
  VISION_TIMEOUT_MS, MAX_IMAGE_BYTES, MAX_IMAGES_PER_REQUEST,
  type VisionRequest, type VisionResult, type VisionErrorCode, type VisionImage,
} from './vision-types.js';

// ─── 配置 ───────────────────────────────────────────

export interface VisionConfig {
  /** OpenAI 兼容 base URL，如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  apiKey: string;
  /** 支持图片输入的模型，如 qwen-vl-plus / glm-4v / gpt-4o-mini */
  model: string;
  timeoutMs?: number;
  /** 单次最多几张（服务商差异，默认 4） */
  maxImages?: number;
}

export interface VisionDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: VISION_TIMEOUT_MS,
  maxImages: MAX_IMAGES_PER_REQUEST,
};

// ─── 错误翻译 ───────────────────────────────────────

/**
 * 把 HTTP 状态码 + 响应体翻成「用户能照着做」的结论。
 *
 * 返回 code 供上层决定是否降级；error 给人看。
 */
export function explainVisionError(status: number, body: any): { code: VisionErrorCode; error: string } {
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  const msg = String((body && (body.error?.message || body.message || body.msg)) || raw || '').slice(0, 300);

  if (status === 401 || status === 403) {
    return { code: 'NO_CONFIG', error: 'API Key 无效或无权限（HTTP ' + status + '）：' + msg };
  }
  if (status === 404) {
    return { code: 'NOT_SUPPORTED', error: '模型或接口不存在（HTTP 404）：' + msg };
  }
  if (status === 413) {
    return { code: 'IMAGE_TOO_BIG', error: '图片太大被拒（HTTP 413）：' + msg };
  }
  if (status === 429) {
    return { code: 'QUOTA', error: '额度或频率超限（HTTP 429）：' + msg };
  }
  if (status === 408 || status === 504) {
    return { code: 'TIMEOUT', error: '服务端超时（HTTP ' + status + '）：' + msg };
  }

  // 400 的花样最多：模型不支持图片、格式不认、内容审核
  if (status === 400) {
    // 体积判定必须排在「提到 image」之前：
    // "image too large" 同时命中两条，先判体积才不会给出「模型不支持图片」的误导。
    if (/too large|过大|size limit|exceeds/i.test(msg)) {
      return { code: 'IMAGE_TOO_BIG', error: '图片体积超限：' + msg };
    }
    if (/image|图片|vision|multimodal|多模态/i.test(msg)) {
      return { code: 'NOT_SUPPORTED', error: '这个模型不接受图片输入，或图片格式不被支持：' + msg };
    }
    return { code: 'NETWORK', error: '请求被拒绝（HTTP 400）：' + msg };
  }

  return { code: 'NETWORK', error: 'HTTP ' + status + '：' + msg };
}

// ─── 请求构造（纯函数，便于测试） ───────────────────

export interface VisionMessagePart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

/** 组装 OpenAI 兼容的 content 数组：先文字，后图片 */
export function buildVisionContent(req: VisionRequest): VisionMessagePart[] {
  const parts: VisionMessagePart[] = [];
  parts.push({ type: 'text', text: buildVisionPrompt(req.prompt) });
  for (const img of req.images || []) {
    const fmt = img.format && img.format !== 'unknown' ? img.format : detectImageFormat(img.data);
    parts.push({ type: 'image_url', image_url: { url: toDataUri(img.data, fmt) } });
  }
  return parts;
}

/** 组装完整请求体 */
export function buildVisionPayload(req: VisionRequest, cfg: VisionConfig): Record<string, unknown> {
  return {
    model: cfg.model,
    messages: [{ role: 'user', content: buildVisionContent(req) }],
    max_tokens: 800,
    temperature: 0.2,   // 描述图片不需要发散
  };
}

// ─── 响应解析（纯函数） ─────────────────────────────

/**
 * 从响应里取出文字。
 *
 * 兼容三种真实形态：
 *   1. content 是字符串（最常见）
 *   2. content 是 [{type:'text',text:'...'}] 数组（新版 OpenAI）
 *   3. 服务商把结果放在 data.content
 */
export function extractVisionText(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const msg = choice && (choice.message || choice.delta);
  let c = msg ? msg.content : (body.data && body.data.content);
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((p: any) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * 从文字里抽出标签。
 *
 * 只在模型**主动**给出 JSON 数组或「标签：a、b、c」时抽取，
 * 抽不到就返回空数组 —— 绝不猜测。
 */
export function extractTags(text: string): string[] {
  const t = String(text || '');
  if (!t) return [];

  // 形态 1：[“猫”, “窗台”]
  const arr = t.match(/\[\s*["'“][^\]]{2,400}\]/);
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0].replace(/[“”]/g, '"').replace(/'/g, '"'));
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
      }
    } catch (e) { /* 落到形态 2 */ }
  }

  // 形态 2：标签：猫、窗台、阳光
  const m = t.match(/(?:标签|关键词|tags?)\s*[:：]\s*([^\n]{2,200})/i);
  if (m) {
    return m[1].split(/[、,，;；\/]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
  }

  return [];
}

// ─── 调用 ───────────────────────────────────────────

/** 把裸字节包装成 VisionImage（自动探测格式与尺寸） */
export function toVisionImage(data: Uint8Array): VisionImage {
  const fmt = detectImageFormat(data);
  const dim = readDimensions(data, fmt);
  return {
    data,
    format: fmt,
    mime: mimeForFormat(fmt),
    bytes: data.length,
    width: dim ? dim.width : undefined,
    height: dim ? dim.height : undefined,
  };
}

export function buildVisionUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
}

/**
 * 识别一组图片。
 *
 * 永远不抛异常：任何失败都变成 { ok:false, code, error }。
 * 上层据此决定是提示用户改配置，还是换个模型再试。
 */
export async function describeImages(
  cfg: VisionConfig,
  req: VisionRequest,
  deps: VisionDeps = {},
): Promise<VisionResult> {
  const f = deps.fetch || fetch;
  const now = deps.now || (() => Date.now());

  if (!cfg.baseUrl) return { ok: false, code: 'NO_CONFIG', error: '缺少服务地址' };
  if (!cfg.apiKey) return { ok: false, code: 'NO_CONFIG', error: '缺少 API Key' };
  if (!cfg.model) return { ok: false, code: 'NO_CONFIG', error: '缺少模型名' };

  const v = validateVisionRequest(req, {
    maxBytes: MAX_IMAGE_BYTES,
    maxImages: cfg.maxImages || MAX_IMAGES_PER_REQUEST,
  });
  if (!v.ok) return { ok: false, code: v.code, error: v.error };

  const url = buildVisionUrl(cfg.baseUrl);
  const timeout = cfg.timeoutMs || VISION_TIMEOUT_MS;
  const t0 = now();

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const r = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(buildVisionPayload(req, cfg)),
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);

    const ms = now() - t0;
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }

    if (!r.ok) {
      const e = explainVisionError(r.status, body);
      return { ok: false, code: e.code, error: e.error, ms, model: cfg.model };
    }

    const out = extractVisionText(body);
    if (!out) {
      return {
        ok: false, code: 'NOT_SUPPORTED',
        error: '模型返回了空内容，可能是这个模型不支持图片输入',
        ms, model: cfg.model,
      };
    }
    return { ok: true, text: out, tags: extractTags(out), model: cfg.model, ms };
  } catch (e: any) {
    const ms = now() - t0;
    const msg = String(e && e.message ? e.message : e);
    if (/abort/i.test(msg)) {
      return { ok: false, code: 'TIMEOUT', error: '请求超时（' + Math.round(timeout / 1000) + ' 秒）', ms };
    }
    const code = String((e && e.cause && e.cause.code) || (e && e.code) || '');
    const detail = msg + ' ' + code;
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) {
      return { ok: false, code: 'NETWORK', error: '域名解析失败，检查网络或 DNS', ms };
    }
    if (/ECONNREFUSED/i.test(detail)) {
      return { ok: false, code: 'NETWORK', error: '连接被拒绝，地址或端口不对', ms };
    }
    if (/CERT|SSL|TLS/i.test(detail)) {
      return { ok: false, code: 'NETWORK', error: '证书校验失败，可能是代理或防火墙', ms };
    }
    return { ok: false, code: 'NETWORK', error: msg.slice(0, 200), ms };
  }
}

/** 连通性测试：用一张 1×1 PNG 打一次，验证 key 与模型真的能吃图 */
export async function testVision(
  cfg: VisionConfig,
  deps: VisionDeps = {},
): Promise<VisionResult> {
  // 1×1 透明 PNG（67 字节）
  const tiny = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  return describeImages(cfg, {
    images: [toVisionImage(tiny)],
    prompt: '这张图是什么颜色？只回答一个词。',
    sourceKind: 'user_upload',
  }, deps);
}
