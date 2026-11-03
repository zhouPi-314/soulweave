/*
 * SoulWeave S6.12：硬件能力检测 + 档位推荐
 *
 * 依据：规划第 92 行「按需资源下载、依赖发现、授权提示」
 *      01 需求 7.10「CPU/RAM/GPU/显存、磁盘」
 *
 * 【为什么需要】
 * S6 的图片生成有多个档位（SD1.5 / SDXL / FLUX / Krea2），
 * 每个档位对显存和内存有硬要求。
 * 如果让用户下了 17.8 GB 的 Krea2 才发现跑不动，体验很差。
 * 所以：先检测 → 再推荐 → 用户只下能跑的。
 *
 * 【检测策略】
 *   GPU：优先 nvidia-smi（准），失败则用 wmic/PowerShell 兜底
 *   内存：os.totalmem()
 *   磁盘：statfs
 * 全部失败时返回「未知」，让上层走保守策略（只用素材包）。
 */

import osNode from 'node:os';
import fsNode from 'node:fs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import type { DeviceCapability } from './image-model-manifest.js';
import { MODEL_MANIFEST, type ModelTier } from './image-model-manifest.js';

// ─── 类型 ───────────────────────────────────────────

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  /** 显存 MB；0 = 未知 */
  vramMb: number;
  /** 是否集成显卡 */
  integrated: boolean;
}

export interface DiskInfo {
  /** 目标盘可用 GB */
  freeGb: number;
  /** 总量 GB */
  totalGb: number;
  /** 检测的路径 */
  path: string;
}

export interface SystemProfile {
  /** 平台 */
  platform: string;
  /** CPU 型号 */
  cpu: string;
  /** 核心数 */
  cpuCores: number;
  /** 总内存 MB */
  ramMb: number;
  /** 可用内存 MB（检测时快照） */
  ramFreeMb: number;
  /** 显卡列表 */
  gpus: GpuInfo[];
  /** 选中的主显卡（独显优先） */
  primaryGpu: GpuInfo | null;
  /** 磁盘 */
  disk: DiskInfo | null;
  /** 检测到的 provider 列表（nvidia-smi 等） */
  probes: string[];
  /** 检测耗时（毫秒） */
  tookMs: number;
}

export interface TierRecommendation {
  /** 推荐档位 */
  tier: ModelTier;
  /** 理由（给用户看，只含技术信息） */
  reason: string;
  /** 所有档位的可运行性 */
  tiers: Array<{
    tier: ModelTier;
    label: string;
    canRun: boolean;
    minVramMb: number;
    minRamMb: number;
    /** 不能跑的原因 */
    reason?: string;
  }>;
}

export interface DetectDeps {
  spawnSync?: typeof nodeSpawnSync;
  totalmem?: () => number;
  freemem?: () => number;
  cpus?: () => osNode.CpuInfo[];
  existsSync?: (p: string) => boolean;
  statfsSync?: (p: string) => any;
  platform?: string;
  now?: () => number;
}

function d(deps: DetectDeps) {
  return {
    spawnSync: deps.spawnSync || nodeSpawnSync,
    totalmem: deps.totalmem || (() => osNode.totalmem()),
    freemem: deps.freemem || (() => osNode.freemem()),
    cpus: deps.cpus || (() => osNode.cpus()),
    existsSync: deps.existsSync || ((p: string) => { try { return fsNode.existsSync(p); } catch (e) { return false; } }),
    statfsSync: deps.statfsSync || ((p: string) => fsNode.statfsSync(p)),
    platform: deps.platform || process.platform,
    now: deps.now || (() => Date.now()),
  };
}

// ─── NVIDIA 检测 ────────────────────────────────────

/**
 * 用 nvidia-smi 查 NVIDIA 显卡。
 *
 * 实测输出格式：
 *   NVIDIA GeForce RTX 4050 Laptop GPU, 6141, 5913
 * 字段：name, memory.total, memory.free（MiB）
 */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const parts = s.split(',').map((x) => x.trim());
    if (parts.length < 2) continue;
    const name = parts[0];
    const vram = Number(parts[1]);
    if (!name || !Number.isFinite(vram)) continue;
    out.push({
      name,
      vendor: 'nvidia',
      vramMb: Math.round(vram),
      // NVIDIA 笔记本版也是独显，不用 uma 判断
      integrated: false,
    });
  }
  return out;
}

function detectNvidia(x: ReturnType<typeof d>): GpuInfo[] {
  try {
    const r = x.spawnSync('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r && r.status === 0 && r.stdout) {
      return parseNvidiaSmi(String(r.stdout));
    }
  } catch (e) { void e; }
  return [];
}

// ─── 通用 GPU 检测（PowerShell / wmic 兜底）──────────

/**
 * 解析 PowerShell 的 Win32_VideoController 输出。
 *
 * 格式（每行一个显卡）：
 *   NVIDIA GeForce RTX 4050 Laptop GPU|6291
 *   AMD Radeon 780M Graphics|512
 */
export function parseWin32Video(stdout: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || !s.includes('|')) continue;
    const [name, vramStr] = s.split('|');
    const nm = String(name || '').trim();
    if (!nm) continue;
    const vram = Number(String(vramStr || '').trim());
    const lower = nm.toLowerCase();
    const vendor: GpuVendor = /nvidia|geforce|rtx|gtx|quadro/.test(lower) ? 'nvidia'
      : /amd|radeon|rx /.test(lower) ? 'amd'
      : /intel|arc|iris|uhd/.test(lower) ? 'intel'
      : 'unknown';
    // 名称里带 Radeon 780M / Iris / UHD 这种通常是核显
    const integrated = /radeon (\d{3}m|graphics)|iris|uhd|vega \d+ graphics|integrated/i.test(nm)
    out.push({
      name: nm,
      vendor,
      // Win32_VideoController 的 AdapterRAM 有 4 GB 上限 bug，小于 4G 才可信
      vramMb: Number.isFinite(vram) && vram > 0 && vram < 4000 ? Math.round(vram) : (integrated ? 512 : 0),
      integrated,
    });
  }
  return out;
}

function detectGeneric(x: ReturnType<typeof d>): GpuInfo[] {
  if (x.platform !== 'win32') return [];
  try {
    const ps = 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + [math]::Round($_.AdapterRAM/1MB,0) }';
    const r = x.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 12000,
    });
    if (r && r.status === 0 && r.stdout) return parseWin32Video(String(r.stdout));
  } catch (e) { void e; }
  return [];
}

// ─── 主检测 ─────────────────────────────────────────

const MB = 1048576;

export function detectProfile(deps: DetectDeps = {}): SystemProfile {
  const x = d(deps);
  const t0 = x.now();
  const probes: string[] = [];

  // GPU：nvidia-smi 优先
  let gpus = detectNvidia(x);
  if (gpus.length) probes.push('nvidia-smi');
  if (!gpus.length) {
    gpus = detectGeneric(x);
    if (gpus.length) probes.push('wmi');
  }

  // 选主显卡：独显优先，显存大的优先
  const discrete = gpus.filter((g) => !g.integrated);
  const primary = (discrete.length ? discrete : gpus).sort((a, b) => b.vramMb - a.vramMb)[0] || null;

  // CPU / 内存
  let cpus: osNode.CpuInfo[] = [];
  try { cpus = x.cpus() || []; } catch (e) { void e; }
  const cpuName = cpus.length ? String((cpus[0] as any).model || '').trim() : '';
  const ramMb = Math.round(x.totalmem() / MB);
  const ramFreeMb = Math.round(x.freemem() / MB);

  // 磁盘
  let disk: DiskInfo | null = null;
  try {
    const st: any = x.statfsSync(process.cwd());
    if (st && typeof st.bavail === 'number' && typeof st.bsize === 'number') {
      const freeGb = (st.bavail * st.bsize) / 1073741824;
      const totalGb = ((st.blocks || 0) * st.bsize) / 1073741824;
      disk = { freeGb: Math.round(freeGb * 10) / 10, totalGb: Math.round(totalGb * 10) / 10, path: process.cwd() };
      probes.push('statfs');
    }
  } catch (e) { void e; }

  return {
    platform: x.platform,
    cpu: cpuName,
    cpuCores: cpus.length,
    ramMb,
    ramFreeMb,
    gpus,
    primaryGpu: primary,
    disk,
    probes,
    tookMs: x.now() - t0,
  };
}

// ─── 转成 manifest 需要的能力对象 ────────────────────

/**
 * 把 SystemProfile 转成 DeviceCapability。
 *
 * 关键：显存取主显卡的；内存取「总内存」而不是可用内存，
 * 因为用户可能关掉别的东西腾出来，用总量判断更稳定。
 */
export function toCapability(p: SystemProfile): DeviceCapability {
  return {
    vramMb: p.primaryGpu ? p.primaryGpu.vramMb : 0,
    ramMb: p.ramMb,
  };
}

// ─── 档位推荐 ───────────────────────────────────────

/**
 * 按硬件推荐档位。
 *
 * 规则：
 *   1. 找出所有能跑的档位
 *   2. 优先推荐最高的（画质最好）
 *   3. 但 SD1.5 是内置的，如果没有独显就只用它
 *   4. 全都跑不了 → 推荐 sd15（内置，不需要设备条件）
 */
export function recommendTier(p: SystemProfile): TierRecommendation {
  const cap = toCapability(p);

  const tiers = MODEL_MANIFEST.map((e) => {
    // 内置档位不拦
    if (e.bundled) {
      return { tier: e.tier, label: e.label, canRun: true, minVramMb: e.minVramMb, minRamMb: e.minRamMb };
    }
    const vramOk = cap.vramMb >= e.minVramMb;
    const ramOk = cap.ramMb >= e.minRamMb;
    if (!vramOk) {
      return {
        tier: e.tier, label: e.label, canRun: false,
        minVramMb: e.minVramMb, minRamMb: e.minRamMb,
        reason: '需要 ' + Math.round(e.minVramMb / 1024) + ' GB 显存（你的 ' + (cap.vramMb ? Math.round(cap.vramMb / 1024) + ' GB' : '未检测到独显') + '）',
      };
    }
    if (!ramOk) {
      return {
        tier: e.tier, label: e.label, canRun: false,
        minVramMb: e.minVramMb, minRamMb: e.minRamMb,
        reason: '需要 ' + Math.round(e.minRamMb / 1024) + ' GB 内存（你的 ' + Math.round(cap.ramMb / 1024) + ' GB）',
      };
    }
    return { tier: e.tier, label: e.label, canRun: true, minVramMb: e.minVramMb, minRamMb: e.minRamMb };
  });

  // 按显存要求从高到低找第一个能跑的（非 sd15 优先，让用户用好画质）
  const runnable = tiers.filter((t) => t.canRun).sort((a, b) => b.minVramMb - a.minVramMb);
  const best = runnable[0];

  if (!best) {
    return { tier: 'sd15', reason: '未检测到可用显卡，使用内置素材包', tiers };
  }

  const gpuName = p.primaryGpu ? p.primaryGpu.name : '未检测到独显';
  const vramText = cap.vramMb ? Math.round(cap.vramMb / 1024) + ' GB' : '—';

  return {
    tier: best.tier,
    reason: gpuName + ' · ' + vramText + ' 显存 → 推荐 ' + best.label,
    tiers,
  };
}

// ─── 缓存 ───────────────────────────────────────────

export interface ProfileCache {
  profile: SystemProfile;
  at: number;
}

/** 缓存 5 分钟：硬件不会频繁变，但用户可能插拔外置显卡 */
export const PROFILE_TTL_MS = 5 * 60 * 1000;

export function makeProfileCache() {
  let cache: ProfileCache | null = null;
  return {
    get(deps: DetectDeps = {}): SystemProfile {
      const now = (deps.now || (() => Date.now()))();
      if (cache && now - cache.at < PROFILE_TTL_MS) return cache.profile;
      const profile = detectProfile(deps);
      cache = { profile, at: now };
      return profile;
    },
    clear(): void { cache = null; },
    ageMs(deps: DetectDeps = {}): number | null {
      if (!cache) return null;
      const now = (deps.now || (() => Date.now()))();
      return now - cache.at;
    },
  };
}

// ─── 摘要（给 UI 一行显示） ─────────────────────────

export function profileSummary(p: SystemProfile): string {
  const parts: string[] = [];
  if (p.primaryGpu) {
    const v = p.primaryGpu.vramMb ? Math.round(p.primaryGpu.vramMb / 1024) + 'GB' : '显存未知';
    parts.push(p.primaryGpu.name + ' ' + v);
  } else {
    parts.push('未检测到独显');
  }
  parts.push('内存 ' + Math.round(p.ramMb / 1024) + 'GB');
  if (p.disk) parts.push('磁盘可用 ' + p.disk.freeGb + 'GB');
  return parts.join(' · ');
}