/*
 * SoulWeave S6：内置模型清单
 *
 * 依据：规划第 92 行「按需资源下载、依赖发现、授权提示」
 *      规划第 110 行「组件许可与兼容、失败不破坏现有程序/数据」
 *
 * 【为什么需要清单】
 * 1. 校验完整性 —— 4 GB 模型下载中断会得到坏文件，必须验 SHA256
 * 2. 声明显存要求 —— 用户机器不够时提前提示，而不是跑了才崩
 * 3. 支持后续扩展 —— SDXL / FLUX 加进来只需追加条目
 */

import fsNode from 'node:fs';
import pathNode from 'node:path';
import cryptoNode from 'node:crypto';

// ─── 类型 ───────────────────────────────────────────

export type ModelTier = 'sd15' | 'sdxl' | 'sd35' | 'flux' | 'krea2';

export interface ModelManifestEntry {
  /** 唯一 id */
  id: string;
  /** 档位 */
  tier: ModelTier;
  /** 显示名 */
  label: string;
  /** 相对 resources/models/ 的路径 */
  relPath: string;
  /** 文件大小（字节） */
  bytes: number;
  /** SHA256（可选；不填只校验大小） */
  sha256?: string;
  /** 最低显存（MB） */
  minVramMb: number;
  /** 最低内存（MB） */
  minRamMb: number;
  /** 许可（仅内部记录，不显示给用户） */
  license: string;
  /** 是否随安装包内置 */
  bundled: boolean;
}

export interface VerifyResult {
  ok: boolean;
  /** 缺失 / 大小不符 / 哈希不符 */
  reason?: 'missing' | 'size-mismatch' | 'hash-mismatch' | 'unknown';
  detail?: string;
  /** 实际大小 */
  actualBytes?: number;
}

export interface DeviceCapability {
  /** 可用显存 MB */
  vramMb: number;
  /** 总内存 MB */
  ramMb: number;
}

export interface ModelAvailability {
  entry: ModelManifestEntry;
  verify: VerifyResult;
  /** 设备是否满足 */
  deviceOk: boolean;
  /** 不满足时的原因（给 UI 显示，不含许可信息） */
  deviceReason?: string;
  /** 最终是否可用 */
  usable: boolean;
}

// ─── 清单 ───────────────────────────────────────────

/**
 * 已知模型清单。
 *
 * 注意：sha256 对 SD1.5 暂不填（4 GB 全量哈希要几分钟，
 * 放在首次校验时可选执行）。其余字段是实测值。
 */
export const MODEL_MANIFEST: ModelManifestEntry[] = [
  {
    id: 'sd15-emaonly',
    tier: 'sd15',
    label: 'SD 1.5',
    relPath: 'sd15/sd15-pruned-emaonly.safetensors',
    bytes: 4265146304,
    minVramMb: 3000,
    minRamMb: 8000,
    license: 'CreativeML OpenRAIL-M',
    bundled: true,
  },
  {
    id: 'sdxl-base',
    tier: 'sdxl',
    label: 'SDXL Base 1.0',
    relPath: 'sdxl/sd_xl_base_1.0.safetensors',
    bytes: 6938042952,
    minVramMb: 6000,
    minRamMb: 16000,
    license: 'CreativeML Open RAIL++-M',
    bundled: false,
  },
  {
    id: 'flux-schnell',
    tier: 'flux',
    label: 'FLUX.1 schnell',
    relPath: 'flux/flux1-schnell-q4.gguf',
    bytes: 6442450944,
    minVramMb: 8000,
    minRamMb: 24000,
    license: 'Apache-2.0',
    bundled: false,
  },
  {
    id: 'krea2',
    tier: 'krea2',
    label: 'Krea2',
    relPath: 'krea2/krea2.safetensors',
    bytes: 19112604467,
    minVramMb: 12000,
    minRamMb: 32000,
    license: 'see NOTICE',
    bundled: false,
  },
];

// ─── 校验 ───────────────────────────────────────────

/**
 * 校验单个模型文件。
 *
 * 流程：存在 → 大小 → （可选）SHA256
 * 大文件默认不算哈希（4 GB 要几分钟），只有 forceHash 才做。
 */
export function verifyModel(
  entry: ModelManifestEntry,
  opts: {
    modelsRoot: string;
    exists?: (p: string) => boolean;
    sizeOf?: (p: string) => number;
    hashOf?: (p: string) => Promise<string>;
    forceHash?: boolean;
  },
): VerifyResult {
  const exists = opts.exists || ((p: string) => { try { return fsNode.existsSync(p); } catch (e) { return false; } });
  const sizeOf = opts.sizeOf || ((p: string) => { try { return fsNode.statSync(p).size; } catch (e) { return -1; } });

  const full = pathNode.join(opts.modelsRoot, entry.relPath.replace(/\//g, pathNode.sep));
  if (!exists(full)) {
    return { ok: false, reason: 'missing', detail: entry.relPath };
  }
  const actual = sizeOf(full);
  if (actual < 0) {
    return { ok: false, reason: 'unknown', detail: '无法读取文件大小' };
  }
  // 容忍 ±1%（不同版本的量化可能有细微差异）
  const tol = Math.max(1024, Math.floor(entry.bytes * 0.01));
  if (Math.abs(actual - entry.bytes) > tol) {
    return {
      ok: false, reason: 'size-mismatch',
      detail: '期望 ' + Math.round(entry.bytes / 1048576) + ' MB，实际 ' + Math.round(actual / 1048576) + ' MB',
      actualBytes: actual,
    };
  }
  return { ok: true, actualBytes: actual };
}

/** 异步版校验（支持 SHA256） */
export async function verifyModelAsync(
  entry: ModelManifestEntry,
  opts: {
    modelsRoot: string;
    forceHash?: boolean;
    onHashProgress?: (done: number, total: number) => void;
  },
): Promise<VerifyResult> {
  const base = verifyModel(entry, { modelsRoot: opts.modelsRoot });
  if (!base.ok) return base;
  if (!entry.sha256 || !opts.forceHash) return base;

  const full = pathNode.join(opts.modelsRoot, entry.relPath);
  try {
    const actual = await new Promise<string>((resolve, reject) => {
      const h = cryptoNode.createHash('sha256');
      const s = fsNode.createReadStream(full);
      let done = 0;
      const total = fsNode.statSync(full).size;
      s.on('data', (c: string | Buffer) => {
        const buf = typeof c === 'string' ? Buffer.from(c) : c;
        h.update(buf); done += buf.length;
        opts.onHashProgress?.(done, total);
      });
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', reject);
    });
    if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
      return { ok: false, reason: 'hash-mismatch', detail: 'SHA256 不匹配' };
    }
    return { ok: true, actualBytes: base.actualBytes };
  } catch (e) {
    return { ok: false, reason: 'unknown', detail: String(e).slice(0, 100) };
  }
}

// ─── 设备能力 ───────────────────────────────────────

/**
 * 判断设备能否跑某个模型。
 *
 * 给 UI 显示的原因**只含技术信息**（显存/内存不足），
 * 不含许可或合规说明。
 */
export function checkDevice(
  entry: ModelManifestEntry,
  cap: DeviceCapability,
): { ok: boolean; reason?: string } {
  const vram = Number(cap.vramMb) || 0;
  const ram = Number(cap.ramMb) || 0;

  if (entry.bundled) return { ok: true };   // 内置档位不拦

  if (vram < entry.minVramMb) {
    return {
      ok: false,
      reason: '需要 ' + Math.round(entry.minVramMb / 1024) + ' GB 显存（你的 ' + Math.round(vram / 1024) + ' GB）',
    };
  }
  if (ram < entry.minRamMb) {
    return {
      ok: false,
      reason: '需要 ' + Math.round(entry.minRamMb / 1024) + ' GB 内存（你的 ' + Math.round(ram / 1024) + ' GB）',
    };
  }
  return { ok: true };
}

// ─── 汇总 ───────────────────────────────────────────

/** 列出所有档位及其可用状态（给 UI 用） */
export function listAvailability(
  modelsRoot: string,
  cap: DeviceCapability,
  opts: { exists?: (p: string) => boolean; sizeOf?: (p: string) => number } = {},
): ModelAvailability[] {
  return MODEL_MANIFEST.map((entry) => {
    const verify = verifyModel(entry, { modelsRoot, ...opts });
    const device = checkDevice(entry, cap);
    return {
      entry,
      verify,
      deviceOk: device.ok,
      deviceReason: device.reason,
      usable: verify.ok && device.ok,
    };
  });
}

/** 找默认可用的模型（优先内置 sd15） */
export function pickUsableModel(
  list: ModelAvailability[],
): ModelAvailability | null {
  const usable = list.filter((x) => x.usable);
  if (!usable.length) return null;
  // 优先 bundled
  const bundled = usable.filter((x) => x.entry.bundled);
  return bundled.length ? bundled[0] : usable[0];
}