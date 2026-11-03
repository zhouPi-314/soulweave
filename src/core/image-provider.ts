/*
 * SoulWeave S6：图片生成 Provider 抽象 + 降级链
 *
 * 依据：规划第 92 行「按需资源下载、依赖发现、授权提示、故障恢复」
 *      规划第 110 行「缺失资源有降级；失败不破坏现有程序/数据」
 *
 * 【核心保证】
 * resolve() 永远返回结果，永远不会抛异常。
 * 最坏情况返回占位图，日记不会因为图片失败而保存失败。
 *
 * 【降级链】
 *   priority 数组依次尝试
 *   · 不可用（未配置/缺模型/离线）→ 跳过
 *   · 可用但失败 → 记录，继续下一个
 *   · 超时 → 记录，继续下一个
 *   · 熔断中 → 跳过
 *   最后兜底 placeholder（自动追加）
 */

import {
  makePlaceholderSvg,
  type ImageGenRequest, type ImageGenResult,
} from './life-album.js';

// ─── 类型 ───────────────────────────────────────────

export type ImageProviderId =
  | 'bundled'            // 内置素材包
  | 'sdcpp'              // 本地 stable-diffusion.cpp
  | 'cloudflare'         // Cloudflare Workers AI
  | 'modelscope'         // ModelScope 魔搭
  | 'openai-compatible'  // 硅基流动 / 智谱等
  | 'comfyui'            // 外部 ComfyUI
  | 'placeholder';       // 占位图（兜底）

export type ImageSourceMode =
  | 'bundled-only'
  | 'bundled-then-local'
  | 'local-only'
  | 'cloud-first'
  | 'comfyui-first'
  | 'custom';

export interface ProviderProbe {
  available: boolean;
  reason?: string;
  missing?: 'key' | 'model' | 'endpoint' | 'network' | 'device' | 'config';
  quota?: { daily?: number; used?: number; unit: string };
}

export interface ImageProviderAdapter {
  id: ImageProviderId;
  label: string;
  /** 需要用户配置（key / 地址） */
  requiresConfig: boolean;
  /** 需要联网 */
  requiresNetwork: boolean;
  /** 需要本地模型文件 */
  requiresModel: boolean;
  /** 单次生成建议超时（毫秒） */
  timeoutMs?: number;
  probe(): Promise<ProviderProbe>;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

export interface AttemptRecord {
  id: ImageProviderId;
  ok: boolean;
  /** 生成失败原因 */
  error?: string;
  /** 跳过的原因（不可用/熔断） */
  skipped?: string;
  /** 错误码（可能为空） */
  code?: string;
  /** 耗时（毫秒） */
  ms?: number;
}

/**
 * 这些错误码代表「必须让用户决定」，不应该静默降级。
 *
 * 为什么：核显崩溃时如果自动换成素材包，用户看到的只是一张不符合预期的图，
 * 完全不知道本地 SD 其实没在工作，也没机会去修。所以停下来告诉用户。
 */
export const BLOCKING_CODES: ReadonlySet<string> = new Set(['IGPU_ONLY']);

export interface ResolveResult extends ImageGenResult {
  /** 实际成功的 provider */
  used?: ImageProviderId;
  /** 尝试过程（排障用） */
  attempts: AttemptRecord[];
  /**
   * 是否被阻断（需要用户干预，而不是「都试过了」）。
   * true 时 attempts 里最后一条就是阻断原因。
   */
  blocked?: boolean;
}

export interface ResolveOptions {
  priority: ImageProviderId[];
  /** 每 provider 默认超时（毫秒），可被 adapter.timeoutMs 覆盖 */
  defaultTimeoutMs?: number;
  /** 连续失败几次后熔断，默认 3 */
  circuitThreshold?: number;
  /** 熔断持续时长（毫秒），默认 5 分钟 */
  circuitCooldownMs?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
}

// ─── 模式 → 优先级 ──────────────────────────────────

/**
 * 把「图片来源」模式翻译成 provider 优先级。
 *
 * 默认 bundled-then-local：先选图（瞬时零显存），本地 SD 作为增强。
 * 注意：placeholder 不需要写在返回值里，resolver 会自动追加。
 */
export function priorityForMode(mode: ImageSourceMode): ImageProviderId[] {
  switch (mode) {
    case 'bundled-only':       return ['bundled'];
    case 'bundled-then-local': return ['bundled', 'sdcpp'];
    case 'local-only':         return ['sdcpp'];
    case 'cloud-first':        return ['cloudflare', 'modelscope', 'sdcpp', 'bundled'];
    // 外部 ComfyUI 优先：没配或连不上时退回本地 SD / 素材包
    case 'comfyui-first':      return ['comfyui', 'sdcpp', 'bundled'];
    // 自定义：目前没有排序 UI，给一个「全都试一遍」的合理顺序
    case 'custom':             return ['cloudflare', 'modelscope', 'comfyui', 'sdcpp', 'bundled'];
    default:                   return ['bundled', 'sdcpp'];
  }
}

// ─── 简单超时包装 ───────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(label + ' 超时（' + ms + 'ms）'));
    }, ms);
    p.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ─── 熔断器 ─────────────────────────────────────────

interface CircuitState {
  failures: number;
  openUntil: number;
}

// ─── Resolver ───────────────────────────────────────

export class ImageResolver {
  private adapters = new Map<ImageProviderId, ImageProviderAdapter>();
  private circuits = new Map<ImageProviderId, CircuitState>();

  constructor(adapters: ImageProviderAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(a: ImageProviderAdapter): void {
    this.adapters.set(a.id, a);
  }

  has(id: ImageProviderId): boolean {
    return this.adapters.has(id);
  }

  /** 当前熔断状态（排障用） */
  circuitOf(id: ImageProviderId): { open: boolean; failures: number; openUntil: number } {
    const c = this.circuits.get(id) || { failures: 0, openUntil: 0 };
    return { open: c.openUntil > 0, failures: c.failures, openUntil: c.openUntil };
  }

  /** 手动重置熔断（用户在设置里点「重试」时） */
  resetCircuit(id?: ImageProviderId): void {
    if (id) this.circuits.delete(id);
    else this.circuits.clear();
  }

  /**
   * 按优先级依次尝试，**永不抛异常**。
   *
   * 保证：至少尝试 placeholder，返回的 result 一定有 data 或 error。
   */
  async resolve(req: ImageGenRequest, opts: ResolveOptions): Promise<ResolveResult> {
    const now = opts.now || (() => Date.now());
    const defaultTimeout = opts.defaultTimeoutMs ?? 60_000;
    const threshold = opts.circuitThreshold ?? 3;
    const cooldown = opts.circuitCooldownMs ?? 5 * 60_000;

    // 自动追加 placeholder 兜底
    const order = opts.priority.slice();
    if (!order.includes('placeholder')) order.push('placeholder');

    const attempts: AttemptRecord[] = [];

    for (const id of order) {
      const adapter = this.adapters.get(id);
      if (!adapter) {
        attempts.push({ id, ok: false, skipped: '未注册该 provider' });
        continue;
      }

      // 熔断检查
      const circuit = this.circuits.get(id);
      const t = now();
      if (circuit && circuit.openUntil > t) {
        attempts.push({ id, ok: false, skipped: '熔断中（' + Math.ceil((circuit.openUntil - t) / 1000) + ' 秒后重试）' });
        continue;
      }
      // 熔断已到期，清零
      if (circuit && circuit.openUntil > 0 && circuit.openUntil <= t) {
        circuit.failures = 0;
        circuit.openUntil = 0;
      }

      // 可用性探测
      let probe: ProviderProbe;
      try {
        probe = await withTimeout(adapter.probe(), Math.min(defaultTimeout, 10_000), id + '.probe');
      } catch (e) {
        attempts.push({ id, ok: false, skipped: '探测失败：' + String(e).slice(0, 100) });
        continue;
      }
      if (!probe || !probe.available) {
        attempts.push({ id, ok: false, skipped: probe?.reason || '不可用' });
        continue;
      }

      // 实际生成
      const t0 = now();
      const timeout = adapter.timeoutMs || defaultTimeout;
      try {
        const r = await withTimeout(adapter.generate(req), timeout, id + '.generate');
        const ms = now() - t0;
        if (r && r.ok && (r.data || r.mime)) {
          attempts.push({ id, ok: true, ms });
          this.recordSuccess(id);
          return { ...r, used: id, attempts };
        }
        const err = (r && r.error) || '返回空结果';
        const code = r && r.code;
        attempts.push({ id, ok: false, error: err, ms, code });
        this.recordFailure(id, threshold, cooldown, now());
        // 阻断类错误：不再降级，把决定权交给用户
        if (code && BLOCKING_CODES.has(code)) {
          return { ok: false, error: err, code, blocked: true, used: undefined, attempts };
        }
      } catch (e) {
        const ms = now() - t0;
        attempts.push({ id, ok: false, error: String(e).slice(0, 150), ms });
        this.recordFailure(id, threshold, cooldown, now());
      }
    }

    // 理论上到不了这里（placeholder 总会成功），但保险
    return {
      ok: false,
      error: '所有图片 provider 都失败',
      attempts,
    };
  }

  private recordSuccess(id: ImageProviderId): void {
    this.circuits.delete(id);
  }

  private recordFailure(id: ImageProviderId, threshold: number, cooldown: number, now: number): void {
    // placeholder 不参与熔断（它是兜底，必须永远可用）
    if (id === 'placeholder') return;
    const c = this.circuits.get(id) || { failures: 0, openUntil: 0 };
    c.failures += 1;
    if (c.failures >= threshold) {
      c.openUntil = now + cooldown;
    }
    this.circuits.set(id, c);
  }
}

// ─── 内置：占位图 provider ──────────────────────────

/**
 * 占位图 provider —— 永远可用，永远不会失败。
 *
 * 它保证 resolve() 一定有结果，是整条降级链的地基。
 */
export function createPlaceholderProvider(opts?: {
  width?: number;
  height?: number;
  text?: string;
}): ImageProviderAdapter {
  return {
    id: 'placeholder',
    label: '占位图',
    requiresConfig: false,
    requiresNetwork: false,
    requiresModel: false,
    timeoutMs: 5_000,
    async probe() { return { available: true }; },
    async generate(req) {
      try {
        const svg = makePlaceholderSvg({
          width: req.width || opts?.width || 768,
          height: req.height || opts?.height || 768,
          text: opts?.text || '图片生成暂不可用',
        });
        return {
          ok: true,
          data: new TextEncoder().encode(svg),
          mime: 'image/svg+xml',
          provider: 'placeholder',
        };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 120) };
      }
    },
  };
}

// ─── 内置：素材包 provider 外壳 ─────────────────────

export interface BundledCandidate {
  id: string;
  /** 读取图片字节 */
  read(): Promise<Uint8Array | null>;
  mime?: string;
}

/**
 * 素材包 provider 外壳。
 *
 * 选图算法在 S6.8（image-bundled.ts）实现，这里只负责适配成 Provider。
 * 通过注入 `pick` 回调解耦，便于测试。
 */
export function createBundledProvider(opts: {
  /** 是否已装载素材包 */
  ready: () => boolean | Promise<boolean>;
  /** 选一张图（S6.8 实现） */
  pick: (req: ImageGenRequest) => Promise<BundledCandidate | null>;
}): ImageProviderAdapter {
  return {
    id: 'bundled',
    label: '内置素材包',
    requiresConfig: false,
    requiresNetwork: false,
    requiresModel: false,
    timeoutMs: 10_000,
    async probe() {
      try {
        const ok = await opts.ready();
        return ok
          ? { available: true }
          : { available: false, reason: '素材包未装载', missing: 'model' as const };
      } catch (e) {
        return { available: false, reason: '素材包检测失败：' + String(e).slice(0, 80) };
      }
    },
    async generate(req) {
      try {
        const c = await opts.pick(req);
        if (!c) return { ok: false, error: '没有可用的素材' };
        const data = await c.read();
        if (!data || !data.length) return { ok: false, error: '素材读取失败' };
        return { ok: true, data, mime: c.mime || 'image/webp', provider: 'bundled' };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 150) };
      }
    },
  };
}
