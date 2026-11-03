/*
 * SoulWeave S6.10：ComfyUI 外部对接
 *
 * 依据：S6 设计文档「ComfyUI 接口预留」，用户 Q1 要求「预留可接入 ComfyUI 的接口并引导配置安装」
 *
 * 【许可边界（重要）】
 * ComfyUI 是 GPL-3.0，**SoulWeave 不打包它**。
 * 我们只通过 HTTP 调用用户自己安装的 ComfyUI 实例，
 * 属于 FSF 定义的「聚合（aggregation）」，不构成衍生作品。
 * 这样 SoulWeave 保持 MIT。
 *
 * 【ComfyUI API 流程】
 *   1. GET  /system_stats           → 确认在线 + 拿版本
 *   2. POST /prompt   { prompt, client_id }  → { prompt_id }
 *   3. GET  /history/{prompt_id}    → 轮询直到有 outputs
 *   4. GET  /view?filename=...&type=output    → 下载图片字节
 *
 * 【工作流注入】
 * ComfyUI 的 prompt 是一个「节点图」，我们需要知道哪个节点的哪个字段放提示词。
 * 所以提供 nodeMap，由模板预置或用户自己指定。
 */

import type { ImageProviderAdapter, ProviderProbe } from './image-provider.js';
import type { ImageGenRequest, ImageGenResult } from './life-album.js';

// ─── 类型 ───────────────────────────────────────────

export interface ComfyUIWorkflow {
  /** 工作流 JSON（ComfyUI 的 prompt 格式：{ \"1\": { class_type, inputs } } */
  graph: Record<string, any>;
  /** 节点映射：哪个节点的哪个字段放什么 */
  nodeMap: ComfyUINodeMap;
}

export interface ComfyUINodeMap {
  /** 正向提示词：节点 id + 字段名 */
  positive: { nodeId: string; field: string };
  /** 负向提示词（可选） */
  negative?: { nodeId: string; field: string };
  /** 种子（可选） */
  seed?: { nodeId: string; field: string };
  /** 宽高（可选，通常同一个节点） */
  width?: { nodeId: string; field: string };
  height?: { nodeId: string; field: string };
  /** 步数（可选） */
  steps?: { nodeId: string; field: string };
  /** 模型文件名（可选；有则运行时按实际可用模型注入） */
  checkpoint?: { nodeId: string; field: string };
  /** 输出节点 id（从它的 outputs 里取文件名） */
  outputNodeId: string;
}

export interface ComfyUIConfig {
  /** 服务地址，如 http://127.0.0.1:8188 */
  endpoint: string;
  /** 工作流（内置模板 或 用户导入） */
  workflow?: ComfyUIWorkflow;
  /** 或者只给模板 id，运行时取内置模板 */
  templateId?: ComfyUITemplateId;
  /** 轮询超时（毫秒），默认 180 秒 */
  timeoutMs?: number;
  /** 轮询间隔（毫秒），默认 500 */
  pollIntervalMs?: number;
  /**
   * 指定 checkpoint 文件名。
   * 不填则运行时从 ComfyUI 的 /object_info 里自动挑一个最合适的。
   */
  checkpoint?: string;
}

export type ComfyUITemplateId = 't2i-sd15' | 't2i-sdxl' | 't2i-flux';

export interface ComfyUIDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 生成随机 client_id */
  clientId?: () => string;
  log?: (msg: string) => void;
}

function d(deps: ComfyUIDeps) {
  return {
    fetch: deps.fetch || fetch,
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    clientId: deps.clientId || (() => 'sw-' + Math.random().toString(36).slice(2, 10)),
    log: deps.log || (() => {}),
  };
}

// ─── URL 工具 ───────────────────────────────────────

/** 规范 endpoint：去掉末尾斜杠，校验协议 */
export function normalizeEndpoint(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // 只允许本机或局域网（ComfyUI 不该暴露公网）
  const base = u.origin;
  return base;
}

/**
 * 判断 endpoint 是否指向本机。
 *
 * 为什么关心：ComfyUI 默认只监听 127.0.0.1，
 * 如果用户填了公网地址，多半是错的或有安全风险。
 */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const h = u.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h);
  } catch (e) { return false; }
}

// ─── 内置模板 ───────────────────────────────────────

function sd15Template(): ComfyUIWorkflow {
  return {
    graph: {
      "3": { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler_ancestral',
        scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0],
        latent_image: ['5', 0] } },
      "4": { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' } },
      "5": { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      "6": { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      "7": { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      "8": { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      "9": { class_type: 'SaveImage', inputs: { filename_prefix: 'SoulWeave', images: ['8', 0] } },
    },
    nodeMap: {
      positive: { nodeId: '6', field: 'text' },
      negative: { nodeId: '7', field: 'text' },
      seed: { nodeId: '3', field: 'seed' },
      width: { nodeId: '5', field: 'width' },
      height: { nodeId: '5', field: 'height' },
      steps: { nodeId: '3', field: 'steps' },
      checkpoint: { nodeId: '4', field: 'ckpt_name' },
      outputNodeId: '9',
    },
  };
}

function sdxlTemplate(): ComfyUIWorkflow {
  const base = sd15Template();
  base.graph["4"].inputs.ckpt_name = 'sd_xl_base_1.0.safetensors';
  base.graph["5"].inputs.width = 1024;
  base.graph["5"].inputs.height = 1024;
  base.graph["3"].inputs.steps = 25;
  return base;
}

function fluxTemplate(): ComfyUIWorkflow {
  return {
    graph: {
      "1": { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-schnell.safetensors', weight_dtype: 'default' } },
      "2": { class_type: 'DualCLIPLoader', inputs: { clip_name1: 't5xxl_fp8_e4m3fn.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' } },
      "3": { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      "4": { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
      "5": { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
      "6": { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      "7": { class_type: 'KSampler', inputs: { seed: 0, steps: 4, cfg: 1, sampler_name: 'euler',
        scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0],
        latent_image: ['6', 0] } },
      "8": { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
      "9": { class_type: 'SaveImage', inputs: { filename_prefix: 'SoulWeave', images: ['8', 0] } },
    },
    nodeMap: {
      positive: { nodeId: '4', field: 'text' },
      negative: { nodeId: '5', field: 'text' },
      seed: { nodeId: '7', field: 'seed' },
      width: { nodeId: '6', field: 'width' },
      height: { nodeId: '6', field: 'height' },
      steps: { nodeId: '7', field: 'steps' },
      outputNodeId: '9',
    },
  };
}

export const COMFYUI_TEMPLATES: Record<ComfyUITemplateId, () => ComfyUIWorkflow> = {
  't2i-sd15': sd15Template,
  't2i-sdxl': sdxlTemplate,
  't2i-flux': fluxTemplate,
};

export const COMFYUI_TEMPLATE_LABELS: Record<ComfyUITemplateId, string> = {
  't2i-sd15': 'SD1.5 文生图',
  't2i-sdxl': 'SDXL 文生图',
  't2i-flux': 'FLUX 文生图',
};

// ─── 工作流注入 ─────────────────────────────────────

/**
 * 把请求参数注入工作流（纯函数，深拷贝，不改原图）。
 *
 * 关键：ComfyUI 的字段类型敏感（整数必须是整数，字符串必须是字符串），
 * 所以 seed/width/height/steps 要转成整数。
 */
export function injectWorkflow(
  wf: ComfyUIWorkflow,
  req: ImageGenRequest,
): Record<string, any> {
  const g = JSON.parse(JSON.stringify(wf.graph));
  const m = wf.nodeMap;

  const set = (target: { nodeId: string; field: string } | undefined, value: unknown) => {
    if (!target) return;
    const node = g[target.nodeId];
    if (!node || !node.inputs) return;
    node.inputs[target.field] = value;
  };

  set(m.positive, String(req.prompt || ''));
  if (req.negative) set(m.negative, String(req.negative));
  if (typeof req.seed === 'number') set(m.seed, Math.trunc(req.seed));
  if (typeof req.width === 'number') set(m.width, Math.trunc(req.width));
  if (typeof req.height === 'number') set(m.height, Math.trunc(req.height));

  return g;
}

// ─── 从 history 取输出文件 ──────────────────────────

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * 从 /history/{id} 的响应里提取输出文件。
 *
 * 格式（ComfyUI 0.x）：
 *   { [promptId]: { outputs: { [nodeId]: { images: [{filename, subfolder, type}] } }, status: {...} } }
 */
export function extractOutputs(
  history: any,
  promptId: string,
  outputNodeId: string,
): { ok: boolean; files: OutputFile[]; error?: string } {
  if (!history || typeof history !== 'object') {
    return { ok: false, files: [], error: 'history 为空' };
  }
  const entry = history[promptId];
  if (!entry) return { ok: false, files: [], error: 'history 中还没有该 prompt' };

  // 状态检查：ComfyUI 会在 status.completed === false 时还在跑
  if (entry.status && entry.status.completed === false && entry.status.status_str === 'error') {
    return { ok: false, files: [], error: 'ComfyUI 执行出错' };
  }

  const node = entry.outputs && entry.outputs[outputNodeId];
  if (!node) return { ok: false, files: [], error: '输出节点 ' + outputNodeId + ' 无结果' };

  const imgs = Array.isArray(node.images) ? node.images : [];
  if (!imgs.length) return { ok: false, files: [], error: '输出节点没有图片' };

  const files: OutputFile[] = imgs.map((x: any) => ({
    filename: String(x.filename || ''),
    subfolder: String(x.subfolder || ''),
    type: String(x.type || 'output'),
  })).filter((x: OutputFile) => x.filename);

  if (!files.length) return { ok: false, files: [], error: '输出文件名为空' };
  return { ok: true, files };
}

/** 构造 /view 的 URL */
export function buildViewUrl(endpoint: string, f: OutputFile): string {
  const q = new URLSearchParams({
    filename: f.filename,
    subfolder: f.subfolder,
    type: f.type,
  });
  return endpoint + '/view?' + q.toString();
}

// ─── 连接测试 ───────────────────────────────────────

export interface ComfyUITestResult {
  ok: boolean;
  /** ComfyUI 版本（能拿到时） */
  version?: string;
  /** 是否为局域网地址（安全提示用） */
  local?: boolean;
  error?: string;
}

export async function testComfyUI(
  endpoint: string,
  deps: ComfyUIDeps = {},
): Promise<ComfyUITestResult> {
  const x = d(deps);
  const base = normalizeEndpoint(endpoint);
  if (!base) return { ok: false, error: '地址格式不对（需要 http:// 或 https://）' };

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const r = await x.fetch(base + '/system_stats', { signal: ctl.signal } as any);
    clearTimeout(timer);

    if (!r.ok) {
      return { ok: false, local: isLocalEndpoint(base), error: 'HTTP ' + r.status };
    }
    let j: any = null;
    try { j = await (r as any).json(); } catch (e) { void e; }

    const version = j && j.system && (j.system.comfyui_version || j.system.os)
      ? String(j.system.comfyui_version || '')
      : undefined;

    return { ok: true, version: version || undefined, local: isLocalEndpoint(base) };
  } catch (e) {
    const msg = String(e);
    const hint = /abort/i.test(msg) ? '连接超时（ComfyUI 没启动？）' : msg.slice(0, 120);
    return { ok: false, local: isLocalEndpoint(base), error: hint };
  }
}

// ─── Checkpoint 动态解析 ─────────────────────────────

/**
 * 列出 ComfyUI 里实际可用的 checkpoint。
 *
 * 为什么需要：模板里写死文件名的话，用户装的模型名不一样就直接 400。
 * 真机验证时踩过：模板写 'v1-5-pruned-emaonly.safetensors'，
 * 实际是 'sd15-pruned-emaonly.safetensors' → value_not_in_list。
 *
 * 所以运行时向 ComfyUI 要真实列表，再挑一个。
 */
export async function listCheckpoints(
  endpoint: string,
  deps: ComfyUIDeps = {},
): Promise<{ ok: boolean; checkpoints: string[]; error?: string }> {
  const x = d(deps);
  const base = normalizeEndpoint(endpoint);
  if (!base) return { ok: false, checkpoints: [], error: '地址格式不对' };

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    const r = await x.fetch(base + '/object_info', { signal: ctl.signal } as any);
    clearTimeout(timer);
    if (!r.ok) return { ok: false, checkpoints: [], error: 'HTTP ' + r.status };
    const j: any = await (r as any).json();
    const node = j && j.CheckpointLoaderSimple;
    const spec = node && node.input && node.input.required && node.input.required.ckpt_name;
    const list = spec && Array.isArray(spec[0]) ? spec[0] : [];
    const names = list.filter((s: any) => typeof s === 'string');
    return { ok: true, checkpoints: names };
  } catch (e) {
    const msg = String(e);
    return { ok: false, checkpoints: [], error: /abort/i.test(msg) ? '读取超时' : msg.slice(0, 120) };
  }
}

/**
 * 从可用列表里挑一个最合适的。
 *
 * 优先级：
 *   1. 名字里含 sd15 / sd-1.5 / v1-5 的（SD1.5，体积小、速度快）
 *   2. 名字里含 sd_xl / sdxl 的（画质更好但显存要求高）
 *   3. 都没有就取第一个
 *
 * 另外尊重用户显式指定的 prefer（哪怕它不在列表里，也原样返回让上层报错）。
 */
export function pickCheckpoint(list: string[], prefer?: string): string | null {
  if (prefer) return prefer;
  if (!list.length) return null;
  const sd15 = list.find((n) => /sd[-_ ]?1[._-]?5|v1[-_]5|sd15/i.test(n));
  if (sd15) return sd15;
  const any = list.find((n) => /\.(safetensors|ckpt|gguf)$/i.test(n));
  return any || list[0];
}

/**
 * 解析 ComfyUI 的 400 错误，给用户看得懂的话。
 *
 * 真实响应（0.43.0 实测）：
 *   { error: { type: 'prompt_outputs_failed_validation', message: '...' },
 *     node_errors: { "4": { errors: [ { type: 'value_not_in_list',
 *       details: "ckpt_name: 'a' not in ['b']" } ], class_type: 'CheckpointLoaderSimple' } } }
 */
export function explainPromptError(body: any): string {
  try {
    const ne = body && body.node_errors;
    if (ne && typeof ne === 'object') {
      const parts: string[] = [];
      for (const [nodeId, info] of Object.entries<any>(ne)) {
        const errs = (info && info.errors) || [];
        for (const e of errs) {
          const t = String((e && e.type) || '');
          const d = String((e && e.details) || (e && e.message) || '');
          if (t === 'value_not_in_list') {
            // 典型：模型名不匹配
            const mm = /^([a-zA-Z0-9_]+):\s*'([^']*)'\s*not in\s*\[(.*)\]/.exec(d);
            if (mm) {
              const field = mm[1];
              const got = mm[2];
              const avail = mm[3].replace(/'/g, '').split(',').map((s: string) => s.trim()).filter(Boolean);
              parts.push(
                '节点 ' + nodeId + ' 的 ' + field + ' 「' + got + '」不存在。可用：' +
                (avail.length ? avail.slice(0, 5).join('、') : '（空）')
              );
              continue;
            }
          }
          if (t === 'required_input_missing') {
            parts.push('节点 ' + nodeId + ' 缺少必填输入：' + d);
            continue;
          }
          parts.push('节点 ' + nodeId + '：' + (d || t || '未知错误'));
        }
      }
      if (parts.length) return parts.join('；');
    }
    const e2 = body && body.error;
    if (e2) {
      if (typeof e2 === 'string') return e2;
      if (e2.message) return String(e2.message);
    }
  } catch (e) { void e; }
  return '';
}

// ─── 生成 ───────────────────────────────────────────

export async function generateWithComfyUI(
  cfg: ComfyUIConfig,
  req: ImageGenRequest,
  deps: ComfyUIDeps = {},
): Promise<ImageGenResult> {
  const x = d(deps);
  const base = normalizeEndpoint(cfg.endpoint);
  if (!base) return { ok: false, error: 'ComfyUI 地址无效' };

  // 取工作流：显式给的 > 模板 > 默认 sd15
  let wf: ComfyUIWorkflow | undefined = cfg.workflow;
  if (!wf) {
    const id = cfg.templateId || 't2i-sd15';
    const make = COMFYUI_TEMPLATES[id];
    if (make) wf = make();
  }
  if (!wf) return { ok: false, error: '没有可用的工作流模板' };

  const timeoutMs = Number(cfg.timeoutMs) || 180_000;
  const pollMs = Number(cfg.pollIntervalMs) || 500;
  const startedAt = x.now();
  const clientId = x.clientId();

  // 1. 注入参数
  const graph = injectWorkflow(wf, req);

  // 1.5 解析 checkpoint
  // 模板里写死的模型名很可能和用户实际装的不一致（真机踩过），
  // 所以运行时向 ComfyUI 要真实列表再挑一个。
  if (wf.nodeMap.checkpoint) {
    let cp = cfg.checkpoint || '';
    if (!cp) {
      const listed = await listCheckpoints(base, deps);
      if (!listed.ok) {
        return { ok: false, error: '读取可用模型失败：' + (listed.error || '未知') };
      }
      if (!listed.checkpoints.length) {
        return {
          ok: false,
          error: 'ComfyUI 里没有可用的模型。请把 .safetensors 放进 ComfyUI/models/checkpoints',
        };
      }
      cp = pickCheckpoint(listed.checkpoints) || '';
    }
    const node = graph[wf.nodeMap.checkpoint.nodeId];
    if (node && node.inputs) node.inputs[wf.nodeMap.checkpoint.field] = cp;
    x.log('ComfyUI 使用模型：' + cp);
  }

  // 2. 提交
  let promptId = '';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    const r = await x.fetch(base + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      signal: ctl.signal,
    } as any);
    clearTimeout(timer);
    if (!r.ok) {
      const txt = await (r as any).text().catch(() => '');
      let body: any = null;
      try { body = JSON.parse(String(txt)); } catch (e) { void e; }
      const explained = explainPromptError(body);
      return {
        ok: false,
        error: 'ComfyUI 拒绝了这个工作流（HTTP ' + r.status + '）：' +
          (explained || String(txt).slice(0, 200)),
      };
    }
    const j: any = await (r as any).json();
    promptId = String(j && j.prompt_id || '');
    if (!promptId) return { ok: false, error: 'ComfyUI 未返回 prompt_id' };
    x.log('ComfyUI prompt_id=' + promptId);
  } catch (e) {
    return { ok: false, error: '提交失败：' + String(e).slice(0, 150) };
  }

  // 3. 轮询 history
  let files: OutputFile[] = [];
  let lastErr = '';
  while (x.now() - startedAt < timeoutMs) {
    await x.sleep(pollMs);
    try {
      const r = await x.fetch(base + '/history/' + encodeURIComponent(promptId));
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      const j: any = await (r as any).json();
      const got = extractOutputs(j, promptId, wf.nodeMap.outputNodeId);
      if (got.ok) { files = got.files; break; }
      lastErr = got.error || '';
      // 明确出错就直接返回，别等到超时
      if (got.error && /执行出错/.test(got.error)) {
        return { ok: false, error: got.error };
      }
    } catch (e) {
      lastErr = String(e).slice(0, 120);
    }
  }

  if (!files.length) {
    return { ok: false, error: '生成超时或失败：' + (lastErr || '未拿到输出') };
  }

  // 4. 下载第一张
  try {
    const url = buildViewUrl(base, files[0]);
    const r = await x.fetch(url);
    if (!r.ok) return { ok: false, error: '下载图片失败 HTTP ' + r.status };
    const buf = Buffer.from(await (r as any).arrayBuffer());
    if (!buf.length) return { ok: false, error: '下载到空文件' };

    const ct = (r.headers && (r.headers as any).get && (r.headers as any).get('content-type')) || '';
    const mime = /png/i.test(ct) ? 'image/png'
      : /jpeg|jpg/i.test(ct) ? 'image/jpeg'
      : /webp/i.test(ct) ? 'image/webp'
      : 'image/png';

    return { ok: true, data: new Uint8Array(buf), mime, provider: 'comfyui' };
  } catch (e) {
    return { ok: false, error: '下载失败：' + String(e).slice(0, 150) };
  }
}

// ─── Provider 适配 ──────────────────────────────────

export function createComfyUIProvider(cfg: ComfyUIConfig, deps: ComfyUIDeps = {}): ImageProviderAdapter {
  const timeout = Number(cfg.timeoutMs) || 180_000;
  return {
    id: 'comfyui',
    label: '外部 ComfyUI',
    requiresConfig: true,      // 用户必须填地址
    requiresNetwork: true,     // 即使是本机也是 HTTP
    requiresModel: false,      // 模型在 ComfyUI 那边
    timeoutMs: timeout + 10_000,
    async probe(): Promise<ProviderProbe> {
      if (!cfg.endpoint) return { available: false, reason: '未配置 ComfyUI 地址', missing: 'endpoint' };
      const r = await testComfyUI(cfg.endpoint, deps);
      if (!r.ok) return { available: false, reason: r.error || '连接失败', missing: 'endpoint' };
      return { available: true };
    },
    async generate(req) { return generateWithComfyUI(cfg, req, deps); },
  };
}

// ─── 引导信息（给 UI 用） ──────────────────────────

export interface ComfyUIGuide {
  title: string;
  /** 说明（内部含 GPL 提示，UI 可选择性显示） */
  note: string;
  steps: string[];
  /** 下载页 */
  downloadUrl: string;
  /** 文档页 */
  docsUrl: string;
  /** 默认地址 */
  defaultEndpoint: string;
}

export const COMFYUI_GUIDE: ComfyUIGuide = {
  title: '外部 ComfyUI（高级）',
  note: 'ComfyUI 是第三方开源工具，SoulWeave 不打包它，但支持对接。',
  steps: [
    '1. 下载 ComfyUI 便携版（约 1.5 GB）',
    '2. 解压到任意目录',
    '3. 双击 run_nvidia_gpu.bat 启动',
    '4. 启动后默认地址 http://127.0.0.1:8188',
    '5. 在下方填地址，点「测试连接」',
  ],
  downloadUrl: 'https://github.com/comfyanonymous/ComfyUI/releases',
  docsUrl: 'https://docs.comfy.org/',
  defaultEndpoint: 'http://127.0.0.1:8188',
};